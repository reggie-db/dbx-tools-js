#!/usr/bin/env bun
// Build every publishable workspace package by running
// `tsc -p tsconfig.build.json` inside each one.
//
// The root `tsconfig.build.json` is configured to include each
// package's root `index.ts` plus its `src/` directory, emitting `.js`
// and `.d.ts` files into `packages/<pkg>/dist/`.
//
// Packages without a `tsconfig.build.json` or marked `"private": true`
// are skipped: private packages (e.g. the demo) aren't shipped to npm
// and have their own build pipelines.

import { rmSync } from "node:fs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { bunx, discoverPackages, fail } from "./util.js";

const packages = await discoverPackages(
  (pkg) =>
    pkg.meta.private !== true && existsSync(resolve(pkg.dir, "tsconfig.build.json")),
);

console.log(`Building ${packages.length} package(s):`);
for (const pkg of packages) console.log(`  - ${pkg.slug}`);
console.log();

for (const pkg of packages) {
  console.log(`=== Building ${pkg.slug} ===`);
  // Wipe the previous dist/ so stale artifacts from deleted source
  // files can't slip into the published tarball.
  rmSync(resolve(pkg.dir, "dist"), { recursive: true, force: true });
  try {
    bunx(["tsc", "-p", "tsconfig.build.json"], { cwd: pkg.dir });
    console.log(`Built: ${pkg.slug}\n`);
  } catch {
    fail(`Build failed: ${pkg.slug}`);
  }
}

console.log(`Built all ${packages.length} package(s).`);
