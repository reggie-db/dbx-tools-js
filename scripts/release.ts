#!/usr/bin/env bun
// Publish every non-private workspace package to npm.
//
// On-disk `packages/*/package.json` files are kept to the absolute
// minimum needed for dev tooling (name / version / type / module /
// deps, plus per-package custom fields like `@dbx-tools/appkit-shared`'s
// dual-entry `exports` map). The publish-time shape - license, repo,
// files, publishConfig, the standard single-entry exports map, and so
// on - is split between two root-level files:
//
//   - `package.default.json`   fills in fields the package didn't
//                               define (low-priority template).
//   - `package.enforced.json`  forces fields on top of everything
//                               (org-wide constants).
//
// Why a stage directory instead of mutating `package.json` in place:
// `bun publish` (and npm publish) only ever read `package.json` from
// the cwd - there's no `--manifest <path>` flag - so we can't just
// hand it a `package.generated.json`. Mutating the source file in
// place during publish would briefly dirty the working tree (a
// SIGKILL between mutate and revert leaves the source modified). To
// keep `git status` clean throughout, we stage each package into
// `<pkg>/.publish/` (gitignored), copy the publishable files in, and
// run `bun publish` from inside the stage. The stage's `package.json`
// is the "generated" file the user asked for; it's just at
// `.publish/package.json` instead of `package.generated.json`,
// because that's what bun is willing to read.
//
// One catch: a stage dir isn't a workspace member, so `bun publish`
// inside it can't rewrite `workspace:*` and `catalog:` specifiers on
// our behalf. We pre-resolve those in `mergeForRelease()` from the
// workspace's own version map and the root manifest's `catalog`/
// `catalogs` fields before writing the staged manifest.
//
// Dry runs use `bun pm pack --dry-run` because `bun publish
// --dry-run` still requires npm auth today.
//
// Local-registry shortcut: when `--registry` points at a loopback
// host (Verdaccio in docker, the default), we drop a stage-local
// `bunfig.toml` carrying a placeholder token under
// `[install.scopes]`. `bun publish` refuses to upload without an
// auth token configured, but Verdaccio is set to `publish: $$all`
// and accepts any token. Result: local publishes work with zero
// `bun login` and the user's real `~/.npmrc` (with real registry
// tokens) is never touched. We use `bunfig.toml` rather than
// `.npmrc` because bun reads `bunfig.toml` from cwd; its `.npmrc`
// resolution stops higher up the tree and doesn't pick up a
// stage-local file.

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { Command, Option } from "commander";
import {
  discoverPackages,
  fail,
  ROOT,
  run,
  writeJson,
  type PackageJson,
  type WorkspacePackage,
} from "./util.js";

/**
 * Default registry. Points at a local Verdaccio
 * (`docker compose -f docker/verdaccio.compose.yml up -d` ->
 * http://localhost:4873) so a stray `bun run release` on a dev
 * machine can never accidentally hit the public npm registry.
 * CI enforced via the `NPM_REGISTRY` env var (see
 * `.github/workflows/release.yml`).
 */
const DEFAULT_REGISTRY = "http://localhost:4873";

/**
 * Per-package directory we stage into. Sibling of `package.json`,
 * gitignored at the repo root. Always recreated and always cleaned
 * up; see the `try/finally` in `publishOne`.
 */
const STAGE_DIRNAME = ".publish";

/**
 * Files npm/bun include in a tarball regardless of the `files` glob.
 * We mirror that by copying any of these that exist next to the
 * package's `package.json` into the stage.
 */
const CONVENTIONAL_FILES = [
  "README.md",
  "README",
  "LICENSE",
  "LICENSE.md",
  "CHANGELOG.md",
  "CHANGES.md",
  "NOTICE",
  "NOTICE.md",
];

const DEP_KEYS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/**
 * Hostnames we treat as "the developer's machine" for the purposes
 * of skipping the `bun login` requirement. Matches loopback addresses
 * and `*.local` so things like `http://verdaccio.local` work too.
 */
function isLocalRegistry(registry: string): boolean {
  try {
    const { hostname } = new URL(registry);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "::1" ||
      hostname.endsWith(".local")
    );
  } catch {
    return false;
  }
}

