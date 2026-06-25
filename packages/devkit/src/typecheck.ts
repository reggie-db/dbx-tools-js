// Workspace-wide type check, run via `devkit typecheck` and as part of
// the `devkit build` gate.
//
// First syncs the root `tsconfig.json` with the workspace: walks every
// workspace package's tsconfigs (via `pkg.tsconfigs()`) and writes the
// deduped list back into the root config's `references` array,
// preserving any non-string-path entries a developer added by hand.
// Also enforces `"files": []` so the root project itself contributes no
// files - it exists purely as the solution entry point whose
// `references` enumerate the real projects.
//
// Then runs `tsc -b --noEmit` over that solution. Build mode is what
// makes the `references` actually get type-checked: a plain
// `tsc --noEmit` ignores project references entirely (the root program
// is empty, so it checks nothing), whereas `-b` walks the whole
// referenced graph - every package's `tsconfig.build.json` plus the
// demo's client/server projects - and `--noEmit` keeps it a pure check
// with no compiled output. Idempotent.

import { applyEdits, modify, parse } from "jsonc-parser";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { discoverPackages, toAbsolute, toRelative } from "./package.js";
import { sh } from "./shell.js";

const FORMAT = { insertSpaces: true, tabSize: 2 } as const;

/** Sync the root tsconfig `references` to the live package set, then `tsc -b --noEmit`. */
export async function typecheck(): Promise<void> {
  const rootTsconfigPath = toAbsolute("tsconfig.json");
  const original = await Bun.file(rootTsconfigPath).text();
  const parsed = parse(original) as {
    references?: ReadonlyArray<{ path?: unknown } | unknown>;
  };

  // Preserve any hand-added non-string-path entries (rare, but possible
  // if a developer set `prepend` or other reference flags), then union
  // with auto-discovered tsconfigs.
  const nonPathRefs: unknown[] = [];
  const refPaths = new Set<string>();
  for (const ref of parsed.references ?? []) {
    if (typeof ref === "object" && ref !== null && "path" in ref) {
      if (typeof ref.path === "string") {
        const refPath = toAbsolute(ref.path);
        if (existsSync(refPath)) {
          refPaths.add(refPath);
        }
        continue;
      }
    }
    nonPathRefs.push(ref);
  }

  for (const pkg of await discoverPackages()) {
    for await (const tsconfig of pkg.tsconfigs()) {
      refPaths.add(tsconfig);
    }
  }

  const references = [
    ...nonPathRefs,
    ...[...refPaths].sort().map((abs) => {
      const rel = toRelative(abs);
      return { path: isAbsolute(rel) ? rel : `./${rel}` };
    }),
  ];

  let updated = applyEdits(
    original,
    modify(original, ["references"], references, { formattingOptions: FORMAT }),
  );
  updated = applyEdits(
    updated,
    modify(updated, ["files"], [], { formattingOptions: FORMAT }),
  );
  await Bun.write(rootTsconfigPath, updated);

  await sh(["bun", "x", "--bun", "tsc", "-b", "--noEmit"]);
}
