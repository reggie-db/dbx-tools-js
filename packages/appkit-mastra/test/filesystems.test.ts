import { describe, expect, test } from "bun:test";
import type { WorkspaceClient } from "@databricks/sdk-experimental";

import {
  DatabricksWorkspaceFilesystem,
  emptyFilesystem,
  isDbfsPath,
  isWorkspaceFilesPath,
  normalizeDatabricksBasePath,
  resolveDatabricksAbsolutePath,
  toDatabricksWorkspacePath,
} from "../src/filesystems.js";

describe("Databricks workspace path helpers", () => {
  const base = "/Volumes/main/default/files";

  test("normalizes base paths", () => {
    expect(normalizeDatabricksBasePath(`${base}/`)).toBe(base);
    expect(isDbfsPath("/dbfs/tmp")).toBe(true);
    expect(isDbfsPath(base)).toBe(false);
    expect(isWorkspaceFilesPath("/Workspace/.assistant")).toBe(true);
    expect(isWorkspaceFilesPath("/Users/alice@example.com/foo")).toBe(true);
  });

  test("resolves workspace-relative paths", () => {
    expect(resolveDatabricksAbsolutePath(base, "/notes.md")).toBe(
      "/Volumes/main/default/files/notes.md",
    );
    expect(resolveDatabricksAbsolutePath(base, "notes.md")).toBe(
      "/Volumes/main/default/files/notes.md",
    );
    expect(resolveDatabricksAbsolutePath(base, "/")).toBe(base);
    expect(
      resolveDatabricksAbsolutePath("/Workspace/.assistant", "/scratch.txt"),
    ).toBe("/Workspace/.assistant/scratch.txt");
  });

  test("maps absolute paths back to workspace paths", () => {
    expect(
      toDatabricksWorkspacePath(base, "/Volumes/main/default/files/notes.md"),
    ).toBe("/notes.md");
    expect(toDatabricksWorkspacePath(base, base)).toBe("/");
  });
});

describe("emptyFilesystem", () => {
  test("exposes only an empty root directory", async () => {
    const fs = emptyFilesystem();
    expect(fs.readOnly).toBe(true);
    expect(await fs.exists("/")).toBe(true);
    expect(await fs.exists("/missing")).toBe(false);
    expect(await fs.readdir("/")).toEqual([]);
    await expect(fs.readFile("/notes.md")).rejects.toThrow();
    await expect(fs.writeFile("/notes.md", "hi")).rejects.toThrow();
  });
});

describe("DatabricksWorkspaceFilesystem optional base path", () => {
  test("returns an empty namespace when the base path is missing", async () => {
    const client = {
      workspace: {
        getStatus: async () => {
          throw new Error("Path does not exist");
        },
      },
    } as unknown as WorkspaceClient;

    const fs = new DatabricksWorkspaceFilesystem({
      client,
      basePath: "/Workspace/.assistant/skills",
      readOnly: true,
    });

    await fs.init();
    expect(await fs.readdir("/")).toEqual([]);
    expect(await fs.exists("/")).toBe(true);
    expect(await fs.exists("/demo-skill/SKILL.md")).toBe(false);
  });

  test("fails init when requireBasePath is true and the base path is missing", async () => {
    const client = {
      workspace: {
        getStatus: async () => {
          throw new Error("Path does not exist");
        },
      },
    } as unknown as WorkspaceClient;

    const fs = new DatabricksWorkspaceFilesystem({
      client,
      basePath: "/Workspace/.assistant/skills",
      readOnly: true,
      requireBasePath: true,
    });

    await expect(fs.init()).rejects.toThrow();
  });
});
