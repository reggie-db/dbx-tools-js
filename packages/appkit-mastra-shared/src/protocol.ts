/**
 * Shape of the data published by {@link MastraPlugin.clientConfig}.
 * Kept dependency-free (no `pg`, no `fastembed`, no Mastra runtime)
 * so the React client can import these schemas without dragging in
 * server-only dependencies.
 *
 * Server-side, `MastraPlugin` derives every path from the plugin
 * mount (AppKit conventionally serves plugin `foo` at `/api/foo`).
 * Publishing the resolved paths lets the client compute URLs
 * without hard-coding `/api/mastra` anywhere - rename the plugin
 * and the React client keeps working.
 *
 * URL helpers live in the sibling `mastra.ts` module so this file
 * stays purely declarative (schemas + inferred types only).
 *
 * @example
 * ```tsx
 * import { usePluginClientConfig } from "@databricks/appkit-ui/react";
 * import { chatUrl, type MastraClientConfig } from "@dbx-tools/appkit-mastra-shared";
 *
 * const config = usePluginClientConfig<MastraClientConfig>("mastra");
 * const transport = new DefaultChatTransport({
 *   api: chatUrl(config, selectedAgentId),
 * });
 * ```
 */

import { z } from "zod";

/* ---------------------------- client config ---------------------------- */

/**
 * JSON-safe descriptor published by the Mastra plugin's
 * `clientConfig()`.
 *
 * Fields:
 *   - `basePath`: plugin mount path. Always `/api/<pluginName>`.
 *   - `chatPath`: chat endpoint for the **default** agent, i.e.
 *     `${basePath}/route/chat`. Equivalent to `chatUrl(config)`.
 *   - `chatPathTemplate`: template form used by the route handler:
 *     `${basePath}/route/chat/:agentId`. Provided for documentation
 *     / tools that want the OpenAPI-style placeholder; clients
 *     should normally call {@link chatUrl} instead.
 *   - `modelsPath`: models catalogue endpoint: `${basePath}/models`.
 *   - `historyPath`: thread history endpoint for the **default**
 *     agent: `${basePath}/route/history`. Returns AI SDK V5
 *     `UIMessage`s for the current session's thread; takes `page`
 *     and `perPage` query params. See {@link historyUrl}.
 *   - `historyPathTemplate`: templated form of `historyPath`:
 *     `${basePath}/route/history/:agentId`. Use this to reach a
 *     non-default agent's history; clients should normally call
 *     {@link historyUrl} instead.
 *   - `embedPathTemplate`: templated generic embed fetch endpoint:
 *     `${basePath}/embed/:type/:id`. One route resolves every embed
 *     marker the agent emits: `:type` is the marker's `<type>`
 *     token (`chart`, `data`, ...) and `:id` its id. The server
 *     dispatches on `:type` through its resolver registry and 404s
 *     any type it doesn't register, so new embed kinds are
 *     server-only changes. Behavior is per-type:
 *       - `chart`: long-polls the chart cache until the entry
 *         settles (`result` / `error`) or the server budget
 *         elapses (then returns the still-`processing` entry to
 *         poll again). 404 once the 1h TTL expires. Optional
 *         `?timeoutMs=<n>` (default 60s, capped at 5min).
 *       - `data`: one OBO-scoped fetch returns the rows of a Genie
 *         / Statement Execution result. Optional `?limit=<n>`
 *         caps rows (server clamps). 404 when the statement id is
 *         unknown / expired upstream.
 *     Clients should call {@link embedUrl} rather than substituting
 *     the placeholders by hand.
 *   - `defaultAgent`: agent id `chatRoute` binds to when the client
 *     doesn't name one.
 *   - `agents`: every registered agent id in registration order.
 */
export const MastraClientConfigSchema = z.object({
  basePath: z.string(),
  chatPath: z.string(),
  chatPathTemplate: z.string(),
  modelsPath: z.string(),
  historyPath: z.string(),
  historyPathTemplate: z.string(),
  embedPathTemplate: z.string(),
  defaultAgent: z.string(),
  agents: z.array(z.string()),
});
export type MastraClientConfig = z.infer<typeof MastraClientConfigSchema>;

/* ---------------------------- model catalogue ---------------------------- */

/**
 * Minimal descriptor for a Databricks Model Serving endpoint.
 * Mirrors the server-side `ServingEndpointSummary` from `serving.ts`
 * and is kept here so the React client can type the `/models`
 * response without importing the full plugin (which would pull in
 * `pg`, `fastembed`, and Mastra itself).
 *
 * Fields:
 *   - `name`: endpoint name as listed by the Model Serving REST API.
 *   - `task`: task hint (e.g. `"llm/v1/chat"`). Useful for filtering.
 *   - `state`: ready / updating / failed state.
 *   - `description`: free-form description; mostly informational.
 */
export const ServingEndpointSummarySchema = z.object({
  name: z.string(),
  task: z.string().optional(),
  state: z.string().optional(),
  description: z.string().optional(),
});
export type ServingEndpointSummary = z.infer<typeof ServingEndpointSummarySchema>;

/** JSON payload returned by `GET ${basePath}/models`. */
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
export type MastraClearHistoryResponse = z.infer<typeof MastraClearHistoryResponseSchema>;

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
