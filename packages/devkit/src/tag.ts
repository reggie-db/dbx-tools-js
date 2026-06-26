// Bump every publishable workspace to the next version, commit the
// bump, then tag HEAD with `v<version>` and push both the commit and
// the tag to origin. The tag push fires the repo's release workflow,
// which builds every publishable workspace and runs the publish step.
//
// After pushing, the function can also run the workspace publish script
// so local release flows use the same Bun-based package publishing path
// as CI. Opt out with `publish: false`.
//
// All packages in the changesets `fixed` group share one version. The
// function reads the shared version from the first publishable package,
// sanity-checks that every other package agrees, then bumps that one
// number with `semver.inc()` and writes it back to every package.
//
// Local state policy:
//   - Dirty files are auto-staged (`git add -A`) and folded into the
//     release commit. If you don't want something shipped, stash it.
//   - Unpushed commits are pushed along with the release commit.
//   - Branch must have an upstream (otherwise we can't push).
//   - New tag must not already exist locally or on the remote.

import { consola } from "consola";
import semver from "semver";
import { getDevkitConfig } from "./config.js";
import { git, requireGitRepo } from "./git.js";
import { discoverPackages, writeJson } from "./package.js";
import { fail, nonEmptyLines } from "./script.js";
import { sh } from "./shell.js";

export type Bump = "major" | "minor" | "patch";

/** Options for {@link tag}. */
export interface TagOptions {
  /** Version bump (defaults to `patch`). */
  bump?: Bump;
  /** Print everything, write nothing. */
  dryRun?: boolean;
  /** Publish the tagged versions to the local registry (default true). */
  publish?: boolean;
}

/**
 * `git rev-parse <args>`, returning trimmed stdout. Tolerant by
 * design (`nothrow`): rev-parse exits non-zero when a ref is unknown
 * (e.g. an unset `@{u}` upstream or a missing tag), and every caller
 * here treats "unknown" as an empty string rather than an error.
 */
async function gitRevParse(...args: string[]): Promise<string> {
  return (await git(["rev-parse", ...args], { nothrow: true })).stdout;
}

/** `git status --porcelain` stdout (one entry per changed path). */
async function gitStatus(): Promise<string> {
  return (await git(["status", "--porcelain"])).stdout;
}

/** `git push origin <ref>` (commit branch or tag). */
async function gitPush(ref: string): Promise<void> {
  await git(["push", "origin", ref]);
}

/**
 * Find every publishable workspace and assert they all share the same
 * version (the changesets `fixed` policy). Returns the shared version
 * and the package list.
 */
async function findPublishables(): Promise<{
  version: string;
  pkgs: { name: string; jsonPath: string }[];
}> {
  const all = (await discoverPackages()).filter(
    (pkg) => pkg.meta.name && pkg.meta.version,
  );
  if (all.length === 0) fail("No publishable packages found under packages/");

  const versions = new Set(all.map((p) => p.meta.version!));
  if (versions.size > 1) {
    fail(
      `Publishable packages disagree on version (expected one fixed version):\n` +
        all.map((p) => `  ${p.meta.name}@${p.meta.version}`).join("\n"),
    );
  }

  return {
    version: all[0]!.meta.version!,
    pkgs: all.map((p) => ({ name: p.meta.name!, jsonPath: p.jsonPath })),
  };
}

/** Mutate just the `version` field of a package.json on disk. */
async function writeVersion(jsonPath: string, nextVersion: string): Promise<void> {
  const meta = (await Bun.file(jsonPath).json()) as Record<string, unknown>;
  meta.version = nextVersion;
  await writeJson(jsonPath, meta);
}

/**
 * Create (or, on retry, update) the GitHub Release for `tag` with
 * `body` as its markdown description. GitHub renders the Release
 * body as markdown, unlike the bare tag annotation page which is
 * monospace plaintext.
 *
 * Silently no-ops when `gh` is not on `PATH`. Failures are logged
 * but never abort: the tag is already pushed at this point.
 */
async function publishGithubRelease(tag: string, body: string): Promise<void> {
  if (!Bun.which("gh")) {
    consola.log("(skipping GitHub Release: gh CLI not on PATH)");
    return;
  }
  consola.log(`Publishing GitHub Release ${tag}...`);
  const gh = async (args: string[]): Promise<number> => {
    const { exitCode } = await sh(["gh", ...args], { nothrow: true });
    return exitCode;
  };
  const createCode = await gh([
    "release",
    "create",
    tag,
    "--title",
    tag,
    "--notes",
    body,
  ]);
  if (createCode === 0) return;
  // Most common failure: the release already exists (e.g. the tag
  // was pushed but a previous run aborted before this step). Update
  // it in place so reruns are idempotent.
  consola.warn(`gh release create exited ${createCode}; trying gh release edit.`);
  const editCode = await gh(["release", "edit", tag, "--notes", body]);
  if (editCode !== 0) {
    consola.warn(
      `gh release edit exited ${editCode}; release may need manual creation.`,
    );
  }
}

