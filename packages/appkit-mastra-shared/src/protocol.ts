/**
 * Wire-format contract for `@dbx-tools/appkit-mastra`: the
 * dependency-free zod schemas + inferred types every consumer (the
 * React client, browser bundles, the server plugin) shares.
 *
 * Kept free of `pg`, `fastembed`, and the Mastra runtime so the
 * client can import these schemas without dragging in server-only
 * dependencies. Three layers live here:
 *
 *   1. The descriptor published by `MastraPlugin.clientConfig()`
 *      plus the REST payloads its routes return (models, history,
 *      suggestions, chart embeds, statement data). The server
 *      derives every path from the plugin mount and publishes the
 *      resolved paths so the client composes URLs without
 *      hard-coding `/api/mastra` - rename the plugin and the client
 *      keeps working.
 *   2. The `ctx.writer` event vocabulary: the wire-derived
 *      {@link GenieChatEvent}s from `@dbx-tools/genie-shared` plus
 *      the Mastra-only agent lifecycle events, unified as
 *      {@link GenieWriterEvent} so subscribers narrow both halves
 *      with a single `switch (event.type)`.
 *   3. The Genie agent's workflow output shapes
 *      ({@link GenieAgentResult} and its summary / dataset items).
 *
 * The route segments live in the sibling `routes.ts`
 * ({@link MASTRA_ROUTES}) and the embed-marker grammar in `marker.ts`,
 * so this file stays purely declarative (schemas + inferred types).
 * The browser client that drives these routes (`MastraPluginClient`)
 * ships from `@dbx-tools/appkit-mastra-ui`.
 */

import {
  GenieChatEventSchema,
  type GenieChatEvent,
  type MessageStatus,
} from "@dbx-tools/genie-shared";
import { ServingEndpointSummarySchema } from "@dbx-tools/model-shared";
import { z } from "zod";

/* ---------------------------- client config ---------------------------- */

/**
 * JSON-safe descriptor published by the Mastra plugin's
 * `clientConfig()`.
 *
 * Only the irreducible data lives here: `basePath` (the one path the
 * client can't otherwise know, since it encodes the plugin's mount
 * name) plus the runtime agent roster. Every concrete endpoint URL is
 * derived from `basePath` by the browser client
 * (`MastraPluginClient`) using the shared {@link MASTRA_ROUTES}
 * segments, so there's nothing to publish per-route.
 *
 * Fields:
 *   - `basePath`: plugin mount path. Always `/api/<pluginName>`. Feed
 *     it to `new MastraPluginClient(config)` (from
 *     `@dbx-tools/appkit-mastra-ui`) to get a typed client over every
 *     route plus the standard agent stream.
 *   - `defaultAgent`: agent id the client converses with when it
 *     doesn't name one.
 *   - `agents`: every registered agent id in registration order.
 */
export const MastraClientConfigSchema = z.object({
  basePath: z.string(),
  defaultAgent: z.string(),
  agents: z.array(z.string()),
});
export type MastraClientConfig = z.infer<typeof MastraClientConfigSchema>;

/* ---------------------------- model catalogue ---------------------------- */

/**
 * JSON payload returned by `GET ${basePath}/models`. Wraps the shared
 * {@link ServingEndpointSummarySchema} (re-exported from
 * `@dbx-tools/model-shared` via the package index) so the catalogue
 * descriptor has a single definition the client, server, and the
 * standalone `@dbx-tools/model` toolkit all agree on.
 */
export const ServingEndpointsResponseSchema = z.object({
  endpoints: z.array(ServingEndpointSummarySchema),
});
export type ServingEndpointsResponse = z.infer<typeof ServingEndpointsResponseSchema>;

/* ----------------------------- chat history ----------------------------- */

/**
 * Structural shape for an AI SDK V5 `UIMessage`. Defined locally
 * so the shared types package stays dependency-free (no `ai`
 * import). The runtime values returned by the `/history` endpoint
 * are produced by `toAISdkV5Messages` and are 1:1 compatible with
 * `UIMessage` from the `ai` package; clients can safely cast when
 * needed.
 */
