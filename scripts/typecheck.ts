#!/usr/bin/env bun
// Workspace-wide type check, run via `bun run typecheck` and as part of
// the `bun run build` gate.
//
// First syncs the root `tsconfig.json` with the workspace: walks every
// workspace package's tsconfigs (via `pkg.tsconfigs()`) and writes the
// deduped list back into the root config's `references` array,
// preserving any non-string-path entries a developer added by hand.
// Also enforces `"files": []` so a bare `tsc --noEmit` at the repo root
// doesn't auto-glob the whole tree (which produces TS6305 once any
// referenced project sets `composite: true`, and bogus errors against
// demo client files that need the demo's `lib`/`paths`).
//
// Then runs `tsc --noEmit` over the synced project. Idempotent.

import { applyEdits, modify, parse } from "jsonc-parser";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { discoverPackages, toAbsolute, toRelative } from "./package.js";
import { sh } from "./shell.js";

const FORMAT = { insertSpaces: true, tabSize: 2 } as const;

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
  if (typeof ref === "object" && "path" in ref) {
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

await sh(["bun", "x", "--bun", "tsc", "--noEmit"]);
