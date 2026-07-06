import { describe, expect, test } from "bun:test";

import { resolveAiDevKitConfig } from "../src/preset.js";

describe("resolveAiDevKitConfig", () => {
  test("defaults to the AI Dev Kit repository", () => {
    const config = resolveAiDevKitConfig();
    expect(config.sources?.[0]).toBe(
      "databricks-solutions/ai-dev-kit#subdirectory=databricks-skills",
    );
  });

  test("maps legacy repo fields", () => {
    const config = resolveAiDevKitConfig({
      repo: "mastra-ai/skills",
      ref: "main",
      skillsSubdir: "skills",
    });
    expect(config.sources?.[0]).toBe("mastra-ai/skills@main#subdirectory=skills");
  });
});
