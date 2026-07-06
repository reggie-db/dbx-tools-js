import { describe, expect, test } from "bun:test";
import { createTool } from "@mastra/core/tools";
import { approvalGatedToolIds } from "../src/agents.js";

describe("approvalGatedToolIds", () => {
  test("detects tools with requireApproval", () => {
    const sendEmail = createTool({
      id: "send_email",
      description: "Send mail",
      requireApproval: true,
      execute: async () => ({ ok: true }),
    });
    const weather = createTool({
      id: "weather",
      description: "Weather",
      execute: async () => "sunny",
    });
    expect(approvalGatedToolIds({ send_email: sendEmail, weather })).toEqual([
      "send_email",
    ]);
  });

  test("falls back to the record key when a tool omits id", () => {
    const gated = createTool({
      description: "Gated",
      requireApproval: true,
      execute: async () => ({}),
    });
    expect(approvalGatedToolIds({ my_tool: gated })).toEqual(["my_tool"]);
  });
});
