#!/usr/bin/env bun
// Publish every non-private workspace package to npm via
// `bunx changeset publish`.
//
// Packages on disk keep a minimal shape (just `name`, `version`,
// `module`, `type`, dependencies). For the published tarball we want
// the full npm convention - `main`, `types`, `exports`, `files` - so
// consumers on raw Node, bundlers, and bun-with-source-conditions all
// resolve correctly.
//
// To avoid duplicating that metadata in every on-disk `package.json`,
// this script:
//   1. Snapshots each publishable `package.json`'s text content.
//   2. Mutates each file in place with the augmented npm-ready form
//      (adds main / types / exports / files; preserves anything that
//      was already there; rewrites `workspace:*` deps to real versions
//      since `npm publish` doesn't do that automatically).
//   3. Runs `bunx changeset publish` which walks each package and
//      invokes `npm publish`, reading the augmented `package.json` so
//      the published tarball ships the correct fields.
//   4. Restores the original `package.json` content in a `finally`
//      block whether publish succeeded, failed, or threw.
//
// If the script is killed mid-flight (Ctrl+C, machine reboot), recover
// with `git checkout -- packages/*/package.json`.

import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  bunx,
  discoverPackages,
  fail,
  PackageJson,
  readJson,
  ROOT,
  type WorkspacePackage,
} from "./util.js";

/**
 * Top-level `catalog` (and named `catalogs`) from the root package.json,
 * mapping bare package names to the version range every consumer should
 * use when they write `"<dep>": "catalog:"` (or `"catalog:<name>"`).
 *
 * Bun's `bun publish` rewrites these automatically; `npm publish` does
 * not. This script reads the catalog up front so it can do the rewrite
 * before `bunx changeset publish` shells out to npm.
 */
interface RootPackageJson extends PackageJson {
  catalog?: Record<string, string>;
  catalogs?: Record<string, Record<string, string>>;
}

const rootMeta = readJson<RootPackageJson>(resolve(ROOT, "package.json"));
const DEFAULT_CATALOG = rootMeta.catalog ?? {};
const NAMED_CATALOGS = rootMeta.catalogs ?? {};

/**
 * GitHub repository slug used to populate `repository.url` /
 * `repository.directory` for trusted-publisher verification and
 * "View source" links on npmjs.com.
 */
const REPO_SLUG = "reggie-db/dbx-tools-appkit";
const REPO_URL = `git+https://github.com/${REPO_SLUG}.git`;
const HOMEPAGE = `https://github.com/${REPO_SLUG}#readme`;
const BUGS_URL = `https://github.com/${REPO_SLUG}/issues`;

/**
 * Dep keys that can carry `workspace:` specifiers. `devDependencies`
 * is included because it remains in the published `package.json`
 * (even though consumers don't install it) - leaving `workspace:*`
 * there still breaks tools that strict-validate.
 */
const DEP_KEYS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/**
 * Fields added to every published `package.json`. The source files on
 * disk omit these to stay minimal; this script grafts them on right
 * before `npm publish` runs.
 */
