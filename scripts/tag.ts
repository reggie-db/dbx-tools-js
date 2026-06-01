#!/usr/bin/env bun
// Tag the current HEAD with `v<version>` and push the tag to origin.
// The tag push fires `.github/workflows/release.yml` which builds
// every publishable workspace and runs `bunx changeset publish`.
//
// Workflow:
//   bun changeset                          # record changeset
//   bun run version                        # bump versions + CHANGELOG
//   git commit -am "chore: version packages"
//   git push origin main
//   bun run tag                            # this script
//
// All `@dbx-tools/*` packages are version-fixed via
// `.changeset/config.json`, so they always share one version - we
// read it from the first publishable package and assume it's the
// same everywhere.
//
// Safety checks before tagging:
//   1. Working tree must be clean (refuses on staged or unstaged
//      changes so the tag points at a real, pushed commit).
//   2. HEAD must already be pushed to origin (refuses if the local
//      ref is ahead of `origin/HEAD`).
//   3. Tag must not already exist locally or on the remote.
//
// Flags:
//   --dry-run / -n     Print what would happen without executing
//                      `git tag` or `git push`.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGES_DIR = resolve(ROOT, "packages");

interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function run(args: string[], opts: { capture?: boolean; check?: boolean } = {}): string {
  const result = spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (opts.check !== false && result.status !== 0) {
    fail(`git ${args.join(" ")} failed (exit ${result.status}): ${result.stderr ?? ""}`);
  }
  return (result.stdout ?? "").trim();
}

function findPublishableVersion(): string {
  const versions: { name: string; version: string }[] = [];
  for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const jsonPath = resolve(PACKAGES_DIR, entry.name, "package.json");
    if (!existsSync(jsonPath)) continue;
    const meta = JSON.parse(readFileSync(jsonPath, "utf8")) as PackageJson;
    if (meta.private === true) continue;
    if (!meta.name || !meta.version) continue;
    versions.push({ name: meta.name, version: meta.version });
  }
  if (versions.length === 0) {
    fail("No publishable packages found under packages/");
  }
  // All @dbx-tools/* packages are version-fixed - sanity check they
  // really do match so we don't tag the wrong number by accident.
  const unique = new Set(versions.map((v) => v.version));
  if (unique.size > 1) {
    fail(
      `Publishable packages disagree on version (expected one fixed version):\n` +
        versions.map((v) => `  ${v.name}@${v.version}`).join("\n"),
    );
  }
  return versions[0]!.version;
}

const dryRun = process.argv.slice(2).some((arg) => arg === "--dry-run" || arg === "-n");

const version = findPublishableVersion();
const tag = `v${version}`;

const dirty = run(["status", "--porcelain"], { capture: true });
if (dirty) {
  fail(
    `Working tree is dirty. Commit (or stash) version-bump changes before tagging:\n${dirty}`,
  );
}

const branch = run(["rev-parse", "--abbrev-ref", "HEAD"], { capture: true });
const upstream = run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
  capture: true,
  check: false,
});
if (!upstream) {
  fail(`Branch ${branch} has no upstream. Push the branch first so the tag points at a pushed commit.`);
}
const ahead = run(["rev-list", "--count", `${upstream}..HEAD`], { capture: true });
if (ahead !== "0") {
  fail(
    `HEAD is ${ahead} commit(s) ahead of ${upstream}. Push first:\n  git push origin ${branch}`,
  );
}

const localTag = spawnSync("git", ["rev-parse", "--verify", `refs/tags/${tag}`], {
  cwd: ROOT,
  stdio: "ignore",
});
if (localTag.status === 0) {
  fail(`Tag ${tag} already exists locally. Delete it first if you want to retag: git tag -d ${tag}`);
}

const remoteTag = run(["ls-remote", "--tags", "origin", `refs/tags/${tag}`], { capture: true });
if (remoteTag) {
  fail(`Tag ${tag} already exists on origin. Pick a new version (bun changeset version) first.`);
}

console.log(`Version: ${version}`);
console.log(`Tag:     ${tag}`);
console.log(`HEAD:    ${run(["rev-parse", "--short", "HEAD"], { capture: true })} (${branch})`);
console.log();

if (dryRun) {
  console.log("--dry-run: skipping `git tag` + `git push`.");
  process.exit(0);
}

console.log(`Tagging HEAD as ${tag}...`);
run(["tag", "-a", tag, "-m", `Release ${tag}`]);

console.log(`Pushing ${tag} to origin...`);
run(["push", "origin", tag]);

console.log();
console.log(`✓ Pushed ${tag}.`);
console.log("  The Release workflow will fire on the tag push:");
console.log(`  https://github.com/reggie-db/dbx-tools-appkit/actions/workflows/release.yml`);
