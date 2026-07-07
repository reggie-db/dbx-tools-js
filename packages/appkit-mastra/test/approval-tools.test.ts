import { describe, expect, test } from "bun:test";
import { createTool } from "@mastra/core/tools";
import { approvalGatedToolIds, type MastraTools } from "../src/agents.js";

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
    const tools = {
      my_tool: { requireApproval: true },
    } as MastraTools;
    expect(approvalGatedToolIds(tools)).toEqual(["my_tool"]);
  });
});
