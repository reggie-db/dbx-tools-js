#!/usr/bin/env bun
// Publish every non-private workspace package to npm.
//
// Design goal: the on-disk source tree is read-only during publish.
// An earlier version of this script snapshot the publishable
// `package.json` files, mutated them in place with the augmented
// "npm-ready" form (main / types / exports / files / repository /
// rewritten workspace deps), shelled out to `npm publish`, then
// restored from the snapshot in a `finally`. Any crash, Ctrl-C, or
// concurrent `git add -A` between mutate and restore left the source
// tree wedged: hardcoded cross-package versions instead of
// `workspace:*`, full publish metadata baked into the file, and a
// follow-up `bun install` would fail with
// `No version matching "X.Y.Z" found for @dbx-tools/appkit-shared`.
//
// The new flow stages each package into `<pkg>/.npm-publish/`
// (gitignored), writes the augmented `package.json` there, copies the
// files listed in `files` from the package root, runs `npm publish`
// from inside the stage, then deletes the stage. The source tree is
// never touched, so any failure is recoverable with `rm -rf
// packages/*/.npm-publish` and `bun install`.

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  discoverPackages,
  fail,
  PackageJson,
  readJson,
  ROOT,
  run,
  type WorkspacePackage,
} from "./util.js";

/**
 * Top-level `catalog` (and named `catalogs`) from the root package.json,
 * mapping bare package names to the version range every consumer should
 * use when they write `"<dep>": "catalog:"` (or `"catalog:<name>"`).
 *
 * Bun's `bun publish` rewrites these automatically; `npm publish` does
 * not. This script reads the catalog up front so it can do the rewrite
 * before staging.
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

/** Where each package's staged publish tree lives. Gitignored. */
const STAGE_DIRNAME = ".npm-publish";

/**
 * Dep keys that can carry `workspace:` or `catalog:` specifiers.
 * `devDependencies` is included because it stays in the published
 * `package.json` (even though consumers don't install it) and leaving
 * `workspace:*` there still breaks tools that strict-validate.
 */
const DEP_KEYS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/**
 * Fields grafted onto every published `package.json`. Source files on
 * disk omit these to stay minimal; this script writes them only into
 * the staged copy.
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
 * `workspace:` or `catalog:` deps to real version ranges.
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

/**
 * Return `true` when `name@version` is already on the public npm
 * registry. Lets us skip re-publishing during a re-run instead of
 * tripping over npm's `EPUBLISHCONFLICT`.
 */
function isAlreadyPublished(name: string, version: string): boolean {
  const out = run("npm", ["view", `${name}@${version}`, "version"], {
    capture: true,
    check: false,
  });
  return out === version;
}

/**
 * Stage `pkg` into `<pkg.dir>/.npm-publish`: copy every entry from
 * `files` (defaulting to `dist`, `index.ts`, `src`) and write the
 * augmented `package.json`. Returns the stage path.
 */
function stagePackage(
  pkg: WorkspacePackage,
  workspaceVersions: Map<string, string>,
): { stageDir: string; meta: PackageJson } {
  const stageDir = resolve(pkg.dir, STAGE_DIRNAME);
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  const meta = augment(pkg.meta, pkg, workspaceVersions);
  const filesList = (meta.files as string[] | undefined) ?? PUBLISH_FIELDS.files;
  for (const entry of filesList) {
    const src = resolve(pkg.dir, entry);
    if (!existsSync(src)) continue;
    cpSync(src, resolve(stageDir, entry), { recursive: true });
  }

  writeFileSync(resolve(stageDir, "package.json"), JSON.stringify(meta, null, 2) + "\n");
  return { stageDir, meta };
}

/**
 * Publish one package from its staged directory. When `dryRun` is
 * true, run `npm pack --dry-run` instead so we exercise tarball
 * assembly and print the file list without touching the registry.
 */
function publishStaged(pkg: WorkspacePackage, stageDir: string, dryRun: boolean): void {
  if (dryRun) {
    run("npm", ["pack", "--dry-run"], { cwd: stageDir });
    console.log(`✓ packed (dry-run) ${pkg.meta.name}@${pkg.meta.version}`);
    return;
  }
  // Provenance only works in CI with `id-token: write`. The workflow
  // sets `NPM_CONFIG_PROVENANCE=true` to opt in; locally we don't
  // pass it so devs can dry-run without OIDC.
  run("npm", ["publish", "--access=public"], { cwd: stageDir });
  console.log(`✓ published ${pkg.meta.name}@${pkg.meta.version}`);
}

const dryRun = process.argv.slice(2).includes("--dry-run");
const packages = discoverPackages();
console.log(
  `${dryRun ? "Dry-run packing" : "Publishing"} ${packages.length} package(s):`,
);
for (const pkg of packages) console.log(`  - ${pkg.slug}`);
console.log();

const workspaceVersions = new Map<string, string>();
for (const pkg of packages) {
  if (pkg.meta.name && pkg.meta.version) {
    workspaceVersions.set(pkg.meta.name, pkg.meta.version);
  }
}

let failures = 0;
for (const pkg of packages) {
  const { name, version } = pkg.meta;
  if (!name || !version) {
    console.log(`- skipping ${pkg.slug}: missing name or version`);
    continue;
  }
  // Skip the registry check during dry-run so devs can pack-test
  // versions that are already published.
  if (!dryRun && isAlreadyPublished(name, version)) {
    console.log(`- skipping ${name}@${version}: already on registry`);
    continue;
  }

  const { stageDir } = stagePackage(pkg, workspaceVersions);
  try {
    publishStaged(pkg, stageDir, dryRun);
  } catch (err) {
    failures++;
    console.error(`✗ publish failed for ${name}@${version}: ${(err as Error).message}`);
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

if (failures > 0) fail(`${failures} package(s) failed to publish`);
