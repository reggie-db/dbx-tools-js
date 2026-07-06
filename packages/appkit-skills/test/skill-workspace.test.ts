import { describe, expect, test } from "bun:test";

import { buildSkillsWorkspace } from "../src/workspace.js";
import { primeSkillRuntime, resetSkillRuntime } from "../src/runtime.js";
import { skillWorkspace } from "../src/skill-workspace.js";

describe("skillWorkspace", () => {
  test("returns undefined when the runtime has not been primed", () => {
    resetSkillRuntime();
    expect(skillWorkspace()).toBeUndefined();
  });

  test("returns the primed workspace", async () => {
    resetSkillRuntime();
    const workspace = await buildSkillsWorkspace({
      cacheDir: `${process.env.HOME}/.cache/dbx-tools/skills`,
      sources: [
        {
          github: "databricks-solutions/ai-dev-kit",
          ref: "main",
          skillsSubdir: "databricks-skills",
        },
      ],
    });
    primeSkillRuntime(workspace);
    expect(skillWorkspace()).toBe(workspace);
    resetSkillRuntime();
  });
});