const program = new Command()
  .name("publish")
  .description("Publish every public workspace package to npm via `bun publish`.")
  .addOption(
    new Option("-r, --registry <url>", "registry to publish to")
      .env("NPM_REGISTRY")
      .default(DEFAULT_REGISTRY),
  )
  .option("--dry-run", "pack each package without uploading", false)
  .option("--otp <code>", "one-time password for 2FA-protected registries")
  .parse(process.argv);

const { dryRun, registry, otp } = program.opts<{
  dryRun: boolean;
  registry: string;
  otp?: string;
}>();

const rootMeta = (await Bun.file(
  resolve(ROOT, "package.json"),
).json()) as PackageJson & {
  catalog?: Record<string, string>;
  catalogs?: Record<string, Record<string, string>>;
};
const defaultData = (await Bun.file(
  resolve(ROOT, "package.default.json"),
).json()) as PackageJson;
const enforcedData = (await Bun.file(
  resolve(ROOT, "package.enforced.json"),
).json()) as PackageJson;
const enforcedRepo = (enforcedData.repository ?? {}) as Record<string, unknown>;

const DEFAULT_CATALOG = rootMeta.catalog ?? {};
const NAMED_CATALOGS = rootMeta.catalogs ?? {};

const packages = await discoverPackages();
const workspaceVersions = new Map<string, string>();
for (const pkg of packages) {
  if (pkg.meta.name && pkg.meta.version) {
    workspaceVersions.set(pkg.meta.name, pkg.meta.version);
  }
}

/**
 * Resolve a `workspace:` specifier (e.g. `workspace:*`,
 * `workspace:^`, `workspace:1.2.3`) using the in-monorepo version of
 * `name`. Mirrors what `bun publish` does internally when run from a
 * workspace member; we replicate it here because the stage dir is
 * outside the workspace tree.
 */
function resolveWorkspaceDep(name: string, spec: string): string {
  const target = workspaceVersions.get(name);
  if (!target) {
    fail(`${name} uses ${spec} but isn't a workspace package`);
  }
  const rest = spec.slice("workspace:".length);
  if (rest === "" || rest === "*") return target;
  if (rest === "^") return `^${target}`;
  if (rest === "~") return `~${target}`;
  return rest;
}

/**
 * Resolve a `catalog:` or `catalog:<name>:` specifier against the
 * root manifest's `catalog`/`catalogs` fields. Default catalog when
 * the spec is bare `catalog:`, named catalog otherwise.
 */
function resolveCatalogDep(name: string, spec: string): string {
  const catalogName = spec.slice("catalog:".length);
  const catalog =
    catalogName === "" ? DEFAULT_CATALOG : (NAMED_CATALOGS[catalogName] ?? null);
  if (!catalog) {
    fail(`${name} references unknown catalog "${catalogName || "(default)"}"`);
  }
  const range = catalog[name];
  if (!range) {
    fail(`${name} not present in catalog "${catalogName || "(default)"}"`);
  }
  return range;
}

/**
 * Walk every dep map on `meta` and rewrite `workspace:`/`catalog:`
 * specifiers in place into the real version range that consumers
 * outside the monorepo can install.
 */
function rewriteSpecialDeps(meta: PackageJson): void {
  for (const key of DEP_KEYS) {
    const deps = meta[key];
    if (!deps || typeof deps !== "object") continue;
    const depsMap = deps as Record<string, string>;
    for (const [name, spec] of Object.entries(depsMap)) {
      if (typeof spec !== "string") continue;
      if (spec.startsWith("workspace:")) {
        depsMap[name] = resolveWorkspaceDep(name, spec);
      } else if (spec.startsWith("catalog:")) {
        depsMap[name] = resolveCatalogDep(name, spec);
      }
    }
  }
}

/**
 * Merge default < own < enforced for one package, stamp in the
 * package-specific `repository.directory`, and rewrite all special
 * dep specifiers. Shallow merge is on purpose: when a package
 * defines its own multi-condition `exports` map (e.g.
 * `@dbx-tools/appkit-shared`'s dual server/browser entry), the
 * default single-entry map is replaced wholesale instead of
 * deep-merged into it.
 */
function mergeForRelease(pkg: WorkspacePackage): PackageJson {
  const merged: PackageJson = {
    ...defaultData,
    ...pkg.meta,
    ...enforcedData,
    repository: {
      ...enforcedRepo,
      directory: relative(ROOT, pkg.dir).replace(/\\/g, "/"),
    },
  };
  rewriteSpecialDeps(merged);
  return merged;
}

