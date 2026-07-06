// Bump every publishable workspace to the next version, commit the
// bump, then tag HEAD with `v<version>` and push both the commit and
// the tag to origin. The tag push fires the repo's release workflow,
// which builds every publishable workspace and runs the publish step.
//
// After pushing the tag, it creates a GitHub Release. The body is
// written by `cursor-agent` (the Cursor CLI) from the commits + diff
// stat since the previous tag when that CLI is installed; otherwise it
// falls back to a deterministic grouping of the commits by
// conventional-commit type. See `buildNotes` / `releaseNotes`.
// Pass `--notes-since v0.1.75` (or bare `0.1.75`) when several recent
// tags failed to publish and notes should cover everything since the
// last good release instead of only since the latest tag.
//
// After pushing, the function can also run the workspace publish script
// so local release flows use the same Bun-based package publishing path
// as CI. Before publishing it refreshes the (gitignored) lockfile with
// `bun install` so `bun publish` resolves each `workspace:*` sibling pin
// to the just-bumped version instead of a stale one left over from a
// previous release. Opt out with `publish: false`.
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
import { fail, errorMessage, nonEmptyLines } from "./script.js";
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
  /**
   * Tag (or bare version) to use as the release-notes baseline instead
   * of the latest git tag - e.g. `v0.1.75` or `0.1.75` when several
   * recent tags failed to publish and notes should cover everything
   * since the last good release.
   */
  notesSince?: string;
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
 * Normalize a release-notes baseline to a tag name. Accepts `v0.1.75`
 * or bare `0.1.75`.
 */
function normalizeNotesSinceTag(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) fail("--notes-since: value must not be empty");
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

