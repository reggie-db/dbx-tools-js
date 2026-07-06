import { describe, expect, test } from "bun:test";

import { parseGithubRef, githubArchiveUrl } from "../src/parse-github.js";

describe("parseGithubRef", () => {
  test("parses owner/repo shorthand without pinning subdir", () => {
    expect(parseGithubRef("databricks-solutions/ai-dev-kit")).toEqual({
      owner: "databricks-solutions",
      name: "ai-dev-kit",
      ref: "main",
      skillsSubdir: undefined,
    });
  });

  test("parses owner/repo@ref", () => {
    expect(parseGithubRef("mastra-ai/skills@v2")).toEqual({
      owner: "mastra-ai",
      name: "skills",
      ref: "v2",
      skillsSubdir: undefined,
    });
  });

  test("parses owner/repo#subdirectory=path", () => {
    expect(
      parseGithubRef("databricks-solutions/ai-dev-kit#subdirectory=databricks-skills"),
    ).toEqual({
      owner: "databricks-solutions",
      name: "ai-dev-kit",
      ref: "main",
      skillsSubdir: "databricks-skills",
    });
  });

  test("parses owner/repo@ref#subdirectory=path", () => {
    expect(
      parseGithubRef("databricks-solutions/ai-dev-kit@develop#subdirectory=databricks-skills"),
    ).toEqual({
      owner: "databricks-solutions",
      name: "ai-dev-kit",
      ref: "develop",
      skillsSubdir: "databricks-skills",
    });
  });

  test("parses github.com owner/repo.git@tag#subdirectory=path", () => {
    expect(
      parseGithubRef(
        "github.com/example/monorepo.git@v1.2.0#subdirectory=python/sdk",
      ),
    ).toEqual({
      owner: "example",
      name: "monorepo",
      ref: "v1.2.0",
      skillsSubdir: "python/sdk",
    });
  });

  test("accepts bare #path as subdir shorthand", () => {
    expect(parseGithubRef("owner/repo#skills")).toEqual({
      owner: "owner",
      name: "repo",
      ref: "main",
      skillsSubdir: "skills",
    });
  });

  test("parses github.com URLs with tree path", () => {
    expect(
      parseGithubRef(
        "https://github.com/databricks-solutions/ai-dev-kit/tree/main/databricks-skills",
      ),
    ).toEqual({
      owner: "databricks-solutions",
      name: "ai-dev-kit",
      ref: "main",
      skillsSubdir: "databricks-skills",
    });
  });

  test("parses github: shorthand", () => {
    expect(parseGithubRef("github:anthropics/skills@main")).toEqual({
      owner: "anthropics",
      name: "skills",
      ref: "main",
      skillsSubdir: undefined,
    });
  });
});

describe("githubArchiveUrl", () => {
  test("builds branch archive URLs", () => {
    expect(githubArchiveUrl("owner", "repo", "main")).toBe(
      "https://github.com/owner/repo/archive/refs/heads/main.tar.gz",
    );
  });
});
