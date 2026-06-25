// Publish every non-private workspace package to npm.
//
// Exposed two ways:
//   - The `devkit release` command (builds first, then publishes).
//   - Library: `import { release } from "@dbx-tools/devkit"` - `tag.ts`
//     calls it after the version bump so every `devkit tag` also lands
//     the freshly-tagged versions on the local Verdaccio registry. That
//     matters when the public-npm path is gated (e.g. a corp proxy that
//     quarantines new versions for some days): local consumers pull the
//     same package shape from Verdaccio immediately instead of waiting
//     for the public copy to clear.
//
// On-disk `packages/*/package.json` files are kept to the absolute
// minimum needed for dev tooling (name / version / type / module /
// deps, plus per-package custom fields like a dual-entry `exports`
// map). The publish-time shape - license, repo, files, publishConfig,
// the standard single-entry exports map, and so on - is split between
// two root-level files:
//
//   - `package.default.json`   fills in fields the package didn't
//                               define (low-priority template).
//   - `package.enforced.json`  forces fields on top of everything
//                               (org-wide constants).
//
// Why a stage directory instead of mutating `package.json` in place:
// `bun pm pack` and `npm publish` only ever read `package.json` from
// the cwd - there's no `--manifest <path>` flag - so we can't just
// hand them a `package.generated.json`. Mutating the source file in
// place during publish would briefly dirty the working tree. To keep
// `git status` clean throughout, we stage each package into
// `<pkg>/.publish/` (gitignored), copy the publishable files in, and
// run the publish command from inside the stage.
//
// One catch: a stage dir isn't a workspace member, so the tooling
// inside it can't rewrite `workspace:*` and `catalog:` specifiers on
// our behalf. We pre-resolve those in `mergeForRelease()` from the
// workspace's own version map and the root manifest's `catalog`/
// `catalogs` fields before writing the staged manifest.
//
// Why `npm publish` instead of `bun publish` for the upload:
// `bun publish` (as of 1.3.13) ships the tarball but does not embed
// the package README into the registry manifest payload. npm's web
// UI reads `manifest.readme` to render the package page, so packages
// published with `bun publish` show up with an empty page even
// though the README file is in the tarball. `npm publish`
// serializes the README into the manifest correctly, so that's what
// we use for the actual upload. Dry-runs still use `bun pm pack
// --dry-run` because it's faster and doesn't need npm installed.
//
// Local-registry shortcut: when `--registry` points at a loopback
// host (Verdaccio in docker, the default), we drop a stage-local
// `.npmrc` carrying a placeholder `_authToken`. `npm publish`
// refuses to upload without auth configured, but Verdaccio is set
// to `publish: $$all` and accepts any token. Result: local
// publishes work with zero `npm login` / `bun login` and the user's
// real `~/.npmrc` is never touched.

import { consola } from "consola";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { build } from "./build.js";
import {
  discoverPackages,
  orderByDependencies,
  toAbsolute,
  writeJson,
  type PackageJson,
  type WorkspacePackage,
} from "./package.js";
import { getProject } from "./project.js";
import { errorMessage, fail } from "./script.js";
import { sh } from "./shell.js";

/**
 * Default registry. Points at the local Verdaccio convention
 * (`http://localhost:4873`) so a stray `devkit release` on a dev
 * machine can never accidentally hit the public npm registry. Start
 * Verdaccio however you like (`npx verdaccio`, your own docker
 * compose, etc.); the publish flow only cares that the URL resolves.
 * CI enforced via the `NPM_REGISTRY` env var.
 */
export const DEFAULT_REGISTRY = "http://localhost:4873";

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
 * Read a JSON file, returning an empty object when it doesn't exist.
 * Used for the optional `package.default.json` / `package.enforced.json`
 * release-shaping templates so the publish flow works in repos that
 * don't define them.
 */
async function readOptionalJson(path: string): Promise<PackageJson> {
  if (!existsSync(path)) return {} as PackageJson;
  return (await Bun.file(path).json()) as PackageJson;
}

