#!/usr/bin/env bun
// Publish every non-private workspace package to npm via
// `bunx changeset publish`.
//
// Packages on disk keep the minimal shape the workspace has settled on
// (just `name`, `version`, `module`, `type`, dependencies). For the
// published tarball we want the full npm convention - `main`, `types`,
// `exports`, `files` - so consumers on raw Node, every bundler, and
// bun-with-source-conditions all resolve correctly.
//
// To avoid duplicating that metadata in every package.json on disk,
// this script:
//   1. Snapshots each publishable package.json's text content.
//   2. Mutates each file in place with the augmented npm-ready form
//      (adds main / types / exports / files; preserves everything
//      that was already there).
//   3. Runs `bunx changeset publish` which walks each package and
//      invokes `npm publish`, reading the augmented package.json at
//      that moment so the published tarball ships the correct fields.
//   4. Restores the original package.json content in a `finally` block,
//      regardless of whether publish succeeded or threw.
//
// If the script is killed mid-flight (Ctrl+C, machine reboot), recovery
// is `git checkout -- packages/*/package.json`.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGES_DIR = resolve(ROOT, "packages");

interface PackageJson {
  name?: string;
  private?: boolean;
  [key: string]: unknown;
}

interface PublishablePackage {
  name: string;
  dir: string;
  jsonPath: string;
}

const PUBLISH_FIELDS = {
  main: "dist/index.js",
  types: "dist/index.d.ts",
  exports: {
    ".": {
      // `source` lets dev consumers opt into the TS source via
      // `--conditions=source` (e.g. tsx, vite dev mode). Anyone else
      // gets the compiled `default` entry.
      source: "./index.ts",
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    },
  },
  files: ["dist", "index.ts", "src"],
} as const;

function discoverPackages(): PublishablePackage[] {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = resolve(PACKAGES_DIR, entry.name);
      return { name: entry.name, dir, jsonPath: resolve(dir, "package.json") };
    })
    .filter((pkg) => {
      if (!existsSync(pkg.jsonPath)) return false;
      const meta = JSON.parse(readFileSync(pkg.jsonPath, "utf8")) as PackageJson;
      return meta.private !== true;
    });
}

function augment(original: PackageJson): PackageJson {
  // Spread original first so any explicitly-set value in the source
  // package.json wins. This lets a single package override a field
  // (e.g. a custom `exports` map) without touching this script.
  return {
    ...PUBLISH_FIELDS,
    ...original,
    exports: original.exports ?? PUBLISH_FIELDS.exports,
    files: (original.files as string[] | undefined) ?? [...PUBLISH_FIELDS.files],
  };
}

const packages = discoverPackages();
console.log(`Publishing ${packages.length} package(s):`);
for (const pkg of packages) console.log(`  - ${pkg.name}`);
console.log();

const snapshots = new Map<string, string>();

function snapshot(): void {
  for (const pkg of packages) {
    snapshots.set(pkg.jsonPath, readFileSync(pkg.jsonPath, "utf8"));
  }
}

function applyAugmentation(): void {
  for (const pkg of packages) {
    const original = JSON.parse(snapshots.get(pkg.jsonPath)!) as PackageJson;
    const augmented = augment(original);
    writeFileSync(pkg.jsonPath, JSON.stringify(augmented, null, 2) + "\n");
  }
}

function restore(): void {
  for (const [path, content] of snapshots) {
    try {
      writeFileSync(path, content);
    } catch (err) {
      console.error(`Failed to restore ${path}: ${(err as Error).message}`);
    }
  }
}

let exitCode = 0;
try {
  snapshot();
  applyAugmentation();

  const result = spawnSync(
    process.platform === "win32" ? "bunx.cmd" : "bunx",
    ["changeset", "publish"],
    { cwd: ROOT, stdio: "inherit" },
  );

  exitCode = result.status ?? 1;
} finally {
  restore();
}

process.exit(exitCode);
