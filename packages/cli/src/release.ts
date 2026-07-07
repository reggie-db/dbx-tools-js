// Publish pipeline for the publishable workspace packages, run via
// `dbxtools release` (add `--dry-run` to rehearse without publishing).
//
// Source `package.json` files are deliberately minimal: name, version,
// `type`, the deps, and a one-line `exports` pointer at the package's
// own source (`{ ".": "./src/index.ts" }`, or a subpath pointer like
// `{ "./react": "./src/react/index.ts" }`). Everything a published
// tarball needs but a developer doesn't - the expanded `exports`,
// `main`, `types`, `files`, `license` - is *stamped in* here, just
// before `bun publish`, and reverted immediately after. So the committed
// manifests stay slim while the published ones are complete.
//
// Sibling `workspace:` dependency pins are also resolved to concrete
// versions here, from the on-disk (bumped) manifests rather than from
// the gitignored `bun.lock`. `bun publish` would otherwise resolve
// `workspace:*` against a possibly-stale lockfile and freeze a sibling
// pin one version behind, so a consumer pulls a mismatched nested copy
// of that sibling.
//
// Stamping is driven entirely by each manifest's own shape, never by
// package name:
//   - Any `exports` target that is a `.ts` source string (under any
//     subpath) expands to a `{ types, default }` pair pointing at the
//     built `dist`. The raw `.ts` source is not shipped (no `source`
//     condition, and `files` is `dist`-only) - it's a dev/monorepo
//     concern, where siblings resolve each other through workspace
//     symlinks rather than the published tarball.
//   - A non-`.ts` `exports` string under `src/` (e.g. a CSS bundle like
//     `"./styles.css": "./src/styles.css"`) is a copied asset: the build
//     copies it into `dist`, and the path is rewritten `src/` -> `dist/`
//     here so the tarball resolves it.
//   - An `exports` target that is already an object is hand-written and
//     left verbatim - this is how a package opts a subpath out of the
//     expansion (e.g. a bespoke browser/server conditional split that
//     can't be a single source string).
//   - `main`/`types` derive from the `.` export when present, else the
//     first expanded subpath; both, plus `files`/`license`/`type`, are
//     only filled when the manifest hasn't already set them.
//   - `bin` entries that point at `./bin/*.ts` in the source manifest are
//     rewritten to the matching `./dist/bin/*.js` built entry.

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