export const MastraHistoryUIMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["system", "user", "assistant"]),
  parts: z.array(z.unknown()).readonly(),
  metadata: z.unknown().optional(),
});
export type MastraHistoryUIMessage = z.infer<typeof MastraHistoryUIMessageSchema>;

/**
 * JSON payload returned by `GET ${basePath}/history`.
 *
 * Fields:
 *   - `uiMessages`: page of UI-formatted messages, oldest -> newest.
 *     Always chronological regardless of the underlying pagination
 *     order so the client can prepend the array to the live
 *     transcript without sorting.
 *   - `page`: zero-indexed page that produced this response.
 *   - `perPage`: number of items requested per page.
 *   - `total`: total number of messages in the thread.
 *   - `hasMore`: true when at least one older page is still
 *     available.
 */
export const MastraHistoryResponseSchema = z.object({
  uiMessages: z.array(MastraHistoryUIMessageSchema),
  page: z.number(),
  perPage: z.number(),
  total: z.number(),
  hasMore: z.boolean(),
});
export type MastraHistoryResponse = z.infer<typeof MastraHistoryResponseSchema>;

/**
 * JSON payload returned by `DELETE ${basePath}/history`. Deletes
 * every persisted message + workflow snapshot tied to the caller's
 * thread, so the next chat turn starts from a clean slate. The
 * session cookie that anchors the thread id is preserved so the
 * caller doesn't lose its identity - only the contents go away.
 *
 * `ok` is always `true` on success; the response object is kept
 * as a struct (vs a bare 204) so future fields (e.g. `deletedAt`,
 * `messages`) can be added without bumping the contract.
 *
 * Fields:
 *   - `ok`: literal `true` on success.
 *   - `agentId`: agent whose history was cleared.
 *   - `threadId`: thread id that was wiped.
 *   - `cleared`: number of messages the thread held before
 *     deletion. Useful for client-side "cleared 12 messages"
 *     toasts; `0` is reported when the thread was already empty
 *     (call is idempotent).
 */
export const MastraClearHistoryResponseSchema = z.object({
  ok: z.literal(true),
  agentId: z.string(),
  threadId: z.string(),
  cleared: z.number(),
});
export type MastraClearHistoryResponse = z.infer<
  typeof MastraClearHistoryResponseSchema
>;

/* -------------------------------- threads -------------------------------- */

/**
 * A single conversation thread the resource (authenticated user) owns,
 * as returned by `GET ${basePath}/threads`. Mirrors Mastra's
 * `StorageThreadType` but with JSON-safe ISO-8601 timestamps (the wire
 * can't carry `Date`).
 *
 * Fields:
 *   - `id`: thread id. Pass it back as the thread-selection header
 *     (`THREAD_ID_HEADER`) on a stream / history / delete call to act
 *     on this conversation.
 *   - `title`: human-readable title. Present once the agent's memory
 *     has auto-generated one (after the first turn); absent on a
 *     brand-new thread, so the UI falls back to a placeholder.
 *   - `resourceId`: owning resource (the user id). Always the caller's
 *     own resource - the list route filters by it server-side.
 *   - `createdAt` / `updatedAt`: ISO-8601 timestamps. `updatedAt` is
 *     the natural sort key for "most recent conversations first".
 *   - `metadata`: opaque thread metadata, passed through untouched.
 */
export const MastraThreadSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  resourceId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  metadata: z.unknown().optional(),
});
export type MastraThread = z.infer<typeof MastraThreadSchema>;

/**
 * JSON payload returned by `GET ${basePath}/threads`. One page of the
 * caller's conversation threads, newest (`updatedAt` DESC) first.
 *
 * Fields:
 *   - `threads`: page of threads for the caller's resource.
 *   - `page`: zero-indexed page that produced this response.
 *   - `perPage`: number of items requested per page.
 *   - `total`: total number of threads the resource owns.
 *   - `hasMore`: true when at least one more page is available.
 */
