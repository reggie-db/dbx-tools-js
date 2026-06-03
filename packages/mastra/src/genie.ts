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
 * `ASKING_AI` → `EXECUTING_QUERY` → `COMPLETED`, plus SQL text and
 * follow-ups in `message_result.attachments`), the tool forwards a
 * normalised {@link GenieProgress} discriminated union out through
 * `ctx.writer` so the client can render an incremental loading pill.
 * Row payloads from `query_result` are intentionally discarded - the
 * LLM never sees rows, and charts come from the separate
 * `render_data` tool when the model decides one is useful.
 */

import { genie } from "@databricks/appkit";
import { logUtils, stringUtils } from "@dbx-tools/appkit-shared";
import type { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import type { ToolStream } from "@mastra/core/tools";
import { z } from "zod";

import { emitChartWithPlanning } from "./chart.js";
import type { MastraPluginConfig } from "./config.js";

/**
 * Module-level logger tagged `[mastra/genie]`. Uses the shared
 * {@link logUtils.logger} so calls below `LOG_LEVEL` are
 * discarded for free. Default `LOG_LEVEL` is `info`; flip to
 * `debug` to see per-turn timing (`query_result` → planner
 * waits → `drain:return`).
 */
const log = logUtils.logger("mastra/genie");

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

/**
 * Per-dataset metadata surfaced to the LLM. The actual rows are
 * dispatched separately as a `kind: "chart"` writer event so the
 * model never has the rows in its context (token cost stays flat
 * regardless of dataset size). The model uses `chartId` to
 * reference the chart inline via the `[[chart:<chartId>]]` marker.
 */
const datasetSchema = z.object({
  chartId: z.string().describe(stringUtils.toDescription`
    Short id (8 hex chars) for the chart-render slot the host UI
    has staged for this dataset. Embed
    \`[[chart:<chartId>]]\` on its own line in your reply at the
    position you want the chart to appear; the client renders it
    inline. Do not paraphrase the dataset's rows in prose - the
    chart is the rendering.
  `),
  title: z.string().optional().describe(stringUtils.toDescription`
    Genie's own title for the SQL that produced this dataset.
    Useful as a label when you reference the chart in prose.
  `),
  description: z.string().optional().describe(stringUtils.toDescription`
    Genie's prose description of the SQL, if any.
  `),
  columns: z.array(z.string()).describe(stringUtils.toDescription`
    Column names in display order. Use these when describing what
    is being charted (e.g. "trend of fill_rate over date").
  `),
  rowCount: z.number().describe(stringUtils.toDescription`
    Total rows in this dataset. Mention only if it adds context
    (e.g. "across the last 90 days").
  `),
  sql: z
    .string()
    .optional()
    .describe(stringUtils.toDescription`
      SQL Genie generated and executed. The host UI shows this on
      demand; you do not need to repeat it.
    `),
});

/**
 * Top-level output schema returned to the LLM from a Genie tool
 * call. The `datasets` array is intentionally metadata-only - row
 * data rides a writer event the host UI consumes directly and is
 * not in the model's context.
 */
const genieToolOutputSchema = z.object({
  conversationId: z
    .string()
    .optional()
    .describe(stringUtils.toDescription`
      Pass back on the next call to continue the same Genie thread.
    `),
  genieAnswer: z
    .string()
    .optional()
    .describe(stringUtils.toDescription`
      Genie's natural-language answer to the question. Pass this
      through to the user (verbatim, or as the basis of your
      reply). Genie may have run multiple SQL queries and tools to
      produce this; the full text is the answer.
    `),
  datasets: z
    .array(datasetSchema)
    .optional()
    .describe(stringUtils.toDescription`
      Datasets Genie produced for this turn (one per executed SQL
      statement). Each entry is metadata only; the rows are
      streamed to the host UI out-of-band. To render any of these
      as a chart inline in your reply, embed
      \`[[chart:<chartId>]]\` where you want the chart to appear.
      Do not paraphrase the rows - the chart is what the user
      should see; your prose should add interpretation
      (highlights, deltas, anomalies) around the chart.
    `),
  suggestedFollowUps: z
    .array(z.string())
    .optional()
    .describe(stringUtils.toDescription`
      Follow-up question suggestions Genie produced. The host UI
      renders these as clickable buttons; you do not need to list
      them in your reply.
    `),
  error: z
    .string()
    .optional()
    .describe(stringUtils.toDescription`
      Genie-side error message if the request failed.
    `),
});

type DrainResult = z.infer<typeof genieToolOutputSchema>;

/**
 * Normalised progress event surfaced to the UI as a Mastra
 * `tool-output` chunk. Loading pill events (`started`, `status`,
 * `sql`, `suggested`, `error`) are pure UI metadata and never reach
 * the LLM.
 *
 * The `chart` variant is the wire shape emitted by
 * {@link emitChartWithPlanning} (used by both this Genie
 * draining loop and the system-level `render_data` tool). All
 * fields except `chartId` are optional because two events per
 * chartId arrive on the wire: the first carries the rows
 * (`title` + `description?` + `data`); the second, on planner
 * success, carries just the resolved Echarts spec (`option`).
 * The host UI's `<ChartSlot>` merges them by `chartId`.
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
  | {
      kind: "chart";
      chartId: string;
      title?: string;
      description?: string;
      data?: Array<Record<string, unknown>>;
      option?: Record<string, unknown>;
    }
  | { kind: "text"; content: string }
  | { kind: "suggested"; questions: string[] }
  | { kind: "error"; error: string };

const sendMessageSchema = z.object({
  content: z.string().describe(stringUtils.toDescription`
    Natural-language question to send to the Genie space.
  `),
  conversationId: z
    .string()
    .optional()
    .describe(stringUtils.toDescription`
      Optional Genie conversation id to continue an earlier thread.
      Omit on the first call; pass the id returned in the previous
      result's \`conversationId\` to follow up.
    `),
});

const getConversationSchema = z.object({
  alias: z.string().describe(stringUtils.toDescription`
    Alias of the Genie space the conversation belongs to (matches
    the key in the genie plugin's \`spaces\` config).
  `),
  conversationId: z.string().describe(stringUtils.toDescription`
    Genie conversation id whose history to fetch.
  `),
});

/** Per-attachment shape returned inside a stored Genie message. */
const genieAttachmentSchema = z.object({
  attachmentId: z.string().optional().describe(stringUtils.toDescription`
    Genie attachment id; internal bookkeeping.
  `),
  query: z
    .object({
      title: z.string().optional().describe(stringUtils.toDescription`
        Genie's title for the SQL, if any.
      `),
      description: z.string().optional().describe(stringUtils.toDescription`
        Genie's prose description of the SQL, if any.
      `),
      query: z.string().optional().describe(stringUtils.toDescription`
        SQL Genie generated and executed.
      `),
      statementId: z.string().optional().describe(stringUtils.toDescription`
        Statement-execution id; internal bookkeeping.
      `),
    })
    .optional()
    .describe(stringUtils.toDescription`
      SQL Genie attached to this message, if it ran any.
    `),
  text: z
    .object({
      content: z.string().optional().describe(stringUtils.toDescription`
        Genie's natural-language answer text for this attachment.
      `),
    })
    .optional()
    .describe(stringUtils.toDescription`
      Per-attachment text content (independent of the message-level
      \`content\` field).
    `),
  suggestedQuestions: z
    .array(z.string())
    .optional()
    .describe(stringUtils.toDescription`
      Follow-up question suggestions Genie generated for this turn.
    `),
});

/** Single message inside a Genie conversation history page. */
const genieMessageSchema = z.object({
  messageId: z.string().describe(stringUtils.toDescription`
    Genie message id; internal bookkeeping.
  `),
  conversationId: z.string().describe(stringUtils.toDescription`
    Conversation id this message belongs to.
  `),
  spaceId: z.string().describe(stringUtils.toDescription`
    Genie space id this message belongs to.
  `),
  status: z.string().describe(stringUtils.toDescription`
    Genie message status (\`COMPLETED\`, \`FAILED\`, etc.).
  `),
  content: z.string().describe(stringUtils.toDescription`
    Outer message-level natural-language content Genie wrote.
  `),
  attachments: z
    .array(genieAttachmentSchema)
    .optional()
    .describe(stringUtils.toDescription`
      Attachments (SQL queries, text blocks, suggested follow-ups)
      Genie produced for this message.
    `),
  error: z.string().optional().describe(stringUtils.toDescription`
    Genie-side error attached to this message, if any.
  `),
});

/**
 * Output schema for the \`genie_get_conversation\` tool. Mirrors
 * AppKit's \`GenieConversationHistoryResponse\` so the model gets a
 * clear, typed view of prior messages instead of an opaque blob.
 */
const genieGetConversationOutputSchema = z.object({
  conversationId: z.string().describe(stringUtils.toDescription`
    Conversation id you fetched.
  `),
  spaceId: z.string().describe(stringUtils.toDescription`
    Genie space the conversation belongs to.
  `),
  messages: z.array(genieMessageSchema).describe(stringUtils.toDescription`
    Messages in the conversation, oldest to newest. Each
    \`message.content\` is Genie's natural-language answer for
    that turn; attachments carry the SQL and follow-ups Genie
    produced.
  `),
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
 *
 * `config` must be the active plugin config; Genie's
 * `query_result` events are routed through
 * {@link emitChartWithPlanning} which uses it to resolve the
 * chart-planner's model.
 */
export function buildGenieTools(opts: {
  aliases: string[];
  exports: GenieExports;
  config: MastraPluginConfig;
  signal?: AbortSignal;
}): Record<string, ReturnType<typeof createTool>> {
  const tools: Record<string, ReturnType<typeof createTool>> = {};

  for (const alias of opts.aliases) {
    const id = defaultGenieToolName(alias);
    tools[id] = createTool({
      id,
      description: stringUtils.toDescription`
        Ask the Databricks Genie space "${alias}" a single
        natural-language question. Genie translates it to SQL,
        runs it, and returns \`genieAnswer\` (prose) plus
        \`datasets[]\` (one entry per executed query, each with
        a short \`chartId\`). Embed \`[[chart:<chartId>]]\` on
        its own line at the position you want that data rendered
        as an inline chart. Add interpretation around the chart
        (deltas, anomalies, takeaways); do not paraphrase row
        values.

        Issue ONE focused question per user turn. Prefer
        aggregated queries over raw-row queries for time-series
        and distributions.
      `,
      inputSchema: sendMessageSchema,
      outputSchema: genieToolOutputSchema,
      execute: async ({ content, conversationId }, ctx) => {
        const stream = opts.exports.sendMessage(alias, content, conversationId, {
          signal: opts.signal,
        });
        const requestContext = (ctx as { requestContext?: RequestContext } | undefined)
          ?.requestContext;
        return drainGenieStream(stream, ctx.writer, {
          config: opts.config,
          ...(requestContext ? { requestContext } : {}),
        });
      },
    });
  }

  tools.genie_get_conversation = createTool({
    id: "genie_get_conversation",
    description: stringUtils.toDescription`
      Fetch the full message history of a prior Genie conversation
      by id. Use when the user references an earlier Genie thread
      by id, or to inspect attachments / SQL from previous turns.
    `,
    inputSchema: getConversationSchema,
    outputSchema: genieGetConversationOutputSchema,
    execute: async ({ alias, conversationId }) => {
      return opts.exports.getConversation(alias, conversationId, opts.signal);
    },
  });

  return tools;
}

/** Inputs to {@link drainGenieStream}. */
interface DrainGenieStreamOptions {
  config: MastraPluginConfig;
  requestContext?: RequestContext;
}

/**
 * Drain the genie `sendMessage` AsyncGenerator into a flat result
 * the agent's calling LLM can reason about, while forwarding
 * progress and chart events to the host UI.
 *
 * Three streams of output happen in parallel:
 *
 * 1. {@link GenieProgress} pill events on the writer (`started`,
 *    `status`, `sql`, `suggested`, `error`) drive the loading
 *    pill in the chat bubble.
 * 2. `kind: "chart"` events on the writer (emitted via
 *    {@link emitChartWithPlanning}) carry the row payload from
 *    each Genie SQL statement and, on planner success, a
 *    follow-up event with the rendered Echarts spec. The host
 *    UI's `<ChartSlot>` merges the two by `chartId` and
 *    renders inline at the marker position the model picked.
 *    The data never reaches the LLM.
 * 3. The `DrainResult` returned to the LLM contains Genie's
 *    prose answer plus a `datasets[]` array of metadata
 *    (chartId, title, columns, rowCount, sql) the model uses
 *    to cite charts via `[[chart:<chartId>]]` markers.
 *
 * `query_result` and `message_result` events arrive in either
 * order; we buffer per-statement scratch keyed by `statementId`
 * so each half can fill in what it knows. The chart event
 * fires the moment `query_result` lands; the planner runs in
 * the background. We `Promise.allSettled` every planner promise
 * before returning so all chart work is attributed to the tool's
 * trace span and so the LLM's `datasets[]` includes every
 * chartId that has actually been queued.
 */
async function drainGenieStream(
  stream: AsyncGenerator<GenieStreamEvent>,
  writer: ToolStream | undefined,
  opts: DrainGenieStreamOptions,
): Promise<DrainResult> {
  const { config, requestContext } = opts;
  let conversationId: string | undefined;
  let genieAnswer: string | undefined;
  let suggestedFollowUps: string[] | undefined;
  let error: string | undefined;
  // AppKit's `streamSendMessage` forwards every SDK `onProgress`
  // callback verbatim - the same `EXECUTING_QUERY` can fire several
  // times during a single poll loop. AppKit's other path,
  // `streamGetMessage`, dedupes on the connector side; we mirror that
  // behaviour here so the UI status pill doesn't flicker and we don't
  // burn writer bytes on no-op events.
  let lastStatus: string | undefined;

  // Per-statement scratch keyed by Genie's `statementId`. Filled in
  // by both `query_result` (chartId + columns + rows) and
  // `message_result` (sql + title + description). The LLM-bound
  // `datasets[]` is built from this at end-of-stream, after all
  // planner promises settle.
  type Scratch = {
    statementId: string;
    chartId?: string;
    title?: string;
    description?: string;
    sql?: string;
    columns: string[];
    rowCount: number;
  };
  const scratchByStatementId = new Map<string, Scratch>();
  const getScratch = (statementId: string): Scratch => {
    let s = scratchByStatementId.get(statementId);
    if (!s) {
      s = { statementId, columns: [], rowCount: 0 };
      scratchByStatementId.set(statementId, s);
    }
    return s;
  };
  /**
   * Planner promises kicked off per `query_result`. Awaited
   * (Promise.allSettled) before drainGenieStream returns so the
   * Genie tool's trace span covers the chart work and the LLM's
   * `datasets[]` accurately reflects every chartId that's been
   * queued for rendering.
   */
  const plannerPromises: Promise<void>[] = [];

  const emit = async (event: GenieProgress) => {
    if (!writer) return;
    try {
      await writer.write(event);
    } catch {
      // ignore: downstream stream is no longer interested
    }
  };

  for await (const event of stream) {
    // Per-event raw payload for tuning the pill / answer pipeline
    // against real Genie traffic. At `info` (the default) this is
    // discarded for free; flip `LOG_LEVEL=debug` to see every
    // raw wire event before the switch routes it through writer
    // and DrainResult.
    log.debug("event", { type: event.type, payload: event });
    switch (event.type) {
      case "message_start":
        conversationId = event.conversationId;
        await emit({
          kind: "started",
          conversationId: event.conversationId,
          messageId: event.messageId,
          spaceId: event.spaceId,
        });
        break;
      case "status":
        if (event.status === lastStatus) break;
        lastStatus = event.status;
        await emit({
          kind: "status",
          status: event.status,
          label: humanizeGenieStatus(event.status),
        });
        break;
      case "query_result": {
        const columns = (event.data?.manifest?.schema?.columns ?? []).map(
          (c) => c.name,
        );
        const dataArray = (event.data?.result?.data_array ?? []) as Array<
          Array<string | null>
        >;
        const rows = genieRowsToObjects(columns, dataArray);
        const scratch = getScratch(event.statementId);
        // emitChartWithPlanning emits the dataset event immediately
        // and kicks off the chart-planner agent in the background.
        // It returns the chartId synchronously; the plannerPromise
        // is awaited at end-of-stream so chart work shows up under
        // this tool's trace span.
        const { chartId, plannerPromise } = await emitChartWithPlanning({
          ...(writer ? { writer } : {}),
          config,
          ...(requestContext ? { requestContext } : {}),
          title: scratch.title ?? `Genie query`,
          ...(scratch.description ? { description: scratch.description } : {}),
          data: rows,
        });
        scratch.chartId = chartId;
        scratch.columns = columns;
        scratch.rowCount = rows.length;
        plannerPromises.push(plannerPromise);
        log.debug("query_result", {
          statementId: event.statementId,
          chartId,
          rows: rows.length,
          columns,
        });
        break;
      }
      case "message_result":
        genieAnswer = event.message.content;
        for (const attachment of event.message.attachments ?? []) {
          const sqlText = attachment.query?.query;
          const stmtId = attachment.query?.statementId;
          if (stmtId) {
            const scratch = getScratch(stmtId);
            if (sqlText) scratch.sql = sqlText;
            if (attachment.query?.title) scratch.title = attachment.query.title;
            if (attachment.query?.description) {
              scratch.description = attachment.query.description;
            }
          }
          if (sqlText) {
            await emit({
              kind: "sql",
              sql: sqlText,
              title: attachment.query?.title,
              description: attachment.query?.description,
              statementId: stmtId,
            });
          }
          if (attachment.text?.content) {
            await emit({ kind: "text", content: attachment.text.content });
          }
          if (attachment.suggestedQuestions?.length) {
            // Last attachment with suggestions wins (same merge rule
            // the UI uses via `collectSuggestions`); keeping just one
            // copy per turn caps token usage.
            suggestedFollowUps = attachment.suggestedQuestions;
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

  // Wait for all chart planners to settle before returning so the
  // tool's trace span covers chart work and the LLM's
  // `datasets[]` reflects only chartIds the client has actually
  // received writer events for. Failures in `emitChartWithPlanning`
  // are already swallowed inside the helper, so this never
  // throws.
  log.debug("planners:awaiting", { count: plannerPromises.length });
  await Promise.allSettled(plannerPromises);
  log.debug("planners:settled", { count: plannerPromises.length });

  // Build the LLM-bound `datasets[]` from scratch entries that
  // actually ran a query (chartId is assigned at `query_result`
  // time). Entries that only saw `message_result` metadata
  // without a row payload are skipped.
  const datasets: Array<z.infer<typeof datasetSchema>> = [];
  for (const scratch of scratchByStatementId.values()) {
    if (!scratch.chartId) continue;
    datasets.push({
      chartId: scratch.chartId,
      ...(scratch.title ? { title: scratch.title } : {}),
      ...(scratch.description ? { description: scratch.description } : {}),
      columns: scratch.columns,
      rowCount: scratch.rowCount,
      ...(scratch.sql ? { sql: scratch.sql } : {}),
    });
  }

  log.debug("drain:return", {
    conversationId,
    hasAnswer: typeof genieAnswer === "string",
    answerLength: genieAnswer?.length ?? 0,
    chartIds: datasets.map((d) => d.chartId),
    suggestedCount: suggestedFollowUps?.length ?? 0,
    error,
  });

  return {
    ...(conversationId ? { conversationId } : {}),
    ...(genieAnswer ? { genieAnswer } : {}),
    ...(datasets.length > 0 ? { datasets } : {}),
    ...(suggestedFollowUps ? { suggestedFollowUps } : {}),
    ...(error ? { error } : {}),
  };
}

/**
 * Convert Genie's `data_array` (column-positional `string | null`
 * tuples) into plain JS row objects keyed by column name. Numeric
 * strings are coerced to numbers so the chart-planner picks
 * `value` axes instead of `category` axes; everything else passes
 * through verbatim. `null` becomes `null`.
 */
function genieRowsToObjects(
  columns: ReadonlyArray<string>,
  dataArray: ReadonlyArray<ReadonlyArray<string | null>>,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const row of dataArray) {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      const cell = row[i] ?? null;
      obj[col] = coerceCell(cell);
    });
    out.push(obj);
  }
  return out;
}

/** Best-effort numeric coercion for Genie's all-strings cells. */
function coerceCell(cell: string | null): unknown {
  if (cell === null) return null;
  // Anchored to keep `12.5px` / `123abc` as strings; only fully
  // numeric values become JS numbers.
  if (/^-?\d+(\.\d+)?$/.test(cell)) {
    const n = Number(cell);
    if (Number.isFinite(n)) return n;
  }
  return cell;
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
export function buildGenieProvider(
  plugin: GeniePluginInstance,
  opts: { config: MastraPluginConfig },
): {
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
        config: opts.config,
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
      return [
        ...stringUtils.tokenizeWithOptions(
          { capitalize: true, lowerCase: true },
          status,
        ),
      ].join(" ");
  }
}