/** Dependency fields whose `workspace:` sibling pins get resolved before publish. */
const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/** Map a `.ts` source path to its emitted `dist` `.js` / `.d.ts` pair. */
function distFromSource(source: string): { js: string; dts: string } {
  const stem = source
    .replace(/^\.\//, "")
    .replace(/^src\//, "")
    .replace(/\.[cm]?tsx?$/, "");
  return { js: `./dist/${stem}.js`, dts: `./dist/${stem}.d.ts` };
}

/**
 * Resolve a `workspace:` protocol specifier to a concrete range using
 * the sibling's `version`. `workspace:*` (and bare `workspace:`) pin the
 * exact version, `workspace:^` / `workspace:~` carry the caret / tilde,
 * and an explicit `workspace:<range>` keeps its range.
 */
function resolveWorkspaceSpec(spec: string, version: string): string {
  const range = spec.slice("workspace:".length);
  if (range === "" || range === "*") return version;
  if (range === "^" || range === "~") return `${range}${version}`;
  return range;
}

/**
 * Return a copy of `deps` with every `workspace:` sibling pin resolved
 * to the sibling's just-bumped version from `siblingVersions`.
 *
 * This is done here, deterministically from the on-disk manifests,
 * rather than left to `bun publish` (which resolves `workspace:*` from
 * the gitignored `bun.lock`): a stale lockfile would otherwise freeze a
 * sibling pin one version behind, so a consumer installs a mismatched
 * nested copy of that sibling. A sibling missing from the map (e.g. a
 * private, non-published workspace) is left untouched.
 */
function resolveWorkspaceDeps(
  deps: Record<string, string>,
  siblingVersions: Map<string, string>,
): Record<string, string> {
  const next: Record<string, string> = { ...deps };
  for (const [name, spec] of Object.entries(next)) {
    if (typeof spec !== "string" || !spec.startsWith("workspace:")) continue;
    const version = siblingVersions.get(name);
    if (version) next[name] = resolveWorkspaceSpec(spec, version);
  }
  return next;
}

/** Rewrite dev `bin` pointers (`./bin/foo.ts`) to built `dist` targets. */
function stampBin(meta: PackageJson): PackageJson {
  const bin = meta.bin;
  if (!bin) return meta;

  const stampTarget = (target: string): string =>
    /^\.\/bin\/[^/]+\.[cm]?tsx?$/.test(target)
      ? target.replace(/^\.\/bin\/(.+)\.[cm]?tsx?$/, "./dist/bin/$1.js")
      : target;

  if (typeof bin === "string") {
    return { ...meta, bin: stampTarget(bin) };
  }

  const next: Record<string, string> = {};
  for (const [name, target] of Object.entries(bin)) {
    next[name] = stampTarget(target);
  }
  return { ...meta, bin: next };
}

/**
 * Return a publishable copy of `meta`: resolve `workspace:` sibling
 * pins to concrete versions (via `siblingVersions`), expand any source
 * `exports` pointer into a `{ types, default }` pair pointing at the
 * built `dist`, and fill in `main`, `types`, `files`, `license`, and
 * `type` when absent. Any field the manifest already sets is preserved.
 */
function stampManifest(
  meta: PackageJson,
  siblingVersions: Map<string, string>,
): PackageJson {
  const stamped: PackageJson = { ...meta };

  // Pin sibling workspace deps to the bumped version deterministically,
  // so published pins never lag behind a stale lockfile entry.
  for (const field of DEP_FIELDS) {
    const deps = meta[field];
    if (deps && typeof deps === "object") {
      stamped[field] = resolveWorkspaceDeps(
        deps as Record<string, string>,
        siblingVersions,
      );
    }
  }

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
      // A bare `.ts` string is the slim source pointer: expand it to the
      // built `dist` outputs so published consumers load JS + `.d.ts`.
      // No `source` condition (and no `src` in `files`) - the raw TS is
      // a dev/monorepo concern and is kept out of the tarball.
      if (typeof target === "string" && /\.[cm]?tsx?$/.test(target)) {
        const dist = distFromSource(target);
        nextExports[subpath] = { types: dist.dts, default: dist.js };
        if (subpath === ".") rootDist = dist;
        firstDist ??= dist;
      } else if (typeof target === "string" && target.startsWith("./src/")) {
        // A non-TS asset (e.g. a CSS bundle) - not compiled but copied
        // into `dist` at build time, so point the export at `dist`.
        nextExports[subpath] = target.replace(/^\.\/src\//, "./dist/");
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
  // Every published tarball ships only its built `dist`.
  stamped.files ??= ["dist"];
  stamped.license ??= DEFAULT_LICENSE;
  stamped.type ??= "module";
  // Scoped packages default to restricted (private) on npm; without an
  // explicit public access flag the first publish 402s on the free plan.
  if (
    typeof stamped.name === "string" &&
    stamped.name.startsWith("@") &&
    !stamped.publishConfig
  ) {
    stamped.publishConfig = { access: "public" };
  }
  return stampBin(stamped);
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
  // Name -> version for every publishable sibling, used to resolve
  // `workspace:` pins to concrete versions at stamp time.
  const siblingVersions = new Map<string, string>();
  for (const pkg of pkgs) {
    if (pkg.meta.name && pkg.meta.version) {
      siblingVersions.set(pkg.meta.name, pkg.meta.version);
    }
  }
  consola.log(
    `=== ${dryRun ? "Dry-run publishing" : "Publishing"} ${pkgs.length} package(s) ===`,
  );

  const failures: string[] = [];
  for (const pkg of pkgs) {
    const original = await Bun.file(pkg.jsonPath).text();
    const meta = JSON.parse(original) as PackageJson;
    const stamped = stampManifest(meta, siblingVersions);
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