export const MastraThreadsResponseSchema = z.object({
  threads: z.array(MastraThreadSchema),
  page: z.number(),
  perPage: z.number(),
  total: z.number(),
  hasMore: z.boolean(),
});
export type MastraThreadsResponse = z.infer<typeof MastraThreadsResponseSchema>;

/**
 * JSON payload returned by `DELETE ${basePath}/threads` (thread id
 * supplied via the thread-selection header / `threadId` query). Wipes
 * the named thread and every message on it.
 *
 * Fields:
 *   - `ok`: literal `true` on success.
 *   - `agentId`: agent whose thread was deleted.
 *   - `threadId`: thread id that was removed.
 *   - `deleted`: `true` when a thread row existed and was removed,
 *     `false` when it was already gone (call is idempotent).
 */
export const MastraDeleteThreadResponseSchema = z.object({
  ok: z.literal(true),
  agentId: z.string(),
  threadId: z.string(),
  deleted: z.boolean(),
});
export type MastraDeleteThreadResponse = z.infer<
  typeof MastraDeleteThreadResponseSchema
>;

/* ------------------------------ suggestions ------------------------------ */

/**
 * JSON payload returned by `GET ${basePath}/suggestions`.
 *
 * Carries the curated starter questions for an agent's Genie space -
 * the `sample_questions` an author configured on the space, surfaced
 * as one-tap prompts on the chat's empty state. `questions` is empty
 * when the agent has no Genie space (or the space defines none), so
 * the client renders nothing in that case rather than falling back to
 * built-in example prompts.
 */
export const MastraSuggestionsResponseSchema = z.object({
  questions: z.array(z.string()),
});
export type MastraSuggestionsResponse = z.infer<typeof MastraSuggestionsResponseSchema>;

/* --------------------------------- charts --------------------------------- */

/**
 * Allowed chart types the planner can pick. Defined as a
 * discriminated literal union so each variant carries its own
 * `.describe()` clause - the server-side planner's prompt
 * formatter walks `.options` to inline the descriptions into the
 * model instructions, keeping the prompt in lock-step with the
 * schema by construction. The runtime type is the plain string
 * union (`"bar" | "line" | ...`), so consumers that just need a
 * discriminator value behave the same as if it were a
 * `z.enum([...])`.
 */
export const ChartTypeSchema = z
  .union([
    z
      .literal("bar")
      .describe(
        "comparing a numeric value across a small/medium set of discrete categories (top-N, ranking, group-by)",
      ),
    z
      .literal("line")
      .describe(
        "ordered-axis trend (time series, sequence, rank) where the x-axis has natural order",
      ),
    z
      .literal("area")
      .describe("stacked-trend emphasis - cumulative or composition over time"),
    z
      .literal("scatter")
      .describe(
        "two-numeric-axis correlations between fields (e.g. price vs. quantity)",
      ),
    z
      .literal("pie")
      .describe("parts-of-a-whole when 2-7 categories sum to a meaningful total"),
  ])
  .describe("The chart shape that best matches the data and intent.");
export type ChartType = z.infer<typeof ChartTypeSchema>;

/**
 * Resolved chart plan a settled chart entry carries on its
 * `result` field. `option` is the full Echarts spec; pass
 * straight into `<ReactECharts option={...}>`.
 */
export const ChartResultSchema = z.object({
  chartType: ChartTypeSchema,
  option: z
    .record(z.string(), z.unknown())
    .describe(
      "Fully-resolved Echarts `EChartsOption` JSON for this chart - drop directly into an Echarts instance (or `<ReactECharts option={...} />`) without further processing. Includes title / tooltip / legend / grid / axis / series defaults already merged in.",
    ),
});
export type ChartResult = z.infer<typeof ChartResultSchema>;

/**
 * Wire-format AND server-side cache shape for a chart entry.
 * Three lifecycle states inferred from the two optional fields
 * (no discriminator needed):
 *
 *   - `result` set                    -> chart is ready to render
 *   - `error` set                     -> planner / data fetch failed
 *   - both `result` and `error` unset -> still processing
 *
 * `option` is typed as a generic record so this package stays
 * dependency-free of `echarts`. The server (`chart.ts`) imports
 * this schema directly; the demo client polls the
 * `/embed/chart/:id` route and parses responses against it.
 */
