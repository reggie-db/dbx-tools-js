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
 *
 * As Genie streams its long-running events (`FETCHING_METADATA` →
 * `ASKING_AI` → `EXECUTING_QUERY` → `COMPLETED`, plus SQL queries and
 * row data in `message_result.attachments` / `query_result`), the tool
 * forwards a normalised {@link GenieProgress} discriminated union out
 * through `ctx.writer` so the client can render incremental feedback
 * (status pill, SQL code block, row count) while the LLM still sees a
 * single clean final payload.
 */

import { genie } from "@databricks/appkit";
import { stringUtils } from "@dbx-tools/appkit-shared";
import { createTool } from "@mastra/core/tools";
import type { ToolStream } from "@mastra/core/tools";
import { z } from "zod";

/** Live AppKit `GeniePlugin` instance. */
export type GeniePluginInstance = InstanceType<ReturnType<typeof genie>["plugin"]>;

/** Full `exports()` shape of the AppKit `genie` plugin. */
export type GenieExports = ReturnType<GeniePluginInstance["exports"]>;

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

/**
 * Normalised progress event surfaced to the UI as a Mastra `tool-output`
 * chunk. The discriminator (`kind`) keeps the union open for future
 * Genie features (charts, attachments, retries) without forcing the
 * client to know any Genie wire format.
 */
export type GenieProgress =
  | { kind: "started"; conversationId: string; messageId: string; spaceId: string }
  | { kind: "status"; status: string; label: string }
  | {
      kind: "sql";
      sql: string;
      title?: string;
      description?: string;
      statementId?: string;
    }
  | { kind: "data"; rowCount: number; columns: string[] }
  | { kind: "text"; content: string }
  | { kind: "suggested"; questions: string[] }
  | { kind: "error"; error: string };

const sendMessageSchema = z.object({
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

const getConversationSchema = z.object({
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
      inputSchema: sendMessageSchema,
      execute: async ({ content, conversationId }, ctx) => {
        const stream = opts.exports.sendMessage(alias, content, conversationId, {
          signal: opts.signal,
        });
        return drainGenieStream(stream, ctx.writer);
      },
    });
  }

  tools.genie_get_conversation = createTool({
    id: "genie_get_conversation",
    description:
      "Fetch the full message history of a prior Genie conversation by id. " +
      "Use when the user references an earlier Genie thread by id, or to " +
      "inspect attachments / SQL from previous turns.",
    inputSchema: getConversationSchema,
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
 *
 * When a Mastra `writer` is passed (i.e. the tool runs inside an agent
 * stream), normalised {@link GenieProgress} events are pushed mid-flight
 * so the UI can show status changes, SQL, and row counts as they
 * happen instead of staring at a spinner for the full Genie round-trip.
 */
async function drainGenieStream(
  stream: AsyncGenerator<GenieStreamEvent>,
  writer?: ToolStream,
): Promise<{
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

  // Best-effort progress emission. Awaited so the underlying agent
  // stream sees events in order; write failures are swallowed so a
  // dead writer (e.g. closed downstream) can't take the tool down.
  const emit = async (event: GenieProgress) => {
    if (!writer) return;
    try {
      await writer.write(event);
    } catch {
      // ignore: downstream stream is no longer interested
    }
  };

  for await (const event of stream) {
    switch (event.type) {
      case "message_start":
        conversationId = event.conversationId;
        messageId = event.messageId;
        spaceId = event.spaceId;
        await emit({
          kind: "started",
          conversationId,
          messageId,
          spaceId,
        });
        break;
      case "status":
        status = event.status;
        await emit({
          kind: "status",
          status: event.status,
          label: humanizeGenieStatus(event.status),
        });
        break;
      case "query_result": {
        queries.push({
          attachmentId: event.attachmentId,
          statementId: event.statementId,
          data: event.data,
        });
        const rowCount = event.data?.result?.data_array?.length ?? 0;
        const columns = (event.data?.manifest?.schema?.columns ?? []).map(
          (c) => c.name,
        );
        await emit({ kind: "data", rowCount, columns });
        break;
      }
      case "message_result":
        content = event.message.content;
        attachments = event.message.attachments;
        status = event.message.status;
        for (const attachment of attachments ?? []) {
          if (attachment.query?.query) {
            await emit({
              kind: "sql",
              sql: attachment.query.query,
              title: attachment.query.title,
              description: attachment.query.description,
              statementId: attachment.query.statementId,
            });
          }
          if (attachment.text?.content) {
            await emit({ kind: "text", content: attachment.text.content });
          }
          if (attachment.suggestedQuestions?.length) {
            await emit({
              kind: "suggested",
              questions: attachment.suggestedQuestions,
            });
          }
        }
        break;
      case "error":
        error = event.error;
        await emit({ kind: "error", error: event.error });
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
 * Toolkit provider built from a live AppKit `GeniePlugin` instance.
 * Returned by {@link buildGenieProvider} so that
 * `plugins.genie?.toolkit()` inside an agent's `tools(plugins)` callback
 * resolves to the streaming-aware {@link buildGenieTools} record instead
 * of the AppKit default (which does one blocking call per tool with no
 * mid-flight events).
 *
 * The returned `toolkit()` reads alias names off the plugin's
 * `getAgentTools()` registry (each entry is `${alias}.sendMessage` or
 * `${alias}.getConversation`), then mints one `sendMessage` tool per
 * alias plus a shared `getConversation`. `sendMessage` / `getConversation`
 * are bound back to the plugin instance so they keep their `this`
 * (they are class methods, not free functions).
 *
 * `_opts` is accepted but unused for now - the streaming tools are an
 * all-or-nothing bundle. Wire `only` / `except` / `prefix` / `rename`
 * later if a caller needs them.
 */
export function buildGenieProvider(plugin: GeniePluginInstance): {
  toolkit(opts?: unknown): Record<string, ReturnType<typeof createTool>>;
} {
  return {
    toolkit(_opts?: unknown) {
      const aliases = extractGenieAliases(plugin);
      return buildGenieTools({
        aliases,
        exports: {
          sendMessage: plugin.sendMessage.bind(plugin),
          getConversation: plugin.getConversation.bind(plugin),
        },
      });
    },
  };
}

/**
 * Pull the configured space aliases out of a live AppKit `GeniePlugin`.
 * Reads them off `getAgentTools()` (public API) so we don't poke at the
 * `protected config.spaces` field: the plugin registers tools named
 * `${alias}.sendMessage` / `${alias}.getConversation`, so the unique
 * set of name prefixes is the alias list.
 */
function extractGenieAliases(plugin: GeniePluginInstance): string[] {
  const aliases = new Set<string>();
  for (const t of plugin.getAgentTools()) {
    const dot = t.name.indexOf(".");
    if (dot > 0) aliases.add(t.name.slice(0, dot));
  }
  return [...aliases];
}

/**
 * Convert raw Genie status codes (`FETCHING_METADATA`, `ASKING_AI`,
 * `EXECUTING_QUERY`, `COMPLETED`, ...) into short, sentence-cased
 * labels safe to drop straight into a UI pill. Unknown codes are
 * lower-cased with underscores stripped so new states still render.
 */
function humanizeGenieStatus(status: string): string {
  switch (status) {
    case "FETCHING_METADATA":
      return "Fetching metadata";
    case "ASKING_AI":
      return "Asking Genie";
    case "EXECUTING_QUERY":
      return "Running SQL query";
    case "COMPLETED":
      return "Completed";
    case "FAILED":
      return "Failed";
    default:
      return status.toLowerCase().replace(/_/g, " ");
  }
}
