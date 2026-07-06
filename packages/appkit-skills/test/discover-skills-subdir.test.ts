import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { discoverSkillsSubdir } from "../src/discover-skills-subdir.js";

describe("discoverSkillsSubdir", () => {
  test("finds databricks-skills layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "skills-discover-"));
    try {
      const skillsRoot = join(root, "databricks-skills", "sample-skill");
      await mkdir(skillsRoot, { recursive: true });
      await writeFile(join(skillsRoot, "SKILL.md"), "# Sample\n", "utf8");
      expect(await discoverSkillsSubdir(root)).toBe("databricks-skills");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("finds skills at repo root", async () => {
    const root = await mkdtemp(join(tmpdir(), "skills-discover-"));
    try {
      const skillsRoot = join(root, "root-skill");
      await mkdir(skillsRoot, { recursive: true });
      await writeFile(join(skillsRoot, "SKILL.md"), "# Root\n", "utf8");
      expect(await discoverSkillsSubdir(root)).toBe(".");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
