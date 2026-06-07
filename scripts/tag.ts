#!/usr/bin/env bun
// Bump every publishable workspace to the next version, commit the
// bump, then tag HEAD with `v<version>` and push both the commit and
// the tag to origin. The tag push fires
// `.github/workflows/release.yml`, which builds every publishable
// workspace and runs `bunx changeset publish`.
//
// Usage:
//   bun run tag                # patch bump (default)
//   bun run tag patch          # patch bump
//   bun run tag minor          # minor bump
//   bun run tag major          # major bump
//   bun run tag --dry-run      # print everything, write nothing
//
// All `@dbx-tools/*` packages are version-fixed via
// `.changeset/config.json`, so they always share one version. The
// script reads the shared version from the first publishable package,
// sanity-checks that every other package agrees, then bumps that one
// number with `semver.inc()` and writes it back to every package.
//
// Local state policy:
//   - Dirty files are auto-staged (`git add -A`) and folded into the
//     release commit. If you don't want something shipped, stash it.
//   - Unpushed commits are pushed along with the release commit.
//   - Branch must have an upstream (otherwise we can't push).
//   - New tag must not already exist locally or on the remote (pick
//     a different bump).
//
// Tag message:
//   The script collects commit log + diff stat since the previous
//   tag, hands them to `releaseNotes()`, and uses the returned text
//   as the annotated tag's message body. The default
//   `releaseNotes()` asks a Databricks model-serving endpoint via
//   `aiQuery()` from `util.ts`. If it returns null (no AI available,
//   no Databricks profile, etc.) the script falls back to a bare
//   `Release v<version>` message - no failure.

import { Command, InvalidArgumentError } from "commander";
import semver from "semver";
import { aiQuery, discoverPackages, fail, run, writeJson } from "./util.js";

type Bump = "major" | "minor" | "patch";

/** Wraps a git invocation with our standard subprocess defaults. */
async function git(
  args: string[],
  opts: { capture?: boolean; check?: boolean } = {},
): Promise<string> {
  return run("git", args, opts);
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

/** Context passed to the `releaseNotes()` hook. */
interface ReleaseNotesContext {
  /** Previous tag to diff against, or null if this is the first tag. */
  prevTag: string | null;
  /** The tag that will be created (e.g. `v0.2.0`). */
  nextTag: string;
  /** Git rev range used for log/diff (e.g. `v0.1.0..HEAD`), or null if no prev tag. */
  range: string | null;
  /** One-line commit subjects since `prevTag`, no merges. */
  commits: string[];
  /**
   * `git status --porcelain` lines for the working tree. Captures
   * dirty files that the release commit is about to fold in, so a
   * "no commits since prevTag, just uncommitted edits" release
   * still has change context for the notes generator.
   */
  pendingFiles: string[];
  /**
   * `git diff --stat` between `prevTag` and the **working tree**
   * (so committed + uncommitted changes are both visible). Empty
   * string when no `prevTag` exists.
   */
  diffStat: string;
  /** Ready-to-send prompt assembled from the fields above. */
  prompt: string;
}

const NOTES_INSTRUCTIONS = `
Generate markdown release notes for the following tag.

Requirements:
- Be terse
- Group by theme (Features, Fixes, Internals); skip empty sections
- No preamble
- No closing remarks
- No emojis
- No em dashes

Output the release notes only.`.trim();

/**
 * Build the release-notes prompt from git history + working tree.
 * Async because the underlying `run()` wrapper is async; the
 * function itself is still pure-shaped (no side effects) so it's
 * safe to preview in dry-run.
 *
 * Captures three sources of change so the notes generator can see
 * everything the release commit is about to ship, even when HEAD
 * still points at the previous tag:
 *
 *   - Commits in `prevTag..HEAD` (the usual case).
 *   - Working-tree dirty files via `git status --porcelain` (the
 *     "I edited a bunch of stuff then ran `bun run tag`" case).
 *   - A `git diff --stat` against `prevTag` directly (no `..HEAD`)
 *     so the stat includes both committed and uncommitted changes
 *     in one block.
 */
async function buildReleaseNotesContext(
  prevTag: string | null,
  nextTag: string,
): Promise<ReleaseNotesContext> {
  const range = prevTag ? `${prevTag}..HEAD` : null;
  const commits = range
    ? (await git(["log", "--no-merges", "--pretty=- %s", range], { capture: true }))
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
  const pendingFiles = (await git(["status", "--porcelain"], { capture: true }))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const diffStat = prevTag
    ? await git(["diff", "--stat", prevTag], { capture: true })
    : "";

  const prompt = [
    `Write release notes for ${nextTag}.`,
    ``,
    `Commits since ${prevTag ?? "(no previous tag)"}:`,
    commits.length ? commits.join("\n") : "(none)",
    ``,
    `Uncommitted changes about to be folded into the release commit:`,
    pendingFiles.length ? pendingFiles.join("\n") : "(none)",
    ``,
    `Changed files (committed + uncommitted vs ${prevTag ?? "(no previous tag)"}):`,
    diffStat || "(none)",
  ].join("\n");

  return { prevTag, nextTag, range, commits, pendingFiles, diffStat, prompt };
}

/**
 * Hook for an AI-generated release summary. Defaults to a Databricks
 * model-serving call via `aiQuery()`. Returns null on any failure so
 * the caller can fall back to a default tag message.
 */
async function releaseNotes(ctx: ReleaseNotesContext): Promise<string | null> {
  try {
    return await aiQuery(NOTES_INSTRUCTIONS, ctx);
  } catch (error) {
    console.warn("Release notes hook failed, falling back:", error);
    return null;
  }
}

const program = new Command()
  .name("tag")
  .description("Bump every workspace, commit, tag HEAD, and push to origin.")
  .argument(
    "[bump]",
    "version bump (patch | minor | major)",
    (value): Bump => {
      if (value !== "patch" && value !== "minor" && value !== "major") {
        throw new InvalidArgumentError("expected patch, minor, or major");
      }
      return value;
    },
    "patch" as Bump,
  )
  .option("-n, --dry-run", "print everything, write nothing", false)
  .parse(process.argv);

const [bump] = program.processedArgs as [Bump];
const { dryRun } = program.opts<{ dryRun: boolean }>();

const { version: currentVersion, pkgs } = await findPublishables();
const nextVersion = semver.inc(currentVersion, bump);
if (!nextVersion)
  fail(`Cannot ${bump}-bump version "${currentVersion}" (semver.inc returned null)`);
const tag = `v${nextVersion}`;

// The script is permissive about local state: dirty files get folded
// into the release commit and unpushed commits get pushed along with
// it. Dry-run still skips everything that touches disk or the remote.
const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], { capture: true });
const dirty = await git(["status", "--porcelain"], { capture: true });
let ahead = "0";
if (!dryRun) {
  const upstream = await git(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    { capture: true, check: false },
  );
  if (!upstream) {
    fail(
      `Branch ${branch} has no upstream. Push the branch first so the release commit lands on a known ref.`,
    );
  }
  ahead = await git(["rev-list", "--count", `${upstream}..HEAD`], { capture: true });
}