/** Options accepted by {@link release}. */
export interface ReleaseOptions {
  /** Registry to publish to. Defaults to {@link DEFAULT_REGISTRY}. */
  registry?: string;
  /** Pack each package without uploading. */
  dryRun?: boolean;
  /** Skip building the packages before publishing. */
  skipBuild?: boolean;
  /** One-time password for 2FA-protected registries. */
  otp?: string;
}

/**
 * Per-package publish-time file staging, declared in a package's
 * `package.json` under `release.stage` as a map of repo-root-relative
 * source path to a package-relative destination. Copied in {@link
 * release} once `build()` has run (so `dist/` is ready), letting a
 * package fold repo-root or generated assets into its own tarball -
 * e.g. devkit ships the root `tsconfig.build.json` / `package.default.json`
 * as `dist/*.template` for its `create` command to seed downstream.
 */
interface ReleaseMeta {
  stage?: Record<string, string>;
}

/** Per-run tally returned by {@link release}. */
export interface ReleaseResult {
  /** Packages uploaded (or packed, in dry-run) this run. */
  published: number;
  /** Packages skipped because the version already exists on the registry. */
  skipped: number;
  /** Packages whose publish threw. */
  failed: number;
  /** Total publishable packages considered. */
  total: number;
}

/**
 * Hostnames we treat as "the developer's machine" for the purposes
 * of skipping the `npm login` requirement. Matches loopback addresses
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
  const out = await sh(
    ["npm", "view", `${name}@${version}`, "version", `--registry=${registry}`],
    { nothrow: true, quiet: true },
  );
  return out.stdout === version;
}

/**
 * Copy a package's declared `release.stage` assets into its own tree.
 * Each entry maps a repo-root-relative source to a package-relative
 * destination (see {@link ReleaseMeta}); parent dirs are created as
 * needed. A no-op for packages without a `release.stage` block. A
 * declared source that doesn't exist is fatal - it almost always means
 * a stale path in the manifest.
 */
