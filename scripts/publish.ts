#!/usr/bin/env bun
// Publish every non-private workspace package to npm.
//
// On-disk `packages/*/package.json` files are kept to the absolute
// minimum needed for dev tooling (name / version / type / module /
// deps, plus per-package custom enforced). The publish-time shape -
// license, repo, files, publishConfig, the standard single-entry
// exports map, and so on - is split between two root-level files:
//
//   - `package.defaults.json`   fills in fields the package didn't
//                               define (low-priority template).
//   - `package.enforced.json`  forces fields on top of everything
//                               (org-wide constants).
//
// On every release, this script merges those two with each package's
// own `package.json` (in priority order: defaults < own < enforced),
// writes the merged result back to the package.json on disk, calls
// `bun publish` from the package directory, then restores the
// original bytes in a `finally` block. If anything kills the process
// between mutate and revert, `git checkout packages/*/package.json`
// puts the source tree back; CI runners are ephemeral so it's a
// non-issue there.
//
// `bun publish` does the rest: it rewrites `workspace:*` and
// `catalog:` specifiers, packs the tarball per the `files` glob, and
// uploads to the configured registry. Dry runs use `bun pm pack
// --dry-run` because `bun publish --dry-run` still requires npm auth
// today.

import { relative, resolve } from "node:path";
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

const defaults = (await Bun.file(resolve(ROOT, "package.defaults.json")).json()) as PackageJson;
const enforced = (await Bun.file(resolve(ROOT, "package.enforced.json")).json()) as PackageJson;
const enforcedRepo = (enforced.repository ?? {}) as Record<string, unknown>;

/**
 * Merge defaults < own < enforced for one package and stamp in the
 * package-specific `repository.directory`. Shallow merge is on
 * purpose: when a package defines its own multi-condition `exports`
 * map (e.g. `@dbx-tools/appkit-shared`'s dual server/browser entry),
 * defaults' single-entry map is replaced wholesale instead of
 * deep-merged into it.
 */
function mergeForRelease(pkg: WorkspacePackage): PackageJson {
  return {
    ...defaults,
    ...pkg.meta,
    ...enforced,
    repository: {
      ...enforcedRepo,
      directory: relative(ROOT, pkg.dir).replace(/\\/g, "/"),
    },
  };
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
 * Mutate the package's `package.json` to its release shape, run
 * `bun publish` (or `bun pm pack` for dry-runs), then restore the
 * original bytes verbatim. Wrapped in try/finally so a publish
 * failure still reverts the on-disk file.
 */
async function publishOne(pkg: WorkspacePackage): Promise<void> {
  const original = await Bun.file(pkg.jsonPath).text();
  try {
    await writeJson(pkg.jsonPath, mergeForRelease(pkg));
    if (dryRun) {
      await run("bun", ["pm", "pack", "--dry-run"], { cwd: pkg.dir });
      console.log(`✓ packed (dry-run) ${pkg.meta.name}@${pkg.meta.version}`);
      return;
    }
    const args = ["publish", "--access=public", `--registry=${registry}`];
    if (otp) args.push(`--otp=${otp}`);
    await run("bun", args, { cwd: pkg.dir });
    console.log(`✓ published ${pkg.meta.name}@${pkg.meta.version}`);
  } finally {
    await Bun.write(pkg.jsonPath, original);
  }
}

const packages = await discoverPackages();

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
