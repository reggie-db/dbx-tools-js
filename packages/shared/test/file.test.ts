import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as fileUtils from "../src/file.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("fileUtils.stat", () => {
  it("returns undefined for empty or whitespace paths", async () => {
    expect(await fileUtils.stat("")).toBeUndefined();
    expect(await fileUtils.stat("   ")).toBeUndefined();
  });

  it("returns undefined for paths with control characters", async () => {
    expect(await fileUtils.stat("foo\0bar")).toBeUndefined();
    expect(await fileUtils.stat("\x1f")).toBeUndefined();
  });

  it("returns undefined when the path does not exist", async () => {
    expect(
      await fileUtils.stat(join(tmpdir(), `missing-${Date.now()}`)),
    ).toBeUndefined();
  });

  it("returns stats for an existing file", async () => {
    const root = mkdtempSync(join(tmpdir(), "shared-file-"));
    tempDirs.push(root);
    const filePath = join(root, "probe.txt");
    writeFileSync(filePath, "ok");

    const info = await fileUtils.stat(filePath);
    expect(info?.isFile()).toBe(true);
  });
});