if (
  await git(["rev-parse", "--verify", `refs/tags/${tag}`], {
    capture: true,
    check: false,
  })
) {
  fail(`Tag ${tag} already exists locally. Pick a different bump.`);
}

if (
  await git(["ls-remote", "--tags", "origin", `refs/tags/${tag}`], { capture: true })
) {
  fail(`Tag ${tag} already exists on origin. Pick a different bump.`);
}

const prevTag =
  (await git(["describe", "--tags", "--abbrev=0"], { capture: true, check: false })) ||
  null;

console.log(`Bump:    ${bump}`);
console.log(`Current: ${currentVersion}`);
console.log(`Next:    ${nextVersion}`);
console.log(`Tag:     ${tag}`);
console.log(`Prev:    ${prevTag ?? "(none)"}`);
const headSha = await git(["rev-parse", "--short", "HEAD"], { capture: true });
console.log(`HEAD:    ${headSha} (${branch})`);
console.log(`Packages:`);
for (const p of pkgs) console.log(`  ${p.name}`);
if (dirty) {
  console.log(`Dirty files (will be folded into the release commit):`);
  for (const line of dirty.split("\n")) console.log(`  ${line}`);
}
if (ahead !== "0") {
  console.log(`Unpushed commits: ${ahead} (will be pushed with the release commit)`);
}
console.log();

const notesContext = await buildReleaseNotesContext(prevTag, tag);
let aiSummary: string | null = null;
const hasChanges =
  notesContext.commits.length > 0 || notesContext.pendingFiles.length > 0;
if (!hasChanges) {
  console.log(
    "(skipping release notes: no commits or pending changes since previous tag)",
  );
} else {
  aiSummary = (await releaseNotes(notesContext))?.trim() || null;
}
const tagMessage = aiSummary ? `Release ${tag}\n\n${aiSummary}\n` : `Release ${tag}`;

console.log();
console.log("--- tag message ---");
console.log(tagMessage);
console.log("-------------------");
console.log();

if (dryRun) {
  console.log("--dry-run: skipping write, commit, tag, and push.");
  process.exit(0);
}

console.log(`Writing ${nextVersion} to ${pkgs.length} package.json file(s)...`);
for (const p of pkgs) await writeVersion(p.jsonPath, nextVersion);

console.log(`Committing release ${tag}...`);
await git(["add", "-A"]);
await git(["commit", "-m", `chore: release ${tag}`]);

console.log(`Pushing ${branch}...`);
await git(["push", "origin", branch]);

console.log(`Tagging HEAD as ${tag}...`);
await git(["tag", "-a", tag, "-m", tagMessage]);

console.log(`Pushing ${tag} to origin...`);
await git(["push", "origin", tag]);

console.log();
console.log(`✓ Released ${tag}.`);
console.log("  The Release workflow will fire on the tag push:");
console.log(
  "  https://github.com/reggie-db/dbx-tools-appkit/actions/workflows/release.yml",
);
