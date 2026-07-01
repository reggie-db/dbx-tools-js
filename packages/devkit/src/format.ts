// Workspace formatter, run via `devkit format`:
//
//   - `syncpack format` normalizes every `package.json` in the
//     workspace (key order, sorted dependency ranges, etc.).
//   - A regroup step then pulls each `pre`/`post` npm lifecycle hook
//     back against its base script (syncpack alphabetizes them apart).
//   - `prettier --write` reflows the TypeScript sources. With
//     `prettier-plugin-organize-imports` enabled (see the consuming
//     repo's prettier config) it also drops unused imports and sorts
//     the rest. Only the files prettier actually rewrites are printed -
//     its per-file "(unchanged)" noise is filtered out.
//
// The prettier target list is derived from the workspace package
// finder rather than a hand-maintained glob, so a newly created
// package is picked up automatically.

import { consola } from "consola";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import {
  discoverPackageJsons,
  discoverPackages,
  type PackageJson,
  toRelative,
  writeJson,
} from "./package.js";
import { bunx, sh } from "./shell.js";

// Resolve against devkit's *own* install location (this module), so
// `prettier` and its plugin always come from devkit's pinned deps -
// not from a `bun x` temp download, where bare specifiers can't be
// found. `import.meta.url` survives bundling and points at the shipped
// dist file inside the consuming repo's node_modules.
const require = createRequire(import.meta.url);

/** Absolute path to a dependency's binary, read from its own `package.json`. */
function resolveBin(pkg: string, binName: string): string {
  const pkgJsonPath = require.resolve(`${pkg}/package.json`);
  const meta = require(`${pkg}/package.json`) as {
    bin?: string | Record<string, string>;
  };
  const bin = typeof meta.bin === "string" ? meta.bin : meta.bin?.[binName];
  if (!bin) throw new Error(`${pkg} declares no "${binName}" bin`);
  return resolve(dirname(pkgJsonPath), bin);
}

/**
 * Build the single glob prettier walks - a recursive `.ts`/`.tsx` match
 * rooted at each discovered package dir. One combined pattern avoids
 * prettier's per-pattern "no matching files" error when an individual
 * package happens to ship no `.tsx`. A brace alternation is only used
 * for two-plus dirs: a single-element `{dir}` brace with a slash inside
 * is left un-expanded by prettier's matcher, so the lone dir is emitted
 * bare. Returns `null` when no packages were discovered (so the caller
 * can skip prettier entirely). `() => true` keeps private workspaces
 * (e.g. a demo) that the default filter drops.
 */
async function sourceGlob(): Promise<string | null> {
  const packages = await discoverPackages(() => true);
  const dirs = packages.map((pkg) => pkg.slug);
  if (dirs.length === 0) return null;
  const roots = dirs.length === 1 ? dirs[0] : `{${dirs.join(",")}}`;
  return `${roots}/**/*.{ts,tsx}`;
}

/**
 * Reorder a `scripts` map so npm's lifecycle hooks sit next to their
 * base: `pre<x>` immediately before `<x>` and `post<x>` immediately
 * after. Groups are ordered by base name; the base script need not
 * exist (a lone `prebuild`/`postbuild` still sorts into the `build`
 * slot). The `pre`/`post` prefix is stripped purely by name - the same
 * heuristic npm uses.
 */
function reorderLifecycleScripts(
  scripts: Record<string, string>,
): Record<string, string> {
  const baseOf = (key: string): string => {
    const match = /^(?:pre|post)(.+)$/.exec(key);
    return match ? match[1]! : key;
  };
  const bases = [...new Set(Object.keys(scripts).map(baseOf))].sort();
  const ordered: Record<string, string> = {};
  for (const base of bases) {
    for (const name of [`pre${base}`, base, `post${base}`]) {
      if (name in scripts) ordered[name] = scripts[name]!;
    }
  }
  return ordered;
}

/** syncpack + lifecycle-hook regroup + prettier across the workspace. */
export async function format(): Promise<void> {
  // package.json hygiene.
  await bunx(["syncpack", "format"]);

  // Regroup npm lifecycle hooks. syncpack just alpha-sorted every
  // `scripts` block, which separates `pre`/`post` hooks from their base
  // (e.g. `pretypecheck` lands far from `typecheck`); pull each hook
  // back against its base. Walks every workspace package.json (root
  // included) and rewrites only those whose script order changed.
  const regrouped: string[] = [];
  for await (const jsonPath of discoverPackageJsons(true)) {
    const meta = (await Bun.file(jsonPath).json()) as PackageJson;
    const scripts = meta.scripts as Record<string, string> | undefined;
    if (!scripts || Object.keys(scripts).length === 0) continue;
    const ordered = reorderLifecycleScripts(scripts);
    if (JSON.stringify(Object.keys(ordered)) === JSON.stringify(Object.keys(scripts))) {
      continue;
    }
    meta.scripts = ordered;
    await writeJson(jsonPath, meta);
    regrouped.push(toRelative(jsonPath));
  }
  consola.log(
    regrouped.length > 0
      ? `Regrouped lifecycle scripts in:\n${regrouped.join("\n")}`
      : "No lifecycle scripts to regroup.",
  );

  // prettier over every workspace package, run from devkit's pinned
  // prettier with the organize-imports plugin supplied by absolute path
  // (the root config carries options only; the plugin is injected here
  // so it resolves no matter where the package manager installed it).
  // Both binary and plugin are resolved from devkit's own install rather
  // than via `bun x`, which would fetch a throwaway prettier into a temp
  // dir that can't see the plugin. Capture stdout (where prettier lists
  // every visited file) so we can drop its noisy "<file> (unchanged)"
  // lines and report only the files it actually rewrote. A non-zero exit
  // still throws.
  const sources = await sourceGlob();
  if (!sources) {
    consola.log("No packages to format.");
    return;
  }
  const prettierBin = resolveBin("prettier", "prettier");
  const pluginPath = require.resolve("prettier-plugin-organize-imports");
  const { stdout } = await sh(
    ["bun", prettierBin, "--write", `--plugin=${pluginPath}`, sources],
    { quiet: true },
  );
  const changed = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.endsWith("(unchanged)"));
  consola.log(changed.length > 0 ? changed.join("\n") : "No files reformatted.");
}
