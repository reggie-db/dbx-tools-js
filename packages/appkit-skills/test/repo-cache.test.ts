import { describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DEFAULT_CACHE_TTL_MS } from "../src/config.js";
import { ensureSkillSources } from "../src/repo-cache.js";

describe("ensureSkillSources", () => {
  test("reuses a fresh cache without downloading", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "skills-test-"));
    const sourceId = "databricks-solutions-ai-dev-kit";
    const repoPath = join(cacheDir, sourceId, "repo");
    const skillsPath = join(repoPath, "databricks-skills");
    await mkdir(skillsPath, { recursive: true });
    await writeFile(join(cacheDir, sourceId, "fetched-at"), String(Date.now()), "utf8");
    await writeFile(join(cacheDir, sourceId, "skills-subdir"), "databricks-skills", "utf8");

    const sources = await ensureSkillSources({
      cacheDir,
      ttlMs: DEFAULT_CACHE_TTL_MS,
      sources: ["databricks-solutions/ai-dev-kit"],
    });
    expect(sources[0]?.skillsSubdir).toBe("databricks-skills");
    await rm(cacheDir, { recursive: true, force: true });
  });

  test("downloads and auto-discovers the skills tree", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "skills-test-"));
    try {
      const sources = await ensureSkillSources({
        cacheDir,
        ttlMs: DEFAULT_CACHE_TTL_MS,
        sources: ["databricks-solutions/ai-dev-kit"],
      });
      expect(sources[0]?.skillsSubdir).toBe("databricks-skills");
      const stamp = Number.parseInt(
        await readFile(
          join(cacheDir, "databricks-solutions-ai-dev-kit", "fetched-at"),
          "utf8",
        ),
        10,
      );
      expect(Number.isFinite(stamp)).toBe(true);
      await access(
        join(
          cacheDir,
          "databricks-solutions-ai-dev-kit",
          "repo",
          "databricks-skills",
          "databricks-bundles",
          "SKILL.md",
        ),
        constants.F_OK,
      );
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  }, 120_000);
});
