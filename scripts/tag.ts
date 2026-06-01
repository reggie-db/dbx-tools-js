#!/usr/bin/env bun
// Bump the version on every publishable workspace, commit the bump,
// then tag HEAD with `v<version>` and push both the commit and the tag
// to origin. The tag push fires `.github/workflows/release.yml`, which
// builds every publishable workspace and runs `bunx changeset publish`.
//
// Usage:
//   bun run tag                # patch bump (default)
//   bun run tag patch          # patch bump
//   bun run tag minor          # minor bump
//   bun run tag major          # major bump
//   bun run tag --dry-run      # print everything, write nothing
//
// All `@dbx-tools/*` packages are version-fixed via
// `.changeset/config.json`, so they always share one version - we
// read it from the first publishable package, sanity-check that the
// rest agree, then bump the shared version everywhere.
//
// Safety checks before tagging:
//   1. Working tree must be clean (so the release commit only carries
//      the version bump, nothing stray).
//   2. HEAD must already be pushed to origin (so the new commit lands
//      cleanly on top of a known-good ref).
//   3. New tag must not already exist locally or on the remote.
//
// Tag message:
//   The script collects commit log + diff stat since the previous tag
//   and builds a ready-to-send prompt, then hands the whole context to
//   `releaseNotes()`. That function is a stub - plug in whatever model
//   you want (cursor, openai, claude, local, ...). If it returns a
//   string, it becomes the annotated tag's message body. If it returns
//   null (the default), the script falls back to a bare
//   `Release v<version>` message - no prompt, no failure.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import pMemoize from "p-memoize";
import { Config, serving, WorkspaceClient } from "@databricks/sdk-experimental";
type Bump = "major" | "minor" | "patch";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGES_DIR = resolve(ROOT, "packages");

const getWorkspaceClient = pMemoize(async () => {
  return new WorkspaceClient({});
});

interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
}

interface PublishablePackage {
  name: string;
  version: string;
  path: string;
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function run(
  args: string[],
  opts: { capture?: boolean; check?: boolean } = {},
): string {
  const result = spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (opts.check !== false && result.status !== 0) {
    fail(
      `git ${args.join(" ")} failed (exit ${result.status}): ${result.stderr ?? ""}`,
    );
  }
  return (result.stdout ?? "").trim();
}

function parseArgs(argv: string[]): { bump: Bump; dryRun: boolean } {
  let bump: Bump = "patch";
  let dryRun = false;
  let bumpSeen = false;
  for (const arg of argv) {
    if (arg === "--dry-run" || arg === "-n") {
      dryRun = true;
      continue;
    }
    if (arg === "patch" || arg === "minor" || arg === "major") {
      if (bumpSeen) fail(`Bump argument given twice: ${arg}`);
      bump = arg;
      bumpSeen = true;
      continue;
    }
    fail(
      `Unknown argument: ${arg}. Expected one of: patch | minor | major | --dry-run`,
    );
  }
  return { bump, dryRun };
}

function findPublishablePackages(): PublishablePackage[] {
  const pkgs: PublishablePackage[] = [];
  for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const jsonPath = resolve(PACKAGES_DIR, entry.name, "package.json");
    if (!existsSync(jsonPath)) continue;
    const meta = JSON.parse(readFileSync(jsonPath, "utf8")) as PackageJson;
    if (meta.private === true) continue;
    if (!meta.name || !meta.version) continue;
    pkgs.push({ name: meta.name, version: meta.version, path: jsonPath });
  }
  if (pkgs.length === 0) {
    fail("No publishable packages found under packages/");
  }
  const unique = new Set(pkgs.map((p) => p.version));
  if (unique.size > 1) {
    fail(
      `Publishable packages disagree on version (expected one fixed version):\n` +
        pkgs.map((p) => `  ${p.name}@${p.version}`).join("\n"),
    );
  }
  return pkgs;
}