const PUBLISH_FIELDS = {
  main: "dist/index.js",
  types: "dist/index.d.ts",
  exports: {
    ".": {
      // `source` lets dev consumers opt into TS source via
      // `--conditions=source` (e.g. tsx, vite dev). Anyone else gets
      // the compiled `default` entry.
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
  // registry the developer's `~/.npmrc` defaults to (e.g. a read-only
  // corporate mirror). `publishConfig` is consulted by `npm publish`
  // only; install/resolve paths still respect the ambient registry.
  publishConfig: {
    registry: "https://registry.npmjs.org/",
    access: "public",
  },
} as const;

/**
 * Rewrite a single `workspace:` specifier into the equivalent semver
 * range. Matches pnpm/bun conventions:
 *
 *   workspace:*       -> exact target version
 *   workspace:^       -> ^<target>
 *   workspace:~       -> ~<target>
 *   workspace:<range> -> <range> verbatim (e.g. workspace:^1.2.0)
 */
function resolveWorkspaceSpecifier(spec: string, targetVersion: string): string {
  const rest = spec.slice("workspace:".length);
  if (rest === "*" || rest === "") return targetVersion;
  if (rest === "^") return `^${targetVersion}`;
  if (rest === "~") return `~${targetVersion}`;
  return rest;
}

/**
 * Rewrite a single `catalog:` specifier into the version range stored
 * under the matching key in the root package.json's `catalog` (default,
 * unnamed) or `catalogs[<name>]` (named).
 *
 *   catalog:        -> rootMeta.catalog[<dep-name>]
 *   catalog:<name>  -> rootMeta.catalogs[<name>][<dep-name>]
 */
function resolveCatalogSpecifier(name: string, spec: string): string {
  const catalogName = spec.slice("catalog:".length);
  const catalog = catalogName === "" ? DEFAULT_CATALOG : NAMED_CATALOGS[catalogName];
  if (!catalog) {
    throw new Error(`Unknown catalog "${catalogName || "(default)"}" referenced by ${name}`);
  }
  const range = catalog[name];
  if (!range) {
    throw new Error(`Dep ${name} not found in catalog "${catalogName || "(default)"}"`);
  }
  return range;
}

/**
 * Walk every dep map on `meta` and replace any `workspace:` or
 * `catalog:` specifier with a real version range. Throws if a
 * workspace dep points at a package not in the publish set, or if a
 * catalog reference can't be resolved.
 */
function rewriteSpecialDeps(meta: PackageJson, workspaceVersions: Map<string, string>): void {
  for (const key of DEP_KEYS) {
    const deps = meta[key];
    if (!deps || typeof deps !== "object") continue;
    const depsMap = deps as Record<string, string>;
    for (const [name, spec] of Object.entries(depsMap)) {
      if (typeof spec !== "string") continue;
      if (spec.startsWith("workspace:")) {
        const targetVersion = workspaceVersions.get(name);
        if (!targetVersion) {
          throw new Error(
            `${meta.name}: ${key}["${name}"] uses ${spec} but ${name} is not a publishable workspace package`,
          );
        }
        depsMap[name] = resolveWorkspaceSpecifier(spec, targetVersion);
      } else if (spec.startsWith("catalog:")) {
        depsMap[name] = resolveCatalogSpecifier(name, spec);
      }
    }
  }
}

/**
 * Merge `PUBLISH_FIELDS` + per-package `repository` into `original`,
 * letting `original`'s explicit fields win, then rewrite any
 * `workspace:` deps to real version ranges.
 */
function augment(
  original: PackageJson,
  pkg: WorkspacePackage,
  workspaceVersions: Map<string, string>,
): PackageJson {
  // Per-package `repository.directory` lets the npmjs.com "View
  // source" link land on the right subfolder. The URL itself is the
  // same monorepo for every package - that match is what trusted-
  // publisher verification compares against the actor's GitHub repo.
  const repository = {
    type: "git",
    url: REPO_URL,
    directory: relative(ROOT, pkg.dir).replace(/\\/g, "/"),
  };

  const merged: PackageJson = {
    ...PUBLISH_FIELDS,
    repository,
    ...original,
    exports: original.exports ?? PUBLISH_FIELDS.exports,
    files: (original.files as string[] | undefined) ?? [...PUBLISH_FIELDS.files],
  };

  rewriteSpecialDeps(merged, workspaceVersions);
  return merged;
}

const packages = discoverPackages();
console.log(`Publishing ${packages.length} package(s):`);
for (const pkg of packages) console.log(`  - ${pkg.slug}`);
console.log();

const snapshots = new Map<string, string>();

function snapshot(): void {
  for (const pkg of packages) snapshots.set(pkg.jsonPath, readFileSync(pkg.jsonPath, "utf8"));
}

function applyAugmentation(): void {
  // Build name -> version map from snapshots so workspace:* in any
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
  try {
    bunx(["changeset", "publish"]);
  } catch {
    exitCode = 1;
  }
} finally {
  restore();
}

if (exitCode !== 0) fail(`changeset publish failed (exit ${exitCode})`);
