// Single shared bundler config for every publishable workspace package.
//
// Each package's `build` script runs `tsdown --config ../../tsdown.config.ts`,
// fanned out (in workspace dependency order) by the root `build` script via
// `bun run --filter`. tsdown runs with the package directory as its cwd, so
// this config reads that package's own `package.json` and derives what to
// build from it - there is no per-package bundler config.
//
// Entry points come from the package's `exports` map. A `.ts` entry is any
// source file that is either nested under a `source` condition (the full
// conditional shape used by the browser/server and `-ui` packages) or the
// direct value of a subpath key (the one-line `{ ".": "./src/index.ts" }`
// pointer most packages ship - the same string Node, tsc, and Vite resolve
// at dev time, so build inputs and the dev module graph never drift). The
// publish step later expands that one-liner into the full
// `source`/`types`/`default` map. Packages that only set `module` fall back
// to that. A package `bin` whose target lives in `dist/` adds the matching
// source file as an entry too.
//
// Output goes to `<pkg>/dist` as ESM JS + bundled `.d.ts`. Only the
// package's own source is bundled; every bare import (workspace `@dbx-tools/*`
// siblings, third-party deps, and `node:*` builtins alike) is externalized so
// it resolves at install time instead of being inlined. We can't lean on
// tsdown's default dependency externalization here because the shared config
// is loaded via `--config ../../tsdown.config.ts`, so tsdown reads the repo
// root's `package.json` for that default rather than the package being built;
// the explicit `external` predicate below keys off the build cwd instead.
// Without it, third-party code is bundled into the JS and external type trees
// are inlined into the `.d.ts` until the declaration bundler's parser breaks.
// Type emit uses the repo-root `tsconfig.base.json`.

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

const repoRoot = dirname(fileURLToPath(import.meta.url));
const pkgDir = process.cwd();

interface PackageJson {
  module?: string;
  exports?: unknown;
  bin?: string | Record<string, string>;
}

const pkg = JSON.parse(
  readFileSync(resolve(pkgDir, "package.json"), "utf8"),
) as PackageJson;

const TS_EXT = /\.[cm]?tsx?$/;

/** tsdown entry key for a source file: drop `./`, then either `src/` or just the extension. */
function entryKey(source: string): string {
  const normalized = source.replace(/^\.\//, "");
  if (normalized.startsWith("src/")) {
    return normalized.replace(/^src\//, "").replace(TS_EXT, "");
  }
  return normalized.replace(TS_EXT, "");
}

/**
 * Collect every `.ts` source entry from an `exports` map. A string counts
 * when it is nested under a `source` condition or is the direct value of a
 * subpath key (the `{ ".": "./src/index.ts" }` one-liner); `.js`/`.css`
 * targets and dist declarations are ignored.
 */
function collectSourceEntries(
  node: unknown,
  underSource: boolean,
  subpathValue: boolean,
  out: Set<string>,
): void {
  if (typeof node === "string") {
    if ((underSource || subpathValue) && TS_EXT.test(node)) out.add(node);
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      collectSourceEntries(
        value,
        underSource || key === "source",
        key.startsWith("."),
        out,
      );
    }
  }
}

const entry: Record<string, string> = {};

const sources = new Set<string>();
collectSourceEntries(pkg.exports, false, false, sources);
if (sources.size === 0 && pkg.module) sources.add(pkg.module);
for (const source of sources) {
  entry[entryKey(source)] = resolve(pkgDir, source);
}

// Non-TS asset exports (e.g. `"./styles.css": "./src/styles.css"`) aren't
// build inputs - tsdown only compiles the `.ts` entries above - but they
// still have to land in `dist` so the published, `dist`-only tarball can
// resolve them. Collect every `exports` string that points under `src/`
// and isn't a `.ts`/`.tsx`, and copy it into the matching `dist` location
// (the publish step rewrites the export's `src/` path to `dist/` to match).
const copyAssets: { from: string; to: string }[] = [];
function collectAssets(node: unknown): void {
  if (typeof node === "string") {
    if (!TS_EXT.test(node) && node.startsWith("./src/")) {
      // Absolute, like the entries/outDir: tsdown resolves a relative copy
      // `from`/`to` against the shared config's dir (repo root), not the
      // package build cwd, so spell both out against `pkgDir`.
      const from = resolve(pkgDir, node.replace(/^\.\//, ""));
      const to = resolve(pkgDir, dirname(node.replace(/^\.\/src\//, "dist/")));
      copyAssets.push({ from, to });
    }
    return;
  }
  if (node && typeof node === "object") {
    for (const value of Object.values(node)) collectAssets(value);
  }
}
collectAssets(pkg.exports);

// A `bin` target like `dist/cli.js` ships built JS, so find the source that
// emits to it (`src/cli.ts`, `cli.ts`, ...) and build that too.
const bins = typeof pkg.bin === "string" ? { default: pkg.bin } : (pkg.bin ?? {});
for (const target of Object.values(bins)) {
  const key = target
    .replace(/^\.\//, "")
    .replace(/^dist\//, "")
    .replace(/\.js$/, "");
  for (const candidate of [
    `${key}.ts`,
    `${key}.tsx`,
    `src/${key}.ts`,
    `src/${key}.tsx`,
  ]) {
    if (existsSync(resolve(pkgDir, candidate))) {
      entry[key] = resolve(pkgDir, candidate);
      break;
    }
  }
}

if (Object.keys(entry).length === 0) {
  throw new Error(`tsdown: no build entries found for ${pkgDir}`);
}

export default defineConfig({
  entry,
  format: "esm",
  dts: true,
  // Force `.js` / `.d.ts` (not `.mjs` / `.d.mts`). tsdown picks the extension
  // from the package's `type` field, but the shared config is loaded from the
  // repo root so it can't see this package's `type: "module"` and would fall
  // back to `.mjs`. Every package here is ESM, and the published `exports` /
  // `main` / `types` reference `./dist/index.js` + `./dist/index.d.ts`.
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
  // Absolute, like the entries: tsdown resolves relative paths against this
  // shared config's directory (the repo root), not the build cwd, so a bare
  // "dist" would dump every package's output into `<root>/dist`.
  outDir: resolve(pkgDir, "dist"),
  clean: true,
  // Copy non-TS asset exports (CSS, ...) into `dist` after the bundle, so
  // the `dist`-only tarball can resolve them. Empty for most packages.
  copy: copyAssets.length > 0 ? copyAssets : undefined,
  // Bundle only this package's own source: anything that isn't a relative or
  // absolute path (i.e. every bare specifier) stays external. Covers
  // `@dbx-tools/*` siblings, third-party deps, and `node:*` builtins.
  external: (id) => !id.startsWith(".") && !isAbsolute(id),
  tsconfig: resolve(repoRoot, "tsconfig.base.json"),
});