/**
 * Version-bump every publishable workspace, commit, tag, push, create
 * the GitHub Release, and publish to the local registry. See the file
 * header for the full local-state policy.
 */
export async function tag(opts: TagOptions = {}): Promise<void> {
  const { bump = "patch", dryRun = false, publish = true } = opts;

  // Tagging commits, tags, and pushes - all of which need git and a
  // repo. Fail upfront with a clear message rather than partway through.
  await requireGitRepo("devkit tag");

  const { version: currentVersion, pkgs } = await findPublishables();
  const nextVersion = semver.inc(currentVersion, bump);
  if (!nextVersion) {
    fail(`Cannot ${bump}-bump version "${currentVersion}" (semver.inc returned null)`);
  }
  const tagName = `v${nextVersion}`;

  // The function is permissive about local state: dirty files get
  // folded into the release commit and unpushed commits get pushed
  // along with it. Dry-run still skips everything that touches disk or
  // the remote.
  const branch = await gitRevParse("--abbrev-ref", "HEAD");
  const dirty = await gitStatus();
  let ahead = "0";
  if (!dryRun) {
    const upstream = await gitRevParse("--abbrev-ref", "--symbolic-full-name", "@{u}");
    if (!upstream) {
      fail(
        `Branch ${branch} has no upstream. Push the branch first so the release commit lands on a known ref.`,
      );
    }
    ahead = (await git(["rev-list", "--count", `${upstream}..HEAD`])).stdout;
  }

  if (await gitRevParse("--verify", `refs/tags/${tagName}`)) {
    fail(`Tag ${tagName} already exists locally. Pick a different bump.`);
  }

  if ((await git(["ls-remote", "--tags", "origin", `refs/tags/${tagName}`])).stdout) {
    fail(`Tag ${tagName} already exists on origin. Pick a different bump.`);
  }

  const prevTag =
    (await git(["describe", "--tags", "--abbrev=0"], { nothrow: true })).stdout || null;

  consola.log(`Bump:    ${bump}`);
  consola.log(`Current: ${currentVersion}`);
  consola.log(`Next:    ${nextVersion}`);
  consola.log(`Tag:     ${tagName}`);
  consola.log(`Prev:    ${prevTag ?? "(none)"}`);
  const headSha = await gitRevParse("--short", "HEAD");
  consola.log(`HEAD:    ${headSha} (${branch})`);
  consola.log(`Packages:`);
  for (const p of pkgs) consola.log(`  ${p.name}`);
  if (dirty) {
    consola.log(`Dirty files (will be folded into the release commit):`);
    for (const line of nonEmptyLines(dirty)) consola.log(`  ${line}`);
  }
  if (ahead !== "0") {
    consola.log(`Unpushed commits: ${ahead} (will be pushed with the release commit)`);
  }
  consola.log("");

  const tagMessage = `Release ${tagName}`;

  if (dryRun) {
    consola.log("--dry-run: skipping write, commit, tag, and push.");
    if (publish) {
      await sh(["bun", "run", "release", "--dry-run"], { nothrow: true });
    }
    return;
  }

  consola.log(`Writing ${nextVersion} to ${pkgs.length} package.json file(s)...`);
  for (const p of pkgs) await writeVersion(p.jsonPath, nextVersion);

  consola.log(`Committing release ${tagName}...`);
  await git(["add", "-A"]);
  await git(["commit", "-m", `chore: release ${tagName}`]);

  consola.log(`Pushing ${branch}...`);
  await gitPush(branch);

  consola.log(`Tagging HEAD as ${tagName}...`);
  await git(["tag", "-a", tagName, "-m", tagMessage]);

  consola.log(`Pushing ${tagName} to origin...`);
  await gitPush(tagName);

  await publishGithubRelease(tagName, tagMessage);

  // Publish via the repo's Bun-based release script. Best-effort: the tag
  // is already pushed, so a publish failure is a warning, not a failure.
  if (publish) {
    await sh(["bun", "run", "release"], { nothrow: true });
  }

  consola.log("");
  consola.log(`Released ${tagName}.`);
  const { repo } = await getDevkitConfig();
  if (repo) {
    consola.log("  The Release workflow will fire on the tag push:");
    consola.log(`  https://github.com/${repo}/actions/workflows/release.yml`);
  } else {
    consola.log("  The Release workflow will fire on the tag push.");
  }
}
