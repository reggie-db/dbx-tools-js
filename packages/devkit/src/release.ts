// Publish pipeline for the publishable workspace packages, run via
// `devkit release` (add `--dry-run` to rehearse without publishing).
//
// Source `package.json` files are deliberately minimal: name, version,
// `type`, the deps, and a one-line `exports` pointer at the package's
// own source (`{ ".": "./src/index.ts" }`, or a subpath pointer like
// `{ "./react": "./src/react/index.ts" }`). Everything a published
// tarball needs but a developer doesn't - the expanded conditional
// `exports`, `main`, `types`, `files`, `license` - is *stamped in* here,
// just before `bun publish`, and reverted immediately after. So the
// committed manifests stay slim while the published ones are complete.
//
// Stamping is driven entirely by each manifest's own shape, never by
// package name:
//   - Any `exports` target that is a `.ts` source string (under any
//     subpath) expands to the `source`/`types`/`default` shape.
//   - An `exports` target that is already an object is hand-written and
//     left verbatim - this is how a package opts a subpath out of the
//     expansion (e.g. a bespoke browser/server conditional split that
//     can't be a single source string).
//   - `main`/`types` derive from the `.` export when present, else the
//     first expanded subpath; both, plus `files`/`license`/`type`, are
//     only filled when the manifest hasn't already set them.

import { consola } from "consola";
import { build } from "./build.js";
import { discoverPackages, type PackageJson } from "./package.js";
import { errorMessage } from "./script.js";
import { sh } from "./shell.js";

/** SPDX license stamped onto published packages that don't set their own. */
const DEFAULT_LICENSE = "Apache-2.0";

/** Options for {@link release}. */
export interface ReleaseOptions {
  /** Rehearse with `bun publish --dry-run` instead of publishing. */
  dryRun?: boolean;
}

/** Map a `.ts` source path to its emitted `dist` `.js` / `.d.ts` pair. */
function distFromSource(source: string): { js: string; dts: string } {
  const stem = source
    .replace(/^\.\//, "")
    .replace(/^src\//, "")
    .replace(/\.[cm]?tsx?$/, "");
  return { js: `./dist/${stem}.js`, dts: `./dist/${stem}.d.ts` };
}

/**
 * Return a publishable copy of `meta`: expand any source `exports`
 * pointer into the full `source`/`types`/`default` shape and fill in
 * `main`, `types`, `files`, `license`, and `type` when absent. Any field
 * the manifest already sets is preserved.
 */
function stampManifest(meta: PackageJson): PackageJson {
  const stamped: PackageJson = { ...meta };
  const exportsMap = meta.exports;
  // Dist pair backing the legacy `main`/`types` fallbacks. Prefer the
  // root (`.`) export; otherwise fall back to the first subpath whose
  // target is a source pointer (e.g. the `-ui` packages whose only
  // entry is `./react`).
  let rootDist: { js: string; dts: string } | undefined;
  let firstDist: { js: string; dts: string } | undefined;

  if (exportsMap && typeof exportsMap === "object") {
    const nextExports: Record<string, unknown> = {};
    for (const [subpath, target] of Object.entries(
      exportsMap as Record<string, unknown>,
    )) {
      // A bare `.ts` string is the slim source pointer: expand it so
      // consumers load `dist` while source/monorepo resolution keeps the
      // raw `.ts` via the `source` condition.
      if (typeof target === "string" && /\.[cm]?tsx?$/.test(target)) {
        const dist = distFromSource(target);
        nextExports[subpath] = { source: target, types: dist.dts, default: dist.js };
        if (subpath === ".") rootDist = dist;
        firstDist ??= dist;
      } else {
        nextExports[subpath] = target;
      }
    }
    stamped.exports = nextExports;
  }

  const mainDist = rootDist ?? firstDist;
  if (mainDist) {
    stamped.main ??= mainDist.js;
    stamped.types ??= mainDist.dts;
  }
  // Every published tarball ships its built `dist` plus the `src` that
  // the `source` export condition points at.
  stamped.files ??= ["dist", "src"];
  stamped.license ??= DEFAULT_LICENSE;
  stamped.type ??= "module";
  return stamped;
}

/**
 * Build every publishable package, then publish each with a stamped
 * (complete) `package.json`, restoring the slim source manifest after
 * each publish whether it succeeds or fails.
 */
export async function release(opts: ReleaseOptions = {}): Promise<void> {
  const { dryRun = false } = opts;

  await build();

  const pkgs = await discoverPackages(
    (pkg) => pkg.meta.private !== true && Boolean(pkg.meta.name),
  );
  consola.log(
    `=== ${dryRun ? "Dry-run publishing" : "Publishing"} ${pkgs.length} package(s) ===`,
  );

  const failures: string[] = [];
  for (const pkg of pkgs) {
    const original = await Bun.file(pkg.jsonPath).text();
    const meta = JSON.parse(original) as PackageJson;
    const stamped = stampManifest(meta);
    await Bun.write(pkg.jsonPath, JSON.stringify(stamped, null, 2) + "\n");
    try {
      await sh(["bun", "publish", ...(dryRun ? ["--dry-run"] : [])], { cwd: pkg.dir });
      consola.success(`${dryRun ? "Dry-run" : "Published"} ${pkg.meta.name}`);
    } catch (error) {
      consola.error(`Failed to publish ${pkg.meta.name}: ${errorMessage(error)}`);
      failures.push(pkg.meta.name!);
    } finally {
      // Restore the exact slim source manifest (original bytes) so the
      // working tree never carries the stamped fields.
      await Bun.write(pkg.jsonPath, original);
    }
  }

  if (failures.length > 0) {
    consola.error(`Publish failed for: ${failures.join(", ")}`);
    process.exit(1);
  }
  consola.log(
    `${dryRun ? "Dry-run complete" : "Published"} ${pkgs.length} package(s).`,
  );
}