export const ChartSchema = z.object({
  chartId: z
    .string()
    .describe(
      "Opaque id minted by the chart subsystem. Embed verbatim as `[chart:<chartId>]` in agent prose; the host UI resolves it against this cache entry.",
    ),
  error: z
    .string()
    .optional()
    .describe(
      "Error message when the chart failed (data fetch error, planner error, empty dataset). Mutually exclusive with `result`; absent on success and while processing.",
    ),
  result: ChartResultSchema.optional().describe(
    "Resolved chart plan. Absent while processing and when the run errored.",
  ),
});
export type Chart = z.infer<typeof ChartSchema>;

/* ------------------------------- statements ------------------------------- */

/**
 * Wire-format payload returned by `GET ${basePath}/embed/data/:id`.
 *
 * Mirrors the agent-side `get_statement` tool's output so the
 * host UI and the LLM see the exact same shape for the same
 * statement; the route is what resolves `[data:<statement_id>]`
 * markers the agent embeds in prose.
 *
 * Fields:
 *   - `columns`: column names in declaration order.
 *   - `rows`: row records keyed by column name. Cell values are
 *     either coerced numbers or the original strings (Genie /
 *     Statement Execution returns every cell as `string | null`;
 *     numeric-looking cells are coerced server-side so the UI
 *     can format with `tabular-nums` without re-parsing).
 *   - `rowCount`: total row count upstream (independent of the
 *     `limit` cap). Compare against `rows.length` to detect
 *     truncation - `truncated` is the precomputed flag.
 *   - `truncated`: `true` when the server clipped rows to honor
 *     the route's row cap; the UI should surface a "showing N of
 *     M rows" affordance in that case.
 */
export const StatementDataSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
  rowCount: z.number(),
  truncated: z.boolean(),
});
export type StatementData = z.infer<typeof StatementDataSchema>;

/* ----------------------------- writer surface ---------------------------- */

/**
 * The `ToolStream`-shaped writer the Mastra Genie agent and chart
 * helpers publish events through. Defined here (vs imported from
 * `@mastra/core`) so helpers in `@dbx-tools/appkit-mastra` can
 * accept any object with a `.write` method without dragging
 * Mastra's full `ToolStream` (and its agent / tool typings) into
 * call sites. The actual Mastra `ctx.writer` is assignable to
 * this shape so callers pass it straight through.
 *
 * Kept as a plain TypeScript interface (vs a zod schema) because
 * the contract is a method - zod can only validate the shape via
 * `z.custom`, which adds noise without buying any runtime check.
 */
export interface MastraWriter {
  write: (chunk: unknown) => unknown;
}

/* ---------------- mastra-only genie-agent events ---------------- */

/**
 * Mastra-only lifecycle event: the Genie tool invocation started.
 * Emitted immediately when the calling agent invokes the Genie
 * tool, before any inner agent / wire activity, so the UI can
 * pop a "Thinking..." pill the instant the model decides to
 * delegate. `conversationId` / `messageId` are absent on this
 * first emit (no Genie round-trip yet). Field names are
 * camelCase (vs the snake_case wire events) to mirror the
 * Genie agent's own internal data plumbing.
 */
export const StartedEventSchema = z.object({
  type: z.literal("started"),
  spaceId: z.string(),
  /**
   * Genie conversation id, populated only when this `started`
   * event corresponds to a follow-up turn on an existing
   * conversation. Absent on the first turn.
   */
  conversationId: z.string().optional(),
  /**
   * Genie message id, populated only after the first wire
   * `message` event lands. Absent on the immediate-on-invoke
   * emit.
   */
  messageId: z.string().optional(),
  /** Question the Genie agent sent to Genie. */
  content: z.string(),
});
export type StartedEvent = z.infer<typeof StartedEventSchema>;

