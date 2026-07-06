import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout } from "node:timers/promises";

import { withRefreshLock } from "../src/refresh-lock.js";

describe("withRefreshLock", () => {
  test("allows only one holder at a time", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "skills-lock-"));
    await mkdir(cacheDir, { recursive: true });

    let active = 0;
    let maxActive = 0;

    const hold = () =>
      withRefreshLock(cacheDir, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await setTimeout(75);
        active -= 1;
      });

    try {
      await Promise.all([hold(), hold(), hold()]);
      expect(maxActive).toBe(1);
      expect(active).toBe(0);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});
