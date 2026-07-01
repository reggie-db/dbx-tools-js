import { describe, expect, it } from "bun:test";

import { isMastraRequestAllowed } from "../src/server.js";

const scoped = { access: "scoped" as const, mcpEnabled: false };

describe("isMastraRequestAllowed (scoped)", () => {
  it("allows agent inference (stream / generate / network variants)", () => {
    for (const p of [
      "/agents/default/stream",
      "/agents/default/streamVNext",
      "/agents/default/stream/vnext",
      "/agents/default/generate",
      "/agents/default/generateVNext",
      "/agents/default/network",
    ]) {
      expect(isMastraRequestAllowed("POST", p, scoped)).toBe(true);
    }
  });

  it("allows read-only agent metadata but not deeper reads", () => {
    expect(isMastraRequestAllowed("GET", "/agents", scoped)).toBe(true);
    expect(isMastraRequestAllowed("GET", "/agents/default", scoped)).toBe(true);
    expect(isMastraRequestAllowed("GET", "/agents/default/evals", scoped)).toBe(false);
  });

  it("allows the plugin's own scoped /route/* routes for any method", () => {
    expect(isMastraRequestAllowed("GET", "/route/history/default", scoped)).toBe(true);
    expect(isMastraRequestAllowed("DELETE", "/route/history/default", scoped)).toBe(true);
    expect(isMastraRequestAllowed("GET", "/route/threads", scoped)).toBe(true);
    expect(isMastraRequestAllowed("DELETE", "/route/threads", scoped)).toBe(true);
  });

  it("refuses admin / mutating / bulk-export routes", () => {
    expect(isMastraRequestAllowed("POST", "/tools/send_email/execute", scoped)).toBe(false);
    expect(isMastraRequestAllowed("POST", "/workflows/wf/run", scoped)).toBe(false);
    expect(isMastraRequestAllowed("DELETE", "/memory/threads/x", scoped)).toBe(false);
    expect(isMastraRequestAllowed("GET", "/telemetry/traces", scoped)).toBe(false);
    expect(isMastraRequestAllowed("GET", "/logs", scoped)).toBe(false);
    expect(isMastraRequestAllowed("GET", "/scores", scoped)).toBe(false);
    // Agent mutation verbs are not inference and must be refused.
    expect(isMastraRequestAllowed("POST", "/agents/default/instructions", scoped)).toBe(false);
    expect(isMastraRequestAllowed("GET", "/agents/default/stream", scoped)).toBe(false);
  });

  it("gates MCP transport on the mcp flag", () => {
    expect(isMastraRequestAllowed("POST", "/mcp/app/mcp", scoped)).toBe(false);
    expect(
      isMastraRequestAllowed("POST", "/mcp/app/mcp", { access: "scoped", mcpEnabled: true }),
    ).toBe(true);
  });

  it('"full" access dispatches everything', () => {
    const full = { access: "full" as const, mcpEnabled: false };
    expect(isMastraRequestAllowed("POST", "/tools/send_email/execute", full)).toBe(true);
    expect(isMastraRequestAllowed("DELETE", "/memory/threads/x", full)).toBe(true);
  });
});