/**
 * Return `true` when `name@version` already exists on the configured
 * registry. Lets us skip re-publishing during a re-run instead of
 * tripping over npm's `EPUBLISHCONFLICT`.
 */
async function isAlreadyPublished(
  pkg: WorkspacePackage,
  registry: string,
): Promise<boolean> {
  const { name, version } = pkg.meta;
  if (!name || !version) return false;
  const out = await run(
    "npm",
    ["view", `${name}@${version}`, "version", `--registry=${registry}`],
    { capture: true, check: false },
  );
  return out === version;
}

/**
 * Copy every entry matched by the merged manifest's `files` glob,
 * plus the conventional README/LICENSE/CHANGELOG/NOTICE files, from
 * `pkg.dir` into `stageDir`. Glob entries that look like a literal
 * directory or file path are copied verbatim; anything with glob
 * metacharacters is expanded with `Bun.Glob`.
 */
async function copyPublishableFiles(
  pkg: WorkspacePackage,
  filesList: string[],
  stageDir: string,
): Promise<void> {
  const seen = new Set<string>();
  const copy = (entry: string): void => {
    if (seen.has(entry)) return;
    seen.add(entry);
    const src = resolve(pkg.dir, entry);
    if (!existsSync(src)) return;
    const dest = resolve(stageDir, entry);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
  };

  for (const entry of filesList) {
    if (/[*?[\]{}]/.test(entry)) {
      const glob = new Bun.Glob(entry);
      for await (const match of glob.scan({ cwd: pkg.dir, onlyFiles: false })) {
        copy(match);
      }
    } else {
      copy(entry);
    }
  }

  for (const f of CONVENTIONAL_FILES) copy(f);
}

/**
 * Stage `pkg` into a gitignored `<pkg>/.publish/` directory and run
 * `bun publish` (or `bun pm pack` for dry-runs) from there. The
 * stage gets recreated from scratch on every call and always wiped
 * by the `finally` block, so a failed publish never leaves a stale
 * directory behind.
 */
async function publishOne(pkg: WorkspacePackage): Promise<void> {
  const stageDir = resolve(pkg.dir, STAGE_DIRNAME);
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  try {
    const merged = mergeForRelease(pkg);
    const filesList = Array.isArray(merged.files) ? (merged.files as string[]) : [];
    await copyPublishableFiles(pkg, filesList, stageDir);
    await writeJson(resolve(stageDir, "package.json"), merged);

    if (isLocalRegistry(registry)) {
      const scope = pkg.meta.name?.split("/")[0] ?? "";
      const url = registry.endsWith("/") ? registry : `${registry}/`;
      const bunfig =
        `[install.scopes]\n` +
        `${JSON.stringify(scope)} = { token = "anonymous", url = ${JSON.stringify(url)} }\n`;
      await Bun.write(resolve(stageDir, "bunfig.toml"), bunfig);
    }

    if (dryRun) {
      await run("bun", ["pm", "pack", "--dry-run"], { cwd: stageDir });
      console.log(`✓ packed (dry-run) ${pkg.meta.name}@${pkg.meta.version}`);
      return;
    }
    const args = ["publish", "--access=public", `--registry=${registry}`];
    if (otp) args.push(`--otp=${otp}`);
    await run("bun", args, { cwd: stageDir });
    console.log(`✓ published ${pkg.meta.name}@${pkg.meta.version}`);
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

console.log(
  `${dryRun ? "Dry-run packing" : "Publishing"} ${packages.length} package(s) to ${registry}:`,
);
for (const pkg of packages) console.log(`  - ${pkg.slug}`);
console.log();

let failures = 0;
for (const pkg of packages) {
  if (!dryRun && (await isAlreadyPublished(pkg, registry))) {
    console.log(`- skipping ${pkg.meta.name}@${pkg.meta.version}: already on registry`);
    continue;
  }
  try {
    await publishOne(pkg);
  } catch (err) {
    failures++;
    console.error(
      `✗ publish failed for ${pkg.meta.name}@${pkg.meta.version}: ${(err as Error).message}`,
    );
  }
}

if (failures > 0) fail(`${failures} package(s) failed to publish`);
