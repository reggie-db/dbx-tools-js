/**
 * Mastra input processor that auto-recalls Databricks Managed Agent
 * Memory before each turn. This is the managed-memory replacement for
 * Postgres `PgVector` semantic recall: instead of Mastra reading a
 * vector index, this processor searches the user's memory-store scope
 * with the latest user message and injects the top entries as an
 * appended system message so the model has the user's durable context.
 *
 * Scope comes from trusted request state via {@link resolveMemoryContext}
 * (the OBO user), never from the model. On a stateless turn, an empty
 * query, or any REST failure the processor passes the messages through
 * unchanged so a recall hiccup never blocks the conversation.
 */

import { commonUtils, logUtils, stringUtils } from "@dbx-tools/shared";
import type { InputProcessor, ProcessInputArgs } from "@mastra/core/processors";

import { search } from "../connectors/managed-memory/client.js";
import { resolveMemoryContext } from "../connectors/managed-memory/context.js";
import { renderEntry } from "../connectors/managed-memory/tools.js";
import type { ManagedMemoryRuntime } from "../connectors/managed-memory/types.js";

const log = logUtils.logger("mastra/processor/managed-memory-recall");

/**
 * Build the recall processor bound to a managed-memory runtime. Created
 * once at setup (when managed memory is active) and wired onto every
 * agent's `inputProcessors` by {@link buildAgents}.
 */
export function buildManagedMemoryRecallProcessor(
  runtime: ManagedMemoryRuntime,
): InputProcessor {
  return {
    id: "managed-memory-recall",
    description:
      "Recalls the user's Databricks Managed Memory entries and injects them as context before the model runs.",
    async processInput(args: ProcessInputArgs) {
      const ctx = resolveMemoryContext(args.requestContext);
      if (!ctx) return args.messages;
      const query = latestUserText(args.messages);
      if (!query) return args.messages;

      try {
        const entries = await search(
          ctx.client,
          runtime.storeName,
          ctx.scope,
          query,
          runtime.topK,
          args.abortSignal,
        );
        if (entries.length === 0) return args.messages;
        const block = [
          "Relevant memories about the user (from long-term memory):",
          ...entries.map((e) => `- ${renderEntry(e)}`),
        ].join("\n");
        log.debug("recalled", { scope: ctx.scope, entries: entries.length });
        return {
          messages: args.messages,
          systemMessages: [...args.systemMessages, { role: "system", content: block }],
        };
      } catch (err) {
        log.warn("recall:error", { error: commonUtils.errorMessage(err) });
        return args.messages;
      }
    },
  };
}

/**
 * Extract the most recent user message's text. Walks the message list
 * from the end, collecting `text` parts off the first `user` message.
 * Returns `null` when there is no user text to search with.
 */
function latestUserText(messages: ProcessInputArgs["messages"]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "user") continue;
    const content = message.content as
      | { parts?: unknown; content?: unknown }
      | undefined;
    const parts = content?.parts;
    if (!Array.isArray(parts)) {
      return stringUtils.trimToNull(content?.content);
    }
    const text = parts
      .filter(
        (p): p is { type: "text"; text: string } =>
          (p as { type?: unknown }).type === "text" &&
          typeof (p as { text?: unknown }).text === "string",
      )
      .map((p) => p.text)
      .join(" ");
    return stringUtils.trimToNull(text);
  }
  return null;
}
