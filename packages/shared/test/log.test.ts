import { afterEach, describe, expect, it } from "bun:test";
import path from "node:path";

const workersDir = path.join(import.meta.dir, "workers");

function runWorker(name: string) {
  const script = path.join(workersDir, `${name}.ts`);
  const result = Bun.spawnSync({
    cmd: ["bun", script],
    cwd: path.join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const output = [result.stdout.toString(), result.stderr.toString()].filter(Boolean).join("\n");
    throw new Error(`worker ${name} failed:\n${output}`);
  }
}

process.env.LOG_LEVEL = "info";
const { isLevelEnabled } = await import("../src/log.js");

describe("logger sinks", () => {
  it("node console sink", () => {
    expect(() => runWorker("log-node-console")).not.toThrow();
  });

  it("consola sink", () => {
    expect(() => runWorker("log-consola")).not.toThrow();
  });

  it("global console sink", () => {
    expect(() => runWorker("log-global-console")).not.toThrow();
  });
});

describe("isLevelEnabled", () => {
  const previous = process.env.LOG_LEVEL;

  afterEach(() => {
    if (previous === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previous;
  });

  it("returns true for levels at or above the active threshold", () => {
    process.env.LOG_LEVEL = "info";
    expect(isLevelEnabled("debug")).toBe(false);
    expect(isLevelEnabled("info")).toBe(true);
    expect(isLevelEnabled("warn")).toBe(true);
    expect(isLevelEnabled("error")).toBe(true);
  });

  it("returns true for debug when LOG_LEVEL is debug", () => {
    process.env.LOG_LEVEL = "debug";
    expect(isLevelEnabled("debug")).toBe(true);
  });

  it("treats LOG_LEVEL case-insensitively", () => {
    process.env.LOG_LEVEL = "WARN";
    expect(isLevelEnabled("info")).toBe(false);
    expect(isLevelEnabled("warn")).toBe(true);
  });

  it("falls back to info for unknown LOG_LEVEL values", () => {
    process.env.LOG_LEVEL = "verbose";
    expect(isLevelEnabled("debug")).toBe(false);
    expect(isLevelEnabled("info")).toBe(true);
  });
});