function bumpVersion(current: string, bump: Bump): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(current);
  if (!match) fail(`Cannot parse version: ${current}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function writeVersion(jsonPath: string, nextVersion: string): void {
  const raw = readFileSync(jsonPath, "utf8");
  const trailingNewline = raw.endsWith("\n");
  const meta = JSON.parse(raw) as PackageJson;
  meta.version = nextVersion;
  const next = JSON.stringify(meta, null, 2) + (trailingNewline ? "\n" : "");
  writeFileSync(jsonPath, next);
}

interface ReleaseNotesContext {
  /** Previous tag to diff against, or null if this is the first tag. */
  prevTag: string | null;
  /** The tag that will be created (e.g. `v0.2.0`). */
  nextTag: string;
  /** Git rev range used for log/diff (e.g. `v0.1.0..HEAD`), or null if no prev tag. */
  range: string | null;
  /** One-line commit subjects since `prevTag`, no merges. Empty if nothing to summarize. */
  commits: string[];
  /** Raw `git diff --stat <range>` output. Empty if no range. */
  diffStat: string;
  /** Ready-to-send prompt assembled from the fields above. */
  prompt: string;
}

/**
 * Hook for an AI-generated release summary. Receives the prepared
 * commit log, diff stat, and a pre-built prompt; returns the body to
 * append to the annotated tag message, or null to skip and use the
 * default `Release v<version>` message.
 *
 * Implementation is intentionally left out so this script doesn't pull
 * in any particular model SDK. Plug in your model of choice (cursor
 * CLI, OpenAI, Claude, local llama, ...) and return the raw markdown.
 * If anything goes wrong, catch internally and return null.
 */
async function releaseNotes(
  ctx: ReleaseNotesContext,
  model?: string,
): Promise<string | null> {
  const prompt = `
  Generate markdown release notes for the following tag.
  
  Requirements:
  - Be terse
  - No preamble
  - No closing remarks
  - No emojis
  - No em dashes
  
  Output the release notes only.

  Context:
  ${JSON.stringify(ctx)}`.trim();
  const client = await getWorkspaceClient();
  const response = await client.servingEndpoints.query({
    name: model ?? "databricks-claude-opus-4-6",
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });
  return parseResponse(response);
}

function parseResponse(response: serving.QueryEndpointResponse): string | null {
  const content = response?.choices?.[0]?.message?.content;
  return content || null;
}

function buildReleaseNotesContext(
  prevTag: string | null,
  nextTag: string,
): ReleaseNotesContext {
  const range = prevTag ? `${prevTag}..HEAD` : null;
  const commits = range
    ? run(["log", "--no-merges", "--pretty=- %s", range], { capture: true })
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
  const diffStat = range ? run(["diff", "--stat", range], { capture: true }) : "";

  const prompt = [
    `Write concise release notes for ${nextTag} as a short markdown bulleted list grouped by theme (Features, Fixes, Internals). Skip any section with no entries.`,
    `Be terse. No preamble, no closing remarks, no emojis, no em dashes. Output the notes only.`,
    ``,
    `Commits since ${prevTag ?? "(no previous tag)"}:`,
    commits.length ? commits.join("\n") : "(none)",
    ``,
    `Changed files:`,
    diffStat || "(none)",
  ].join("\n");

  return { prevTag, nextTag, range, commits, diffStat, prompt };
}

const { bump, dryRun } = parseArgs(process.argv.slice(2));

const pkgs = findPublishablePackages();
const currentVersion = pkgs[0]!.version;
const nextVersion = bumpVersion(currentVersion, bump);
const tag = `v${nextVersion}`;

// Dirty + ahead-of-upstream checks only matter when we're about to
// actually commit and push. Dry-run is read-only, so skip them so the
// user can preview the next version, tag, and release notes even with
// edits in flight or unpushed commits.
const branch = run(["rev-parse", "--abbrev-ref", "HEAD"], { capture: true });
if (!dryRun) {
  const dirty = run(["status", "--porcelain"], { capture: true });
  if (dirty) {
    fail(
      `Working tree is dirty. Commit (or stash) outstanding changes before tagging:\n${dirty}`,
    );
  }

  const upstream = run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
    capture: true,
    check: false,
  });
  if (!upstream) {
    fail(
      `Branch ${branch} has no upstream. Push the branch first so the release commit lands on a known ref.`,
    );
  }
  const ahead = run(["rev-list", "--count", `${upstream}..HEAD`], { capture: true });
  if (ahead !== "0") {
    fail(
      `HEAD is ${ahead} commit(s) ahead of ${upstream}. Push first:\n  git push origin ${branch}`,
    );
  }
}

const localTag = spawnSync("git", ["rev-parse", "--verify", `refs/tags/${tag}`], {
  cwd: ROOT,
  stdio: "ignore",
});
if (localTag.status === 0) {
  fail(`Tag ${tag} already exists locally. Pick a different bump.`);
}

const remoteTag = run(["ls-remote", "--tags", "origin", `refs/tags/${tag}`], {
  capture: true,
});
if (remoteTag) {
  fail(`Tag ${tag} already exists on origin. Pick a different bump.`);
}

const prevTag =
  run(["describe", "--tags", "--abbrev=0"], { capture: true, check: false }) || null;

console.log(`Bump:    ${bump}`);
console.log(`Current: ${currentVersion}`);
console.log(`Next:    ${nextVersion}`);
console.log(`Tag:     ${tag}`);
console.log(`Prev:    ${prevTag ?? "(none)"}`);
console.log(
  `HEAD:    ${run(["rev-parse", "--short", "HEAD"], { capture: true })} (${branch})`,
);
console.log(`Packages:`);
for (const p of pkgs) console.log(`  ${p.name}`);
console.log();

const notesContext = buildReleaseNotesContext(prevTag, tag);
let aiSummary: string | null = null;
if (notesContext.commits.length === 0) {
  console.log("(skipping release notes: no commits between previous tag and HEAD)");
} else {
  try {
    aiSummary = (await releaseNotes(notesContext))?.trim() || null;
  } catch (error) {
    console.warn("Error generating release notes:", error);
    aiSummary = null;
  }
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
for (const p of pkgs) writeVersion(p.path, nextVersion);

console.log(`Committing release ${tag}...`);
run(["add", ...pkgs.map((p) => p.path)]);
run(["commit", "-m", `chore: release ${tag}`]);

console.log(`Pushing ${branch}...`);
run(["push", "origin", branch]);

console.log(`Tagging HEAD as ${tag}...`);
run(["tag", "-a", tag, "-m", tagMessage]);

console.log(`Pushing ${tag} to origin...`);
run(["push", "origin", tag]);

console.log();
console.log(`✓ Released ${tag}.`);
console.log("  The Release workflow will fire on the tag push:");
console.log(
  `  https://github.com/reggie-db/dbx-tools-appkit/actions/workflows/release.yml`,
);
