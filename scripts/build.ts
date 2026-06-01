#!/usr/bin/env bun
// Build every publishable workspace package by running `tsc -p
// tsconfig.build.json` inside it. The root tsconfig.build.json is
// configured to include each package's root `index.ts` plus its `src/`
// dir, emitting `.js` + `.d.ts` files into `packages/<pkg>/dist/`.
//
// Private packages (e.g. the demo) are skipped because they're not
// shipped to npm and have their own build pipelines (vite + tsdown).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGES_DIR = resolve(ROOT, "packages");

interface PackageJson {
  name?: string;
  private?: boolean;
}

interface BuildablePackage {
  name: string;
  dir: string;
}

function discoverPackages(): BuildablePackage[] {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, dir: resolve(PACKAGES_DIR, entry.name) }))
    .filter((pkg) => {
      const pkgJson = resolve(pkg.dir, "package.json");
      const buildConfig = resolve(pkg.dir, "tsconfig.build.json");
      if (!existsSync(pkgJson) || !existsSync(buildConfig)) return false;
      const meta = JSON.parse(readFileSync(pkgJson, "utf8")) as PackageJson;
      return meta.private !== true;
    });
}

const packages = discoverPackages();
console.log(`Building ${packages.length} package(s):`);
for (const pkg of packages) console.log(`  - ${pkg.name}`);
console.log();

for (const pkg of packages) {
  console.log(`=== Building ${pkg.name} ===`);
  // Wipe the previous dist/ so stale artifacts can't slip into the
  // published tarball if a source file was deleted between builds.
  rmSync(resolve(pkg.dir, "dist"), { recursive: true, force: true });

  const result = spawnSync(
    process.platform === "win32" ? "bunx.cmd" : "bunx",
    ["tsc", "-p", "tsconfig.build.json"],
    { cwd: pkg.dir, stdio: "inherit" },
  );

  if (result.status !== 0) {
    console.error(`\nBuild failed: ${pkg.name}`);
    process.exit(result.status ?? 1);
  }

  console.log(`Built: ${pkg.name}\n`);
}

console.log(`Built all ${packages.length} package(s).`);
