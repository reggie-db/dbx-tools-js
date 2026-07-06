/**
 * Locate the skills tree inside a cached repository checkout.
 */

import { readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";

const COMMON_SKILL_ROOTS = ["databricks-skills", "skills", ".claude/skills"] as const;

async function hasSkillFolders(dir: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const skillFile = await stat(join(dir, entry.name, "SKILL.md"));
      if (skillFile.isFile()) return true;
    } catch {
      // not a skill folder
    }
  }
  return false;
}

/**
 * Find the subdirectory under `repoPath` that contains skill folders
 * (`<name>/SKILL.md`). Checks common layouts first, then repo root, then
 * every other top-level directory.
 */
export async function discoverSkillsSubdir(repoPath: string): Promise<string> {
  for (const candidate of COMMON_SKILL_ROOTS) {
    if (await hasSkillFolders(join(repoPath, candidate))) {
      return candidate;
    }
  }
  if (await hasSkillFolders(repoPath)) {
    return ".";
  }

  let entries: Dirent[];
  try {
    entries = await readdir(repoPath, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if ((COMMON_SKILL_ROOTS as readonly string[]).includes(entry.name)) continue;
    if (await hasSkillFolders(join(repoPath, entry.name))) {
      return entry.name;
    }
  }

  throw new Error(
    `No Agent Skills tree found under "${repoPath}" (expected a directory of <skill>/SKILL.md folders)`,
  );
}