/**
 * Mastra-only lifecycle event: one `ask_genie` invocation
 * finished. Carries the hydrated `statementIds` (rows are fetched
 * via `getStatement` separately) and Genie's final prose answer
 * so the UI can move from "thinking" to "answered" without
 * waiting for the Genie agent's whole reasoning loop to end.
 */
export const AskGenieDoneEventSchema = z.object({
  type: z.literal("ask_genie_done"),
  spaceId: z.string(),
  conversationId: z.string().optional(),
  messageId: z.string().optional(),
  /** Genie's natural-language answer for the turn, if any. */
  answer: z.string().optional(),
  /** Statement ids for any non-empty result sets this turn produced. */
  statementIds: z.array(z.string()),
  /**
   * Terminal wire status (`COMPLETED` / `FAILED` / `CANCELLED`).
   * Mirrors the source `result` event's status so subscribers
   * can react to ask-level completion without re-walking history.
   * Treated as `z.custom<MessageStatus>` because the SDK is the
   * source of truth for the enum values.
   */
  status: z.custom<MessageStatus>((v) => typeof v === "string"),
});
export type AskGenieDoneEvent = z.infer<typeof AskGenieDoneEventSchema>;

/**
 * Mastra-only error event: terminal Genie agent / transport
 * error. Genie's own `FAILED` / `CANCELLED` come through the
 * wire's `result` event - this variant is for failures the wire
 * can't represent (network, Genie agent crash, planner error,
 * etc.) plus a UI-friendly mirror of `result` when the status is
 * non-`COMPLETED`.
 */
export const MastraGenieErrorEventSchema = z.object({
  type: z.literal("error"),
  spaceId: z.string().optional(),
  conversationId: z.string().optional(),
  messageId: z.string().optional(),
  error: z.string(),
});
export type MastraGenieErrorEvent = z.infer<typeof MastraGenieErrorEventSchema>;

/**
 * Mastra-only lifecycle event: the inner Genie agent's
 * structured-output coercion has landed. Fires once per Genie
 * tool invocation, AFTER `agent.generate(...)` completes (i.e.
 * the inner loop + Mastra's structuring pass have both
 * finished) and BEFORE the wrapper hydrates each `data` item
 * with a chart. Signals to the host UI that the agent has
 * stopped reasoning and is moving into chart generation.
 *
 * The structuring pass itself is opaque (it runs inside
 * Mastra's `agent.generate(...)` together with the tool loop)
 * so this is the earliest hook we can offer; we can't fire a
 * "summary started" event the way we fire `started`.
 */
export const SummaryEventSchema = z.object({
  type: z.literal("summary"),
  spaceId: z.string(),
  /** Total number of items in the agent's structured summary. */
  items: z.number().int().nonnegative(),
  /** Count of `text` / prose items in the summary. */
  textItems: z.number().int().nonnegative(),
  /**
   * Count of `data` items the wrapper will hydrate into charts.
   * The host UI can use this to seed N chart skeletons before
   * the per-chart events arrive.
   */
  dataItems: z.number().int().nonnegative(),
});
export type SummaryEvent = z.infer<typeof SummaryEventSchema>;

/**
 * Mastra-only event union. Each variant uses the same flat
 * `{type, ...fields}` shape as {@link GenieChatEvent} so
 * subscribers union both with a single `switch (event.type)`.
 */
export const GenieAgentEventSchema = z.discriminatedUnion("type", [
  StartedEventSchema,
  AskGenieDoneEventSchema,
  MastraGenieErrorEventSchema,
  SummaryEventSchema,
]);
export type GenieAgentEvent = z.infer<typeof GenieAgentEventSchema>;

/**
 * The unified writer-event vocabulary subscribers see on
 * `ctx.writer`: the wire-derived {@link GenieChatEvent} union
 * **plus** Mastra-only events from {@link GenieAgentEvent}. Each
 * variant is a flat `{type, ...fields}` object; consumers narrow
 * on `type` and read fields inline - there is no payload wrapper
 * and no writer-boundary translator.
 *
 * Composed via `z.union` (not `z.discriminatedUnion`) because
 * both halves are themselves discriminated unions on the same
 * `type` key.
 */
