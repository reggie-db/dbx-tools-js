import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import * as projectUtils from "../src/project.js";

const tempDirs: string[] = [];

function makeTempProject(layout: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), "shared-project-"));
  tempDirs.push(root);
  layout(root);
  return root;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("parseGitRemote", () => {
  it("parses https GitHub URLs", () => {
    expect(
      projectUtils.parseGitRemote("https://github.com/databricks/appkit.git"),
    ).toBe("appkit");
  });

  it("parses scp-style Git URLs", () => {
    expect(projectUtils.parseGitRemote("git@github.com:org/my-repo.git")).toBe(
      "my-repo",
    );
  });

  it("returns undefined for empty input", () => {
    expect(projectUtils.parseGitRemote("")).toBeUndefined();
    expect(projectUtils.parseGitRemote("   ")).toBeUndefined();
  });
});

describe("name", () => {
  it("uses the root package.json name in a workspace monorepo", async () => {
    const root = makeTempProject((dir) => {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "root-app", workspaces: ["packages/*"] }),
      );
      const pkgDir = join(dir, "packages", "child");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({ name: "@scope/child-pkg" }),
      );
    });

    const name = await projectUtils.name({ cwd: join(root, "packages", "child") });
    expect(name).toBe("root-app");
  });

  it("uses package.json name for a single-package directory", async () => {
    const root = makeTempProject((dir) => {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "solo-package" }),
      );
    });

    expect(await projectUtils.name({ cwd: root })).toBe("solo-package");
  });

  it("falls back to the root directory basename when package.json has no name", async () => {
    const root = makeTempProject((dir) => {
      const nested = join(dir, "my-app-dir");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, "package.json"), JSON.stringify({ private: true }));
    });

    const nested = join(root, "my-app-dir");
    expect(await projectUtils.name({ cwd: nested })).toBe("my-app-dir");
  });

  it("memoizes by resolved cwd", async () => {
    const root = makeTempProject((dir) => {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "memoized-name" }),
      );
    });

    const cwd = resolve(root);
    const a = await projectUtils.name({ cwd });
    const b = await projectUtils.name({ cwd: root });
    expect(a).toBe("memoized-name");
    expect(b).toBe(a);
  });

  it("resolves this repository from the workspace root", async () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    expect(await projectUtils.name({ cwd: repoRoot })).toBe("dbx-tools-js");
  });
});
