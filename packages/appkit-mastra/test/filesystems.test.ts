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
  test("attempts mkdir when the base path is missing, even when read-only", async () => {
    let mkdirCalls = 0;
    const client = {
      workspace: {
        getStatus: async () => {
          throw new Error("Path does not exist");
        },
        mkdirs: async () => {
          mkdirCalls++;
          throw new Error("permission denied");
        },
      },
    } as unknown as WorkspaceClient;

    const fs = new DatabricksWorkspaceFilesystem({
      client,
      basePath: "/Workspace/.assistant/skills",
      readOnly: true,
    });

    await fs.init();
    expect(mkdirCalls).toBe(1);
    expect(await fs.readdir("/")).toEqual([]);
    expect(await fs.exists("/")).toBe(true);
    expect(await fs.exists("/demo-skill/SKILL.md")).toBe(false);
  });

  test("creates a missing base path for read-only mounts when mkdir succeeds", async () => {
    let mkdirCalls = 0;
    const client = {
      workspace: {
        getStatus: async () => {
          throw new Error("Path does not exist");
        },
        mkdirs: async () => {
          mkdirCalls++;
        },
        list: async function* () {},
      },
    } as unknown as WorkspaceClient;

    const fs = new DatabricksWorkspaceFilesystem({
      client,
      basePath: "/Workspace/.assistant/skills",
      readOnly: true,
    });

    await fs.init();
    expect(mkdirCalls).toBe(1);
    expect(fs.readOnly).toBe(true);
    expect(await fs.readdir("/")).toEqual([]);
  });

  test("returns an empty namespace when mkdirs try fails", async () => {
    const client = {
      workspace: {
        getStatus: async () => {
          throw new Error("Path does not exist");
        },
        mkdirs: async () => {
          throw new Error("permission denied");
        },
      },
    } as unknown as WorkspaceClient;

    const fs = new DatabricksWorkspaceFilesystem({
      client,
      basePath: "/Workspace/.assistant/skills",
      mkdirs: "try",
    });

    await fs.init();
    expect(await fs.readdir("/")).toEqual([]);
    expect(await fs.exists("/demo-skill/SKILL.md")).toBe(false);
  });

  test("fails init when mkdirs is true and the base path cannot be created", async () => {
    const client = {
      workspace: {
        getStatus: async () => {
          throw new Error("Path does not exist");
        },
        mkdirs: async () => {
          throw new Error("permission denied");
        },
      },
    } as unknown as WorkspaceClient;

    const fs = new DatabricksWorkspaceFilesystem({
      client,
      basePath: "/Workspace/.assistant/skills",
      mkdirs: true,
    });

    await expect(fs.init()).rejects.toThrow();
  });

  test("skips mkdir and uses an empty namespace when mkdirs is false", async () => {
    const client = {
      workspace: {
        getStatus: async () => {
          throw new Error("Path does not exist");
        },
        mkdirs: async () => {
          throw new Error("mkdirs should not run");
        },
      },
    } as unknown as WorkspaceClient;

    const fs = new DatabricksWorkspaceFilesystem({
      client,
      basePath: "/Workspace/.assistant/skills",
      mkdirs: false,
    });

    await fs.init();
    expect(await fs.readdir("/")).toEqual([]);
  });

  test("treats a successful mkdir as writable without a probe file", async () => {
    let mkdirCalls = 0;
    const client = {
      workspace: {
        getStatus: async () => {
          throw new Error("Path does not exist");
        },
        mkdirs: async () => {
          mkdirCalls++;
        },
        import: async () => {
          throw new Error("probe write should not run");
        },
      },
    } as unknown as WorkspaceClient;

    const fs = new DatabricksWorkspaceFilesystem({
      client,
      basePath: "/Workspace/.assistant/skills",
      mkdirs: true,
    });

    await fs.init();
    expect(mkdirCalls).toBe(1);
    expect(fs.readOnly).toBe(false);
  });
});