function stageReleaseAssets(pkg: WorkspacePackage): void {
  const stage = (pkg.meta as { release?: ReleaseMeta }).release?.stage;
  if (!stage) return;
  for (const [from, to] of Object.entries(stage)) {
    const src = toAbsolute(from);
    if (!existsSync(src)) {
      fail(`${pkg.meta.name}: release.stage source not found: ${from}`);
    }
    const dest = resolve(pkg.dir, to);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
  }
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
 * Publish (or, with `dryRun`, pack) every public workspace package to
 * `registry`. Produces the same staged manifest a real npm publish
 * would (default < own < enforced, with `workspace:*`/`catalog:`
 * specifiers resolved to concrete ranges), so a local Verdaccio copy
 * is byte-for-byte what an npm consumer would install.
 *
 * Idempotent: versions already present on the registry are skipped
 * rather than re-uploaded. Per-package failures are tallied (not
 * thrown) so one bad package doesn't abort the rest; callers inspect
 * `result.failed` and decide whether that's fatal.
 */
export async function release(opts: ReleaseOptions = {}): Promise<ReleaseResult> {
  const { registry = DEFAULT_REGISTRY, dryRun = false, otp } = opts;

  const project = await getProject();
  const rootWorkspace = project.rootWorkspace;

  const rootMeta = (await Bun.file(
    toAbsolute(join(rootWorkspace.path, "package.json")),
  ).json()) as PackageJson & {
    catalog?: Record<string, string>;
    catalogs?: Record<string, Record<string, string>>;
  };
  // The release-shaping templates are optional: a consuming repo that
  // doesn't split publish-time fields out into these files just
  // publishes each package's own `package.json` as-is.
  const defaultData = await readOptionalJson(toAbsolute("package.default.json"));
  const enforcedData = await readOptionalJson(toAbsolute("package.enforced.json"));
  const enforcedRepo = (enforcedData.repository ?? {}) as Record<string, unknown>;

  const DEFAULT_CATALOG = rootMeta.catalog ?? {};
  const NAMED_CATALOGS = rootMeta.catalogs ?? {};

  // Publish in workspace dependency order so a package is on the
  // registry before anything that depends on it.
  const packages = orderByDependencies(await discoverPackages());
  const workspaceVersions = new Map<string, string>();
  for (const pkg of packages) {
    if (pkg.meta.name && pkg.meta.version) {
      workspaceVersions.set(pkg.meta.name, pkg.meta.version);
    }
  }

  // `build()` has run, so every package's `dist/` is in place: fold each
  // package's declared `release.stage` assets into its tree before the
  // pack/publish loop reads them via the `files` glob.
  for (const pkg of packages) stageReleaseAssets(pkg);

  /**
   * Resolve a `workspace:` specifier (e.g. `workspace:*`,
   * `workspace:^`, `workspace:1.2.3`) using the in-monorepo version of
   * `name`. Mirrors what bun does internally when run from a workspace
   * member; we replicate it here because the stage dir is outside the
   * workspace tree (and `npm publish`, which we use for the actual
   * upload, doesn't understand `workspace:` specifiers at all).
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
   * defines its own multi-condition `exports` map, the default
   * single-entry map is replaced wholesale instead of deep-merged.
   */
  function mergeForRelease(pkg: WorkspacePackage): PackageJson {
    const merged: PackageJson = {
      ...defaultData,
      ...pkg.meta,
      ...enforcedData,
      repository: {
        ...enforcedRepo,
        directory: pkg.slug.replace(/\\/g, "/"),
      },
    };
    rewriteSpecialDeps(merged);
    return merged;
  }

  /**
   * Stage `pkg` into a gitignored `<pkg>/.publish/` directory and run
   * `npm publish` (or `bun pm pack --dry-run` for dry-runs) from
   * there. The stage gets recreated from scratch on every call and
   * always wiped by the `finally` block, so a failed publish never
   * leaves a stale directory behind. We use `npm publish` rather than
   * `bun publish` because bun (1.3.13) doesn't embed the README into
   * the registry manifest payload, which leaves the npm web UI
   * showing an empty package page.
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
        const { host } = new URL(registry);
        await Bun.write(
          resolve(stageDir, ".npmrc"),
          `//${host}/:_authToken=anonymous\n`,
        );
      }

      if (dryRun) {
        await sh(["bun", "pm", "pack", "--dry-run"], { cwd: stageDir });
        consola.log(`packed (dry-run) ${pkg.meta.name}@${pkg.meta.version}`);
        return;
      }
      if (!opts.skipBuild) {
        await build();
      }
      const args = ["publish", "--access=public", `--registry=${registry}`];
      if (otp) args.push(`--otp=${otp}`);
      // `npm publish` streams a long `npm notice` tarball manifest on
      // success. Keep it quiet - the output is still captured and, on a
      // non-zero exit, surfaced via the thrown error's detail - so a
      // normal release prints just the per-package `✓ published` line.
      await sh(["npm", ...args], { cwd: stageDir, quiet: true });
      consola.log(`✓ published ${pkg.meta.name}@${pkg.meta.version}`);
    } finally {
      rmSync(stageDir, { recursive: true, force: true });
    }
  }

  consola.log(
    `${dryRun ? "Dry-run packing" : "Publishing"} ${packages.length} package(s) to ${registry}:`,
  );
  for (const pkg of packages) consola.log(`  - ${pkg.slug}`);
  consola.log("");

  let published = 0;
  let skipped = 0;
  let failed = 0;
  for (const pkg of packages) {
    if (!dryRun && (await isAlreadyPublished(pkg, registry))) {
      consola.log(
        `- skipping ${pkg.meta.name}@${pkg.meta.version}: already on registry`,
      );
      skipped++;
      continue;
    }
    try {
      await publishOne(pkg);
      published++;
    } catch (err) {
      failed++;
      consola.error(
        `✗ publish failed for ${pkg.meta.name}@${pkg.meta.version}: ${errorMessage(err)}`,
      );
    }
  }

  return { published, skipped, failed, total: packages.length };
}
