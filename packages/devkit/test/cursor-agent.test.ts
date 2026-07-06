import { describe, expect, test } from "bun:test";
import { cursorAgentTimedOut } from "../src/cursor.js";

describe("cursorAgentTimedOut", () => {
  test("recognizes SIGTERM and SIGKILL exit codes", () => {
    expect(cursorAgentTimedOut(143)).toBe(true);
    expect(cursorAgentTimedOut(137)).toBe(true);
    expect(cursorAgentTimedOut(0)).toBe(false);
    expect(cursorAgentTimedOut(1)).toBe(false);
  });
});