export const GenieWriterEventSchema = z.union([
  GenieChatEventSchema,
  GenieAgentEventSchema,
]);
export type GenieWriterEvent = z.infer<typeof GenieWriterEventSchema>;

/** Discriminator type for {@link GenieWriterEvent}. */
export type GenieWriterEventType = GenieWriterEvent["type"];

/* ------------------------- summary + dataset ------------------------ */

/**
 * Tabular payload embedded in every {@link GenieSummaryItem}
 * `visualize` dataset. Always present: hydrated by the workflow's
 * agent step before the finalize step runs, so consumers can render
 * a table fallback regardless of chart-planner outcome.
 *
 * Fields:
 *   - `columns`: column names in display order.
 *   - `rows`: tabular rows keyed by column name.
 *   - `rowCount`: total row count Genie reported (may exceed
 *     `rows.length` when the statement was truncated).
 */
export const GenieDatasetDataSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
  rowCount: z.number(),
});
export type GenieDatasetData = z.infer<typeof GenieDatasetDataSchema>;

/**
 * Slim chart reference attached to a visualize dataset. Only
 * present when planning succeeded.
 *
 * `option` is intentionally NOT included. The resolved Echarts
 * spec lives off-band in the chart cache: the host UI fetches it
 * by `chartId` via `${MastraClientConfig.embedPathTemplate}`
 * (`/embed/chart/:id`, see {@link Chart}). Embedding the full spec inline would
 * inflate every dataset by several KB per chart and round-trip
 * through the LLM context for zero benefit (the model only needs
 * the `chartId` to place a `[chart:<chartId>]` marker in its
 * reply).
 */
export const GenieDatasetChartSchema = z.object({
  chartId: z.string(),
  chartType: z.enum(["bar", "line", "area", "scatter", "pie"]),
});
export type GenieDatasetChart = z.infer<typeof GenieDatasetChartSchema>;

/**
 * Dataset bundle attached to a {@link GenieSummaryItem} `visualize`
 * item. `data` is always populated; `chart` is best-effort and
 * absent when the workflow's chart-planner failed (timeout,
 * malformed plan, abort) so the host UI can still render the
 * underlying table.
 */
export const GenieDatasetSchema = z.object({
  data: GenieDatasetDataSchema,
  chart: GenieDatasetChartSchema.optional(),
});
export type GenieDataset = z.infer<typeof GenieDatasetSchema>;

/**
 * One item inside the Genie workflow's final summary. The
 * workflow produces a mixed sequence of:
 *
 *   - `string`: a markdown paragraph (interpretation, callouts,
 *     transitions between data blocks).
 *   - `visualize`: a request from the agent step to visualize a
 *     specific Genie statement at this position in the prose.
 *     The finalize step hydrates `dataset.data` (rows from the
 *     matching `statementId`) and attaches `dataset.chart` after
 *     running the chart-planner. The agent NEVER picks the chart
 *     type - it only marks where a visualization belongs.
 *
 * The host UI walks the array in display order to compose the
 * final assistant message.
 */
export const GenieSummaryItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("string"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("visualize"),
    statementId: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    dataset: GenieDatasetSchema,
  }),
]);
export type GenieSummaryItem = z.infer<typeof GenieSummaryItemSchema>;

/** Discriminator type for {@link GenieSummaryItem}. */
export type GenieSummaryItemType = GenieSummaryItem["type"];

/**
 * The Genie agent's final output shape - what the calling agent's
 * Genie tool returns to the calling LLM. The `summary` array is
 * the user-facing renderable; `conversationId` lets the calling
 * agent (or the UI) follow up in the same Genie thread on the
 * next turn.
 */
export const GenieAgentResultSchema = z.object({
  spaceId: z.string(),
  conversationId: z.string().optional(),
  summary: z.array(GenieSummaryItemSchema),
  error: z.string().optional(),
});
export type GenieAgentResult = z.infer<typeof GenieAgentResultSchema>;