/** Resolve and verify a `--notes-since` tag exists locally. */
async function resolveNotesSinceTag(raw: string): Promise<string> {
  const tagName = normalizeNotesSinceTag(raw);
  if (!(await gitRevParse("--verify", `refs/tags/${tagName}`))) {
    fail(
      `--notes-since: tag ${tagName} does not exist locally (fetch tags or pick another baseline)`,
    );
  }
  return tagName;
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
 * Conventional-commit type buckets, in the order they appear in the
 * generated notes. Each subject line is matched against these prefixes
 * (`feat:`, `fix(scope):`, `feat!:`, ...); anything unmatched lands in
 * the trailing "Other" section.
 */
const NOTE_SECTIONS: readonly [title: string, match: RegExp][] = [
  ["Features", /^feat(\(.+\))?!?:\s*/i],
  ["Fixes", /^fix(\(.+\))?!?:\s*/i],
  ["Performance", /^perf(\(.+\))?!?:\s*/i],
  ["Refactors", /^refactor(\(.+\))?!?:\s*/i],
  ["Documentation", /^docs(\(.+\))?!?:\s*/i],
  ["Tests", /^test(\(.+\))?!?:\s*/i],
  ["Build & CI", /^(build|ci)(\(.+\))?!?:\s*/i],
  ["Chores", /^chore(\(.+\))?!?:\s*/i],
];
const OTHER_SECTION = "Other";

/**
 * Build a markdown release-notes body from the commits in
 * `<prevTag>..HEAD` (or the whole history when there's no previous
 * tag), grouped by conventional-commit type. The `chore: release
 * v<x>` commit this run creates is filtered out, and a compare link is
 * appended when the repo slug and a previous tag are both known.
 *
 * Used as the GitHub Release description (which renders markdown).
 */
async function releaseNotes(
  prevTag: string | null,
  tagName: string,
  repo: string | null,
): Promise<string> {
  const range = prevTag ? `${prevTag}..HEAD` : "HEAD";
  const raw = (
    await git(["log", range, "--no-merges", "--pretty=format:%h\t%s"], {
      nothrow: true,
    })
  ).stdout;

  const buckets = new Map<string, string[]>();
  for (const line of nonEmptyLines(raw)) {
    const tab = line.indexOf("\t");
    const hash = tab === -1 ? "" : line.slice(0, tab);
    const subject = tab === -1 ? line : line.slice(tab + 1);
    // Drop the release commit this run just created - it's noise.
    if (/^chore: release v/i.test(subject)) continue;
    const section =
      NOTE_SECTIONS.find(([, re]) => re.test(subject))?.[0] ?? OTHER_SECTION;
    const entry = hash ? `- ${subject} (${hash})` : `- ${subject}`;
    (buckets.get(section) ?? buckets.set(section, []).get(section)!).push(entry);
  }

  const parts: string[] = [];
  for (const [title] of [...NOTE_SECTIONS, [OTHER_SECTION] as const]) {
    const lines = buckets.get(title);
    if (lines?.length) parts.push(`### ${title}\n${lines.join("\n")}`);
  }

  let body: string;
  if (parts.length > 0) {
    body = parts.join("\n\n");
  } else if (prevTag) {
    // No descriptive commits (e.g. the work was folded straight into
    // the `chore: release` commit). Fall back to a one-line diff summary
    // so the note still says something concrete.
    const stat = (
      await git(["diff", "--shortstat", `${prevTag}..HEAD`], { nothrow: true })
    ).stdout.trim();
    body = stat
      ? `No conventional-commit entries since ${prevTag}.\n\nChanges: ${stat}.`
      : "_No changes since the previous tag._";
  } else {
    body = "_Initial release._";
  }
  if (repo && prevTag) {
    body += `\n\n**Full changelog**: https://github.com/${repo}/compare/${prevTag}...${tagName}`;
  }
  return body;
}

/**
 * Run `cursor-agent` in non-interactive print mode to turn `prompt`
 * into text. Returns the trimmed final answer, or `null` when the CLI
 * is absent, errors, times out, or produces nothing - so callers can
 * fall back. Spawned via `Bun.spawn` with an `AbortSignal` timeout
 * because print mode can otherwise hang and block the whole release.
 */
async function cursorSummary(
  prompt: string,
  timeoutMs = 120_000,
): Promise<string | null> {
  if (!Bun.which("cursor-agent")) return null;
  consola.log(
    `Running cursor-agent to draft release notes (timeout ${Math.round(timeoutMs / 1000)}s)...`,
  );
  try {
    const proc = Bun.spawn(
      ["cursor-agent", "-p", "--output-format", "text", "--force", prompt],
      { stdout: "pipe", stderr: "ignore", signal: AbortSignal.timeout(timeoutMs) },
    );
    const text = (await new Response(proc.stdout).text()).trim();
    const code = await proc.exited;
    if (code === 0 && text) return text;
    consola.warn(
      `cursor-agent finished without usable notes (exit ${code}${text ? "" : ", empty output"}).`,
    );
    return null;
  } catch (err) {
    consola.warn(`cursor-agent failed: ${errorMessage(err)}`);
    return null;
  }
}

/**
 * Ask `cursor-agent` to write the release notes for `<prevTag>..HEAD`,
 * feeding it the commit subjects and per-file diff stat as context so
 * it never has to explore the tree. Returns `null` (caller falls back
 * to {@link releaseNotes}) when the CLI is unavailable, there's nothing
 * to summarize, or the agent fails.
 */
async function cursorReleaseNotes(
  prevTag: string | null,
  tagName: string,
  repo: string | null,
): Promise<string | null> {
  if (!Bun.which("cursor-agent")) return null;
  const range = prevTag ? `${prevTag}..HEAD` : "HEAD";
  const log = (
    await git(["log", range, "--no-merges", "--pretty=format:- %s"], { nothrow: true })
  ).stdout;
  const stat = (await git(["diff", "--stat", range], { nothrow: true })).stdout;
  if (!log && !stat) return null;

  const prompt = [
    `Write release notes in Markdown for version ${tagName} of this TypeScript monorepo`,
    prevTag ? `, covering the changes since ${prevTag}.` : ".",
    `\n\nRules:`,
    `\n- Output ONLY the release-notes markdown - no preamble, no surrounding code fences, do not modify any files.`,
    `\n- Group changes under short \`###\` headings (e.g. Features, Fixes, Internal).`,
    `\n- One concise bullet per notable change, user-facing and in the present tense.`,
    `\n- Ignore noise: version-bump / "chore: release" commits, lockfile churn, generated output.`,
    `\n\nCommit subjects:\n${log || "(none)"}`,
    `\n\nFile change summary:\n${stat || "(none)"}`,
  ].join("");

  const body = await cursorSummary(prompt);
  if (!body) return null;
  return repo && prevTag
    ? `${body}\n\n**Full changelog**: https://github.com/${repo}/compare/${prevTag}...${tagName}`
    : body;
}

/**
 * Build the release-notes body, preferring a `cursor-agent`-written
 * summary and falling back to the deterministic commit grouping. The
 * returned `source` is just for logging which generator was used.
 */
async function buildNotes(
  prevTag: string | null,
  tagName: string,
  repo: string | null,
): Promise<{ body: string; source: "cursor-agent" | "commits" }> {
  if (Bun.which("cursor-agent")) {
    consola.log(`Generating release notes for ${tagName} with cursor-agent...`);
  } else {
    consola.log(`Generating release notes for ${tagName} from commits...`);
  }
  const ai = await cursorReleaseNotes(prevTag, tagName, repo);
  if (ai) return { body: ai, source: "cursor-agent" };
  if (Bun.which("cursor-agent")) {
    consola.log("Falling back to commit-grouped release notes...");
  }
  return { body: await releaseNotes(prevTag, tagName, repo), source: "commits" };
}

/**
 * Version-bump every publishable workspace, commit, tag, push, create
 * the GitHub Release (with generated notes), and publish to the local
 * registry. See the file header for the full local-state policy.
 */
export async function tag(opts: TagOptions = {}): Promise<void> {
  const { bump = "patch", dryRun = false, publish = true, notesSince } = opts;

  // Tagging commits, tags, and pushes - all of which need git and a
  // repo. Fail upfront with a clear message rather than partway through.
  await requireGitRepo("devkit tag");

  const { repo } = await getDevkitConfig();
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

  const latestTag =
    (await git(["describe", "--tags", "--abbrev=0"], { nothrow: true })).stdout || null;
  const notesSinceTag = notesSince
    ? await resolveNotesSinceTag(notesSince)
    : latestTag;

  consola.log(`Bump:    ${bump}`);
  consola.log(`Current: ${currentVersion}`);
  consola.log(`Next:    ${nextVersion}`);
  consola.log(`Tag:     ${tagName}`);
  consola.log(`Latest tag: ${latestTag ?? "(none)"}`);
  consola.log(
    `Notes since: ${notesSinceTag ?? "(none)"}` +
      (notesSince ? " (--notes-since)" : ""),
  );
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
    const preview = await buildNotes(notesSinceTag, tagName, repo);
    consola.log(`Release notes preview (${preview.source}):`);
    consola.log(preview.body);
    consola.log("");
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

  const notes = await buildNotes(notesSinceTag, tagName, repo);
  consola.log(`Release notes ready (${notes.source}):`);
  consola.log(notes.body);
  consola.log("");
  await publishGithubRelease(tagName, notes.body);

  // Publish via the repo's Bun-based release script. Best-effort: the tag
  // is already pushed, so a publish failure is a warning, not a failure.
  if (publish) {
    // Refresh the (gitignored) lockfile so its recorded workspace
    // versions match the bump before publishing. `bun publish` resolves
    // each `workspace:*` sibling pin from the lockfile, so a stale one
    // would freeze published siblings at the previous version. Not
    // `--frozen-lockfile`: the lockfile is intentionally uncommitted, so
    // there is nothing to freeze against. If the refresh fails, skip the
    // local publish rather than shipping stale pins - CI publishes from
    // the pushed tag regardless.
    consola.log("Refreshing bun.lock to the bumped versions before local publish...");
    const install = await sh(["bun", "install"], { nothrow: true });
    if (install.exitCode !== 0) {
      consola.warn(
        "bun install failed; skipping local publish so stale sibling pins aren't shipped. CI will publish from the tag.",
      );
    } else {
      consola.log("Publishing packages to the local registry (bun run release)...");
      await sh(["bun", "run", "release"], { nothrow: true });
    }
  }

  consola.log("");
  consola.log(`Released ${tagName}.`);
  if (repo) {
    consola.log("  The Release workflow will fire on the tag push:");
    consola.log(`  https://github.com/${repo}/actions/workflows/release.yml`);
  } else {
    consola.log("  The Release workflow will fire on the tag push.");
  }
}
