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
//   bun run tag --readme       # also sync package READMEs (off by default)
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
//   `releaseNotes()` runs a Mastra agent via `agentQuery()` from
//   `util.ts`; the agent can call a `read_files` tool to open
//   touched source files (in batches) if the diff stat alone
//   doesn't tell the whole story. If it returns null (no AI available, no Databricks
//   profile, etc.) the script falls back to a bare
//   `Release v<version>` message - no failure.
//
// GitHub Release:
//   After the tag push, the script creates (or updates) a proper
//   GitHub Release for the tag via `gh release create`, using the
//   AI summary as the markdown body. GitHub's tag annotation page
//   renders as plaintext, so the annotated message alone shows up
//   monospaced; the Release object is what renders markdown. Step
//   is skipped silently when `gh` is not on `PATH`.
//
// README sync:
//   Off by default. Pass `--readme` to run `syncReadmes({ upgrade:
//   true })` from `readme.ts` over every publishable package before
//   the release commit is built. The intent is sync-with-code, not
//   fresh regeneration: the agent is told to preserve every section
//   that still matches the source and only rewrite drift. Any
//   resulting edits get auto-staged and folded into the release
//   commit, so the shipped READMEs match the tagged code.

import { which } from "bun";
import { Command, InvalidArgumentError } from "commander";
import semver from "semver";
import { syncReadmes } from "./readme.js";
import { agentQuery, discoverPackages, fail, git, writeJson } from "./util.js";

type Bump = "major" | "minor" | "patch";

/**
 * `git rev-parse <args>`, returning trimmed stdout. Tolerant by
 * design (`disableCheck`): rev-parse exits non-zero when a ref is
 * unknown (e.g. an unset `@{u}` upstream or a missing tag), and every
 * caller here treats "unknown" as an empty string rather than an
 * error.
 */
async function gitRevParse(...args: string[]): Promise<string> {
  return (await git(["rev-parse", ...args], { disableCheck: true })).stdout;
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

The prompt already includes the commit log + working-tree stat. Use
the agent's tools sparingly to fill gaps the summary can't capture:
- read_files on a batch of touched source files when a refactor needs explanation
- git_diff with a path filter to inspect a specific file's diff
- git_log with a path filter to trace recent history of a subdir

Skip the tools when commit subjects already tell the story.

Requirements:
- Be terse
- Group by theme (Features, Fixes, Internals); skip empty sections
- Describe what changed and why it matters, not how the diff looks
- Never cite line counts, diff stats, churn, or file sizes (no
  "~800 lines reworked", "+71 lines", "~1300 lines changed"); the
  stat is context for you only, not content for the notes
- A refactor entry should name the new behavior or structure, not
  quantify the edit
- No preamble
- No closing remarks
- No emojis
- No em dashes

Output the release notes only.`.trim();

/**
 * Build the release-notes prompt from git history + working tree.
 * Async because the underlying `git()` wrapper is async; the
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
    ? (await git(["log", "--no-merges", "--pretty=- %s", range])).stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
  const pendingFiles = (await gitStatus())
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const diffStat = prevTag ? (await git(["diff", "--stat", prevTag])).stdout : "";

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
 * Hook for an AI-generated release summary. Runs the Mastra script
 * agent (which can call `read_files` to inspect touched source) via
 * `agentQuery()`. Returns null on any failure so the caller can
 * fall back to a default tag message.
 */
async function releaseNotes(ctx: ReleaseNotesContext): Promise<string | null> {
  try {
    return await agentQuery(NOTES_INSTRUCTIONS, ctx);
  } catch (error) {
    console.warn("Release notes hook failed, falling back:", error);
    return null;
  }
}

/**
 * Create (or, on retry, update) the GitHub Release for `tag` with
 * `body` as its markdown description. GitHub renders the Release
 * body as markdown, unlike the bare tag annotation page which is
 * monospace plaintext - this is what makes `## Features` etc. show
 * up as real headings instead of literal `##` characters.
 *
 * Silently no-ops when `gh` is not on `PATH`. Failures are logged
 * but never abort the script: the tag is already pushed at this
 * point, so a missing/broken Release can be fixed by hand
 * (`gh release create ... --notes-file <file>`).
 */
async function publishGithubRelease(tag: string, body: string): Promise<void> {
  if (!which("gh")) {
    console.log("(skipping GitHub Release: gh CLI not on PATH)");
    return;
  }
  console.log(`Publishing GitHub Release ${tag}...`);
  const gh = async (args: string[]): Promise<number> => {
    const proc = Bun.spawn(["gh", ...args], {
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });
    return await proc.exited;
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
  console.warn(`gh release create exited ${createCode}; trying gh release edit.`);
  const editCode = await gh(["release", "edit", tag, "--notes", body]);
  if (editCode !== 0) {
    console.warn(
      `gh release edit exited ${editCode}; release may need manual creation.`,
    );
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
  .option(
    "--readme",
    "sync package READMEs with source before the release commit (off by default)",
    false,
  )
  .parse(process.argv);

const [bump] = program.processedArgs as [Bump];
const { dryRun, readme } = program.opts<{
  dryRun: boolean;
  readme: boolean;
}>();

const { version: currentVersion, pkgs } = await findPublishables();
const nextVersion = semver.inc(currentVersion, bump);
if (!nextVersion)
  fail(`Cannot ${bump}-bump version "${currentVersion}" (semver.inc returned null)`);
const tag = `v${nextVersion}`;

// The script is permissive about local state: dirty files get folded
// into the release commit and unpushed commits get pushed along with
// it. Dry-run still skips everything that touches disk or the remote.
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

if (await gitRevParse("--verify", `refs/tags/${tag}`)) {
  fail(`Tag ${tag} already exists locally. Pick a different bump.`);
}

if ((await git(["ls-remote", "--tags", "origin", `refs/tags/${tag}`])).stdout) {
  fail(`Tag ${tag} already exists on origin. Pick a different bump.`);
}

const prevTag =
  (await git(["describe", "--tags", "--abbrev=0"], { disableCheck: true })).stdout ||
  null;

console.log(`Bump:    ${bump}`);
console.log(`Current: ${currentVersion}`);
console.log(`Next:    ${nextVersion}`);
console.log(`Tag:     ${tag}`);
console.log(`Prev:    ${prevTag ?? "(none)"}`);
const headSha = await gitRevParse("--short", "HEAD");
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

// Opt-in via `--readme`: sync READMEs with current source before the
// release commit is built so the shipped docs match the tagged code.
// Runs against every publishable package; the agent preserves accurate
// sections and only rewrites drift.
if (readme) {
  console.log("Syncing READMEs with current source...");
  await syncReadmes({ upgrade: true, dryRun });
  console.log();
}

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
await gitPush(branch);

console.log(`Tagging HEAD as ${tag}...`);
await git(["tag", "-a", tag, "-m", tagMessage]);

console.log(`Pushing ${tag} to origin...`);
await gitPush(tag);

// The annotated tag message shows up as plaintext on GitHub's tag
// page. The Release object renders the same body as markdown.
await publishGithubRelease(tag, aiSummary ?? `Release ${tag}`);

console.log();
console.log(`✓ Released ${tag}.`);
console.log("  The Release workflow will fire on the tag push:");
console.log(
  "  https://github.com/reggie-db/dbx-tools-js/actions/workflows/release.yml",
);
