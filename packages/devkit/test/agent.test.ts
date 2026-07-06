import { describe, expect, test } from "bun:test";
import { agentTimedOut, parseCodexStdout } from "../src/agent.js";

describe("agentTimedOut", () => {
  test("recognizes SIGTERM and SIGKILL exit codes", () => {
    expect(agentTimedOut(143)).toBe(true);
    expect(agentTimedOut(137)).toBe(true);
    expect(agentTimedOut(0)).toBe(false);
    expect(agentTimedOut(1)).toBe(false);
  });
});

describe("parseCodexStdout", () => {
  test("extracts text after the Starting Codex banner", () => {
    const raw = [
      "✔ Unity AI Gateway detected",
      "✔ Starting Codex",
      "alpha beta gamma",
    ].join("\n");
    expect(parseCodexStdout(raw)).toBe("alpha beta gamma");
  });

  test("extracts text from full codex transcript", () => {
    const raw = "--------\nuser\nhi\ncodex\nhello\ntokens used\n12";
    expect(parseCodexStdout(raw)).toBe("hello");
  });
});
