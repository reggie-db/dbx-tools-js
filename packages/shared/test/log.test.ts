import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

import { isDebugEnabled, isLevelEnabled, logger } from "../src/log.js";

// log.ts reads `process.env.LOG_LEVEL` lazily on every call, so we
// force `debug` once before the level-routing test runs. With the
// default `info` threshold, `log.debug(...)` would be dropped and
// the matching console mock never fires.
beforeAll(() => {
  process.env.LOG_LEVEL = "debug";
});

type ConsoleMethod = "debug" | "info" | "warn" | "error";

// Stash the real console methods so we can replace and restore around tests.
const ORIGINAL: Record<ConsoleMethod, (...args: unknown[]) => void> = {
  debug: console.debug,
  info: console.info,
  warn: console.warn,
  error: console.error,
};

type Mocked = Record<ConsoleMethod, ReturnType<typeof mock>>;

function installConsoleMocks(): Mocked {
  const mocks: Partial<Mocked> = {};
  for (const key of Object.keys(ORIGINAL) as ConsoleMethod[]) {
    const m = mock(() => {});
    mocks[key] = m;
    console[key] = m as unknown as (typeof console)[ConsoleMethod];
  }
  return mocks as Mocked;
}

function restoreConsole(): void {
  for (const [key, fn] of Object.entries(ORIGINAL) as [
    ConsoleMethod,
    (typeof ORIGINAL)[ConsoleMethod],
  ][]) {
    console[key] = fn;
  }
}

describe("logger", () => {
  let mocks: Mocked;

  beforeEach(() => {
    mocks = installConsoleMocks();
  });

  afterEach(() => {
    restoreConsole();
  });

  it("prefixes messages with [name] when given a string", () => {
    const log = logger("plugin-a");
    log.info("hello");
    expect(mocks.info).toHaveBeenCalledWith("[plugin-a] hello");
  });

  it("prefixes from plugin.name on a NameLike object", () => {
    const log = logger({ name: "plugin-b" });
    log.warn("careful");
    expect(mocks.warn).toHaveBeenCalledWith("[plugin-b] careful");
  });

  it("omits the prefix when no name is available", () => {
    const log = logger(undefined);
    log.error("boom");
    expect(mocks.error).toHaveBeenCalledWith("boom");
  });

  it("omits the prefix when plugin.name is an empty string", () => {
    const log = logger({ name: "" });
    log.debug("no prefix");
    expect(mocks.debug).toHaveBeenCalledWith("no prefix");
  });

  it("passes attributes as a second argument when provided", () => {
    const log = logger("plugin-a");
    log.info("update", { foo: 1, bar: "x" });
    expect(mocks.info).toHaveBeenCalledWith("[plugin-a] update", { foo: 1, bar: "x" });
  });

  it("does not pass an undefined second argument", () => {
    const log = logger("plugin-a");
    log.info("noattrs");
    expect(mocks.info).toHaveBeenCalledTimes(1);
    expect(mocks.info.mock.calls[0]).toEqual(["[plugin-a] noattrs"]);
  });

  it("routes each level to the matching console method", () => {
    const log = logger("plugin-a");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(mocks.debug).toHaveBeenCalledWith("[plugin-a] d");
    expect(mocks.info).toHaveBeenCalledWith("[plugin-a] i");
    expect(mocks.warn).toHaveBeenCalledWith("[plugin-a] w");
    expect(mocks.error).toHaveBeenCalledWith("[plugin-a] e");
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
    expect(isDebugEnabled()).toBe(true);
  });

  it("treats LOG_LEVEL case-insensitively", () => {
    process.env.LOG_LEVEL = "WARN";
    expect(isLevelEnabled("info")).toBe(false);
    expect(isLevelEnabled("warn")).toBe(true);
  });
});
