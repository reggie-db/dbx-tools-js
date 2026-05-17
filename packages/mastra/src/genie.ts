/**
 * Mastra tool wrappers around the AppKit `genie` plugin's exports.
 *
 * One `sendMessage` tool is registered per configured space alias so
 * the LLM picks the space by tool selection (the description bakes the
 * alias in). `getConversation` is registered once, taking `alias` as a
 * parameter.
 *
 * All Genie payload types are inferred from the public `genie` factory
 * (`genie().plugin` constructor → `exports()` return type), so any
 * upstream change in `@databricks/appkit` flows in automatically.
 */

import { genie } from "@databricks/appkit";
import { stringUtils } from "@dbx-tools/appkit-shared";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/** Full `exports()` shape of the AppKit `genie` plugin. */
export type GenieExports = ReturnType<
  InstanceType<ReturnType<typeof genie>["plugin"]>["exports"]
>;

/**
 * Stream event yielded by `genie.exports().sendMessage`. Discriminated
 * by `type` (`"message_start" | "status" | "message_result" |
 * "query_result" | "error" | "history_info"`).
 */
export type GenieStreamEvent =
  ReturnType<GenieExports["sendMessage"]> extends AsyncGenerator<infer E> ? E : never;

/** Conversation history returned by `genie.exports().getConversation`. */
export type GenieConversation = Awaited<ReturnType<GenieExports["getConversation"]>>;

type GenieMessage = Extract<GenieStreamEvent, { type: "message_result" }>["message"];
type GenieStatement = Extract<GenieStreamEvent, { type: "query_result" }>["data"];

const _sendMessageSchema = z.object({
  content: z.string().describe("Natural-language question to send to the Genie space."),
  conversationId: z
    .string()
    .optional()
    .describe(
      "Optional Genie conversation id to continue an earlier thread. " +
        "Omit on the first call; pass the id returned in the previous " +
        "result's `conversationId` to follow up.",
    ),
});

const _getConversationSchema = z.object({
  alias: z
    .string()
    .describe(
      "Alias of the Genie space the conversation belongs to (matches the " +
        "key in the genie plugin's `spaces` config).",
    ),
  conversationId: z.string().describe("Genie conversation id whose history to fetch."),
});

/**
 * Default tool name for a wired Genie alias. The well-known `default`
 * alias collapses to `genie`; everything else gets a `genie_` prefix so
 * multiple spaces stay disambiguated when an agent has more than one
 * wired. Matches the `genie` / `genie_<alias>` naming used elsewhere in
 * dbx-tools AppKit demos.
 */
export function defaultGenieToolName(alias: string): string {
  if (alias === "default") return "genie";
  return stringUtils.toIdentifierWithOptions({ distinct: true }, "genie", alias);
}

/**
 * Build one `sendMessage` tool per configured Genie alias plus a single
 * `getConversation` tool. Returns a record keyed by tool id, ready to
 * spread into an `Agent`'s `tools` map.
 */
export function buildGenieTools(opts: {
  aliases: string[];
  exports: GenieExports;
  signal?: AbortSignal;
}): Record<string, ReturnType<typeof createTool>> {
  const tools: Record<string, ReturnType<typeof createTool>> = {};

  for (const alias of opts.aliases) {
    const id = defaultGenieToolName(alias);
    tools[id] = createTool({
      id,
      description:
        `Ask the Databricks Genie space "${alias}" a natural-language ` +
        "question. Genie translates the question to SQL, runs it against " +
        "the configured datasets, and returns a written answer plus any " +
        "SQL statements it executed. Returns `{ conversationId, content, " +
        "queries, ... }`; pass `conversationId` back in to follow up in " +
        "the same Genie thread.",
      inputSchema: _sendMessageSchema,
      execute: async ({ content, conversationId }) => {
        const stream = opts.exports.sendMessage(alias, content, conversationId, {
          signal: opts.signal,
        });
        return _drainGenieStream(stream);
      },
    });
  }

  tools.genie_get_conversation = createTool({
    id: "genie_get_conversation",
    description:
      "Fetch the full message history of a prior Genie conversation by id. " +
      "Use when the user references an earlier Genie thread by id, or to " +
      "inspect attachments / SQL from previous turns.",
    inputSchema: _getConversationSchema,
    execute: async ({ alias, conversationId }) => {
      return opts.exports.getConversation(alias, conversationId, opts.signal);
    },
  });

  return tools;
}

/**
 * Drain the genie `sendMessage` AsyncGenerator into a flat result the
 * agent's calling LLM can reason about. Final assistant text is pulled
 * from the last `message_result`; SQL statements are extracted from
 * `query_result` events; conversation / message ids are surfaced so the
 * caller can pass `conversationId` back into a follow-up tool call.
 */
async function _drainGenieStream(stream: AsyncGenerator<GenieStreamEvent>): Promise<{
  conversationId?: string;
  messageId?: string;
  spaceId?: string;
  status?: string;
  content?: string;
  attachments?: GenieMessage["attachments"];
  queries: { attachmentId: string; statementId: string; data: GenieStatement }[];
  error?: string;
}> {
  let conversationId: string | undefined;
  let messageId: string | undefined;
  let spaceId: string | undefined;
  let status: string | undefined;
  let content: string | undefined;
  let attachments: GenieMessage["attachments"] | undefined;
  let error: string | undefined;
  const queries: {
    attachmentId: string;
    statementId: string;
    data: GenieStatement;
  }[] = [];

  for await (const event of stream) {
    switch (event.type) {
      case "message_start":
        conversationId = event.conversationId;
        messageId = event.messageId;
        spaceId = event.spaceId;
        break;
      case "status":
        status = event.status;
        break;
      case "query_result":
        queries.push({
          attachmentId: event.attachmentId,
          statementId: event.statementId,
          data: event.data,
        });
        break;
      case "message_result":
        content = event.message.content;
        attachments = event.message.attachments;
        status = event.message.status;
        break;
      case "error":
        error = event.error;
        break;
      default:
        break;
    }
  }

  return {
    conversationId,
    messageId,
    spaceId,
    status,
    content,
    attachments,
    queries,
    error,
  };
}
