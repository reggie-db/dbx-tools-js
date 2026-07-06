/**
 * Download and cache GitHub-hosted skill repositories on disk.
 */

import { commonUtils, logUtils } from "@dbx-tools/shared";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as tar from "tar";

import type { ResolvedSkillSource, SkillsPluginConfig } from "./config.js";
import { applySkillsSubdir, resolveSkillsConfig } from "./config.js";
import { discoverSkillsSubdir } from "./discover-skills-subdir.js";
import { githubArchiveUrl } from "./parse-github.js";
import { withRefreshLock } from "./refresh-lock.js";

const log = logUtils.logger("skills/cache");

const STAMP_FILE = "fetched-at";
const SUBDIR_FILE = "skills-subdir";
const REPO_DIR = "repo";

/** Ensure every configured source is cached and return their skill roots. */
export async function ensureSkillSources(
  config: SkillsPluginConfig,
): Promise<ResolvedSkillSource[]> {
  const resolved = resolveSkillsConfig(config);
  const results: ResolvedSkillSource[] = [];
  for (const source of resolved.sources) {
    await ensureCachedSource(source, resolved.ttlMs);
    results.push(source);
  }
  return results;
}

/** Ensure one source checkout exists and return its repository root path. */
export async function ensureCachedSource(
  source: ResolvedSkillSource,
  ttlMs: number,
): Promise<string> {
  const cacheRoot = source.cacheRoot;
  await mkdir(cacheRoot, { recursive: true });

  const repoPath = join(cacheRoot, REPO_DIR);
  if (await isCacheFresh(source, ttlMs)) {
    await loadCachedSubdir(source, repoPath);
    return repoPath;
  }

  return withRefreshLock(cacheRoot, async () => {
    if (await isCacheFresh(source, ttlMs)) {
      await loadCachedSubdir(source, repoPath);
      return repoPath;
    }
    const repo = `${source.owner}/${source.name}`;
    log.info("refresh:start", { id: source.id, repo, ref: source.ref });
    await downloadAndInstall(source, cacheRoot);
    await writeFile(join(cacheRoot, STAMP_FILE), String(Date.now()), "utf8");
    await finalizeSkillsSubdir(source, repoPath);
    log.info("refresh:done", { id: source.id, repoPath, skillsSubdir: source.skillsSubdir });
    return repoPath;
  });
}

async function loadCachedSubdir(source: ResolvedSkillSource, repoPath: string): Promise<void> {
  const subdir = await resolveSkillsSubdir(source, repoPath);
  applySkillsSubdir(source, subdir);
}

async function finalizeSkillsSubdir(source: ResolvedSkillSource, repoPath: string): Promise<void> {
  const subdir = await resolveSkillsSubdir(source, repoPath);
  applySkillsSubdir(source, subdir);
  await writeFile(join(source.cacheRoot, SUBDIR_FILE), subdir, "utf8");
  await stat(join(repoPath, subdir));
}

async function resolveSkillsSubdir(
  source: ResolvedSkillSource,
  repoPath: string,
): Promise<string> {
  if (source.pinnedSkillsSubdir !== undefined) {
    return source.pinnedSkillsSubdir;
  }
  const metaPath = join(source.cacheRoot, SUBDIR_FILE);
  try {
    const saved = (await readFile(metaPath, "utf8")).trim();
    if (saved) return saved;
  } catch {
    // discover below
  }
  return discoverSkillsSubdir(repoPath);
}

async function isCacheFresh(source: ResolvedSkillSource, ttlMs: number): Promise<boolean> {
  const cacheRoot = source.cacheRoot;
  const stampPath = join(cacheRoot, STAMP_FILE);
  const repoPath = join(cacheRoot, REPO_DIR);
  try {
    const [stampStat, repoStat] = await Promise.all([stat(stampPath), stat(repoPath)]);
    if (!stampStat.isFile() || !repoStat.isDirectory()) return false;
    const fetchedAt = Number.parseInt(await readFile(stampPath, "utf8"), 10);
    if (!Number.isFinite(fetchedAt)) return false;
    return Date.now() - fetchedAt < ttlMs;
  } catch {
    return false;
  }
}

async function downloadAndInstall(
  source: ResolvedSkillSource,
  cacheRoot: string,
): Promise<void> {
  const url = githubArchiveUrl(source.owner, source.name, source.ref);
  const tmpRoot = join(tmpdir(), `skills-${source.id}-${randomUUID()}`);
  const archivePath = join(tmpRoot, "archive.tar.gz");
  const extractDir = join(tmpRoot, "extract");
  await mkdir(extractDir, { recursive: true });

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Failed to download ${source.owner}/${source.name}@${source.ref}: HTTP ${response.status}`,
      );
    }
    await writeFile(archivePath, Buffer.from(await response.arrayBuffer()));

    await tar.x({ file: archivePath, cwd: extractDir });

    const extracted = await findExtractedRoot(extractDir, source.name);
    const repoPath = join(cacheRoot, REPO_DIR);
    await rm(repoPath, { recursive: true, force: true });
    await mkdir(cacheRoot, { recursive: true });
    await renamePath(join(extractDir, extracted), repoPath);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

async function findExtractedRoot(extractDir: string, repoName: string): Promise<string> {
  const entries = await readdir(extractDir);
  const match = entries.find((entry) => entry.startsWith(`${repoName}-`));
  if (!match) {
    throw new Error(
      `Archive for "${repoName}" did not contain an expected top-level directory (${entries.join(", ")})`,
    );
  }
  return match;
}

async function renamePath(from: string, to: string): Promise<void> {
  try {
    const { rename } = await import("node:fs/promises");
    await rename(from, to);
  } catch (err) {
    throw new Error(
      `Failed to move cached repository into place: ${commonUtils.errorMessage(err)}`,
    );
  }
}
