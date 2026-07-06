import { describe, expect, test } from "bun:test";

import {
  repairAssistantPrefill,
  rewriteServingBody,
  stripReasoningFromServingMessages,
  type ServingChatMessage,
} from "../src/serving-sanitize.js";

describe("stripReasoningFromServingMessages", () => {
  test("removes reasoning content parts from assistant replay", () => {
    const messages: ServingChatMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "let me think" },
          { type: "text", text: "hello" },
        ],
      },
    ];
    expect(stripReasoningFromServingMessages(messages)).toBe(true);
    expect(messages[1]?.content).toEqual([{ type: "text", text: "hello" }]);
  });

  test("drops assistant messages that only contained reasoning", () => {
    const messages: ServingChatMessage[] = [
      {
        role: "assistant",
        content: [{ type: "thinking", text: "hidden" }],
      },
    ];
    expect(stripReasoningFromServingMessages(messages)).toBe(true);
    expect(messages).toEqual([]);
  });
});

describe("repairAssistantPrefill", () => {
  test("folds trailing assistant text after tool results into the opener", () => {
    const messages: ServingChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "calling tool",
        tool_calls: [{ id: "t1", type: "function", function: { name: "x" } }],
      },
      { role: "tool", tool_call_id: "t1", content: "ok" },
      { role: "assistant", content: "done" },
    ];
    expect(repairAssistantPrefill(messages)).toBe(true);
    expect(messages).toHaveLength(3);
    expect(messages[1]?.content).toBe("calling tool\n\ndone");
  });
});

describe("rewriteServingBody", () => {
  test("re-serializes when reasoning parts are stripped", () => {
    const body = JSON.stringify({
      model: "databricks-claude-sonnet-4-5",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "thought" },
            { type: "text", text: "answer" },
          ],
        },
      ],
    });
    const rewritten = rewriteServingBody(body);
    expect(rewritten).not.toBe(body);
    expect(JSON.parse(rewritten).messages[0].content).toEqual([
      { type: "text", text: "answer" },
    ]);
  });
});
