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
import { relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGES_DIR = resolve(ROOT, "packages");
// GitHub repository slug used to populate `repository.url` /
// `repository.directory` for trusted-publisher verification and
// "View source" links on npmjs.com.
const REPO_SLUG = "reggie-db/dbx-tools-appkit";
const REPO_URL = `git+https://github.com/${REPO_SLUG}.git`;
const HOMEPAGE = `https://github.com/${REPO_SLUG}#readme`;
const BUGS_URL = `https://github.com/${REPO_SLUG}/issues`;

interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  [key: string]: unknown;
}

interface PublishablePackage {
  name: string;
  dir: string;
  jsonPath: string;
}

// Standard dep keys that can carry `workspace:` specifiers. Note we
// include `devDependencies` because they remain in the published
// `package.json` even though consumers don't install them - leaving
// `workspace:*` there still breaks any tool that strict-validates.
const DEP_KEYS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

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
  license: "Apache-2.0",
  homepage: HOMEPAGE,
  bugs: { url: BUGS_URL },
  // Force `npm publish` to upload to public npm regardless of whatever
  // registry the developer's `~/.npmrc` defaults to (e.g. a
  // read-only corporate mirror). `publishConfig` is consulted by
  // `npm publish` only; install/resolve paths still respect the
  // ambient default registry.
  publishConfig: {
    registry: "https://registry.npmjs.org/",
    access: "public",
  },
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

function resolveWorkspaceSpecifier(spec: string, targetVersion: string): string {
  // `workspace:` protocol forms (pnpm-compatible):
  //   workspace:*       -> exact target version
  //   workspace:^       -> ^<target>
  //   workspace:~       -> ~<target>
  //   workspace:<range> -> <range> verbatim (e.g. workspace:^1.2.0)
  const rest = spec.slice("workspace:".length);
  if (rest === "*" || rest === "") return targetVersion;
  if (rest === "^") return `^${targetVersion}`;
  if (rest === "~") return `~${targetVersion}`;
  return rest;
}

function rewriteWorkspaceDeps(
  meta: PackageJson,
  workspaceVersions: Map<string, string>,
): void {
  for (const key of DEP_KEYS) {
    const deps = meta[key];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, spec] of Object.entries(deps as Record<string, string>)) {
      if (typeof spec !== "string" || !spec.startsWith("workspace:")) continue;
      const targetVersion = workspaceVersions.get(name);
      if (!targetVersion) {
        throw new Error(
          `${meta.name}: ${key}["${name}"] uses ${spec} but ${name} is not a publishable workspace package`,
        );
      }
      (deps as Record<string, string>)[name] = resolveWorkspaceSpecifier(spec, targetVersion);
    }
  }
}

function augment(
  original: PackageJson,
  pkg: PublishablePackage,
  workspaceVersions: Map<string, string>,
): PackageJson {
  // Per-package `repository.directory` so the npmjs.com "View source"
  // link lands on the right subfolder. The URL itself is the same
  // monorepo for every package - that match is what trusted-publisher
  // verification compares against the actor's GitHub repo.
  const repository = {
    type: "git",
    url: REPO_URL,
    directory: relative(ROOT, pkg.dir).replace(/\\/g, "/"),
  };

  // Spread original first so any explicitly-set value in the source
  // package.json wins. This lets a single package override a field
  // (e.g. a custom `exports` map) without touching this script.
  const merged: PackageJson = {
    ...PUBLISH_FIELDS,
    repository,
    ...original,
    exports: original.exports ?? PUBLISH_FIELDS.exports,
    files: (original.files as string[] | undefined) ?? [...PUBLISH_FIELDS.files],
  };

  rewriteWorkspaceDeps(merged, workspaceVersions);
  return merged;
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
  // Build name -> version map from the snapshots so workspace:* in any
  // package resolves against the same version the dependee will ship.
  const workspaceVersions = new Map<string, string>();
  for (const pkg of packages) {
    const meta = JSON.parse(snapshots.get(pkg.jsonPath)!) as PackageJson;
    if (meta.name && meta.version) workspaceVersions.set(meta.name, meta.version);
  }

  for (const pkg of packages) {
    const original = JSON.parse(snapshots.get(pkg.jsonPath)!) as PackageJson;
    const augmented = augment(original, pkg, workspaceVersions);
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
