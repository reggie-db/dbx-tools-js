#!/usr/bin/env bun
// Workspace formatter. Two passes, run from the monorepo root via
// `bun run format`:
//
//   1. `syncpack format` normalizes every `package.json` in the
//      workspace (key order, sorted dependency ranges, etc.).
//   2. `prettier --write` reflows the TypeScript sources. With
//      `prettier-plugin-organize-imports` enabled (see
//      prettier.config.js) this pass also drops unused imports and
//      sorts the rest. Only the files prettier actually rewrites are
//      printed - its per-file "(unchanged)" noise is filtered out.
//
// The prettier target list is derived from the workspace package
// finder rather than a hand-maintained glob, so a newly created
// package is picked up automatically. The non-workspace `scripts/`
// directory (where this file lives) is appended explicitly.

import { bunx, discoverPackages } from "./util.js";

/** Non-workspace directories that also hold first-party TypeScript. */
const EXTRA_DIRS = ["scripts"];

/**
 * Build the single brace-glob prettier walks - a recursive
 * `.ts`/`.tsx` match rooted at each discovered package dir plus the
 * extras (e.g. `packages/shared`, `demo`, `scripts`). One combined
 * pattern avoids prettier's per-pattern "no matching files" error
 * when an individual package happens to ship no `.tsx`. `() => true`
 * keeps private workspaces (the demo) that the default filter drops.
 */
async function sourceGlob(): Promise<string> {
  const packages = await discoverPackages(() => true);
  const dirs = [...packages.map((pkg) => pkg.slug), ...EXTRA_DIRS];
  return `{${dirs.join(",")}}/**/*.{ts,tsx}`;
}

// Pass 1: package.json hygiene.
await bunx(["syncpack", "format"], { stdout: "inherit", stderr: "inherit" });

// Pass 2: prettier over every workspace package + scripts/. Capture
// stdout (where prettier lists every visited file) so we can drop its
// noisy "<file> (unchanged)" lines and report only the files it
// actually rewrote. stderr (warnings / parse errors) still streams
// through, and a non-zero exit still throws.
const log = await bunx(["prettier", "--write", await sourceGlob()], {
  stderr: "inherit",
});
const changed = log
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.endsWith("(unchanged)"));
console.log(changed.length > 0 ? changed.join("\n") : "No files reformatted.");
