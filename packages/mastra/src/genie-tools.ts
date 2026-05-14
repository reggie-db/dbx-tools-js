import { createTool } from "@mastra/core/tools";
import { z } from "zod";

// Mastra tool wrappers around the AppKit `genie` plugin's `sendMessage` and
// `getConversation` operations. One `sendMessage` tool is registered per
// configured space alias so the LLM picks the space by tool selection (the
// description bakes the alias in); `getConversation` is registered once,
// taking `alias` as a parameter.

/**
 * Loose shape of an event emitted by the AppKit genie plugin's
 * `sendMessage` AsyncGenerator. Mirrors `GenieStreamEvent` from
 * `@databricks/appkit` without importing it (the type isn't re-exported
 * from the public barrel).
 */
export interface GenieEventLike {
  type: string;
  status?: string;
  messageId?: string;
  conversationId?: string;
  spaceId?: string;
  attachmentId?: string;
  statementId?: string;
  message?: { content?: string; status?: string; attachments?: unknown[] };
  data?: unknown;
  error?: string;
}

/**
 * Subset of the genie plugin's `exports()` we depend on. Modeled
 * structurally so we don't depend on appkit's internal `GeniePlugin`
 * type (only the `genie()` factory is publicly re-exported).
 */
export interface GenieExports {
  sendMessage: (
    alias: string,
    content: string,
    conversationId?: string,
    options?: { timeout?: number; signal?: AbortSignal },
  ) => AsyncGenerator<GenieEventLike>;
  getConversation: (
    alias: string,
    conversationId: string,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

const _sendMessageSchema = z.object({
  content: z
    .string()
    .describe("Natural-language question to send to the Genie space."),
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
  conversationId: z
    .string()
    .describe("Genie conversation id whose history to fetch."),
});

/**
 * Default tool name for a wired Genie alias. The well-known `default`
 * alias collapses to `genie`; everything else gets a `genie_` prefix so
 * multiple spaces stay disambiguated when an agent has more than one
 * wired. Mirrors the convention used by `@dbx-tools/appkit-genie`.
 */
export function defaultGenieToolName(alias: string): string {
  if (alias === "default") return "genie";
  return `genie_${alias.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

/**
 * Drain the genie sendMessage AsyncGenerator into a flat result the
 * agent's calling LLM can reason about. Final assistant text is pulled
 * from the last `message_result`; SQL statements are extracted from
 * `query_result` events; conversation/message ids are surfaced so the
 * caller can pass `conversationId` back into a follow-up tool call.
 */
async function _drainGenieStream(
  stream: AsyncGenerator<GenieEventLike>,
): Promise<{
  conversationId?: string;
  messageId?: string;
  spaceId?: string;
  status?: string;
  content?: string;
  attachments?: unknown[];
  queries: { attachmentId?: string; statementId?: string; data?: unknown }[];
  error?: string;
}> {
  let conversationId: string | undefined;
  let messageId: string | undefined;
  let spaceId: string | undefined;
  let status: string | undefined;
  let content: string | undefined;
  let attachments: unknown[] | undefined;
  let error: string | undefined;
  const queries: {
    attachmentId?: string;
    statementId?: string;
    data?: unknown;
  }[] = [];

  for await (const event of stream) {
    switch (event.type) {
      case "message_start":
        conversationId = event.conversationId ?? conversationId;
        messageId = event.messageId ?? messageId;
        spaceId = event.spaceId ?? spaceId;
        break;
      case "status":
        status = event.status ?? status;
        break;
      case "query_result":
        queries.push({
          attachmentId: event.attachmentId,
          statementId: event.statementId,
          data: event.data,
        });
        break;
      case "message_result":
        content = event.message?.content ?? content;
        attachments = event.message?.attachments ?? attachments;
        status = event.message?.status ?? status;
        break;
      case "error":
        error = event.error ?? error;
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
