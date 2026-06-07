/**
 * Mastra-only surface for the Genie agent that
 * `@dbx-tools/appkit-mastra` runs server-side.
 *
 * The pure Genie wire vocabulary (chat events, terminal-status
 * helpers, attachment shapes) lives in `@dbx-tools/genie-shared`
 * so anything that doesn't speak Mastra (browser bundles,
 * headless renderers, non-Mastra clients) can import the protocol
 * without dragging Mastra in. We re-export that surface from this
 * module so downstream callers keep a single
 * `@dbx-tools/appkit-mastra-shared` import.
 *
 * What lives here:
 *
 *   - {@link MinimalWriter}: structural shape of `ctx.writer`,
 *     used by every Mastra tool that publishes Genie events.
 *   - {@link GenieAgentEvent}: lifecycle and chart events the
 *     Mastra Genie agent emits that are NOT on the Genie wire
 *     (`started`, `ask_genie_done`, `error`, `chart`). Same flat
 *     `{type, ...fields}` shape as the wire's
 *     {@link GenieChatEvent} so subscribers union both with one
 *     `switch (event.type)`.
 *   - {@link GenieWriterEvent}: the unified vocabulary the Genie
 *     agent writes through `ctx.writer`. Subscribers narrow on
 *     `type` and read the event's fields directly - no
 *     translation layer.
 *   - Workflow output shapes ({@link GenieDataset},
 *     {@link GenieDatasetChart}, {@link GenieSummaryItem},
 *     {@link GenieAgentResult}): structurally Mastra-only because
 *     the agent's two-step workflow (agent step + finalize step)
 *     embeds a chart-planner output (`dataset.chart`) and a mixed
 *     `(string | visualize)[]` summary that the Genie wire knows
 *     nothing about.
 *   - {@link genieResultToWriterEvents}: helper that replays the
 *     terminal `error` event from a completed
 *     {@link GenieAgentResult} (e.g. on history reload). Chart
 *     replay is intentionally not supported - the resolved
 *     Echarts spec is held off-band on the per-request
 *     `RequestContext`, not on the persisted summary.
 *
 * Pure types and small helpers; no Node-only imports, safe for
 * browser bundles.
 */

import {
  GenieChatEventSchema,
  type GenieChatEvent,
  type MessageStatus,
} from "@dbx-tools/genie-shared";
import { z } from "zod";

/* ----------------------------- writer surface ---------------------------- */

/**
 * Minimal `ToolStream`-shaped writer the Genie agent and chart
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
export interface MinimalWriter {
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
 * Mastra-only render event: a chart was rendered for the active
 * turn. Emitted by the chart-rendering tool (and replayed from
 * `genieResultToWriterEvents` on history reload) so the host UI
 * can drop an `[[chart:<chartId>]]`-keyed slot inline. Carries
 * the dataset (for the table fallback / hover) and the resolved
 * Echarts `option` in a single event keyed by `chartId`.
 */
export const ChartEventSchema = z.object({
  type: z.literal("chart"),
  chartId: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  /** Dataset rows; populated on the first emit per `chartId`. */
  data: z.array(z.record(z.string(), z.unknown())).optional(),
  /** Echarts option spec; populated on the follow-up emit. */
  option: z.record(z.string(), z.unknown()).optional(),
  /**
   * Statement id the chart was built from, when known. Lets the
   * host UI correlate the chart with the matching `query` /
   * `statement` events from the same turn.
   */
  statementId: z.string().optional(),
  /**
   * Genie `message_id` the chart was built from. Stamped from the
   * `ask_genie` turn whose statement produced these rows so the
   * host UI can group the chart into the same pill bucket as the
   * other `message_id`-keyed events from that turn.
   */
  messageId: z.string().optional(),
});
export type ChartEvent = z.infer<typeof ChartEventSchema>;

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
  ChartEventSchema,
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
 * Slim chart reference attached to a visualize dataset once the
 * workflow's finalize step runs the chart-planner. Only present
 * when planning succeeded.
 *
 * `option` is intentionally NOT included. The resolved Echarts
 * spec lives off-band:
 *
 *   - On the wire to the UI: in the matching {@link ChartEvent}
 *     writer event (the host UI receives both this dataset and
 *     the writer event and joins them on `chartId`).
 *   - On the server: in the per-request {@link RequestContext}
 *     under the chart inventory key (see appkit-mastra's
 *     `chartInventoryFromContext`), so output processors and
 *     downstream tools can look up the full payload by `chartId`
 *     without round-tripping through the LLM.
 *
 * Why slim: full Echarts options nest deeply and are several
 * KB per chart. Embedding them in the tool result means every
 * subsequent turn of the agent loop reads them back into context
 * for zero LLM benefit (the model only needs the `chartId` to
 * place a `[[chart:<chartId>]]` marker).
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

/**
 * Structural type guard for {@link GenieAgentResult}. Used by
 * host UIs to detect the Genie agent's payload off Mastra's
 * `tool-result` chunks without coupling to a specific Mastra tool
 * name (per-space variants like `tool-genie-<alias>` all return
 * the same shape).
 *
 * Cheap structural check (vs full `safeParse`) so the guard stays
 * O(1) on the hot path; consumers that want full validation can
 * call {@link GenieAgentResultSchema}`.safeParse(value)` directly.
 */
export function isGenieAgentResult(value: unknown): value is GenieAgentResult {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.spaceId === "string" && Array.isArray(v.summary);
}

/* ---------------------- result -> writer-event helpers ---------------------- */

/**
 * Walk a {@link GenieAgentResult} and produce the lifecycle
 * writer events a host UI needs to replay terminal state inline.
 *
 * Chart replay is intentionally NOT supported: the resolved
 * Echarts `option` is held off-band in the per-request
 * `RequestContext` (and on the live writer event when the run is
 * in flight), not on the persisted summary, so a completed run
 * read back from storage has no chart spec to replay. Host UIs
 * that want post-reload chart rendering need to plumb the spec
 * through a separate persisted side-channel.
 *
 * Currently extracted:
 *
 *   - `type: "error"` when `output.error` is set (Genie returned
 *     `FAILED` / `CANCELLED`, `getStatement` errored, etc.).
 *
 * `string` summary items are not surfaced here - the calling
 * LLM's text reply renders them inline.
 */
export function genieResultToWriterEvents(output: GenieAgentResult): GenieAgentEvent[] {
  const events: GenieAgentEvent[] = [];
  if (output.error) {
    events.push({
      type: "error",
      spaceId: output.spaceId,
      ...(output.conversationId ? { conversationId: output.conversationId } : {}),
      error: output.error,
    });
  }
  return events;
}
