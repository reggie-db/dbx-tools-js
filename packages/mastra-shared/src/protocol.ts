/**
 * Shape of the data published by {@link MastraPlugin.clientConfig} plus
 * a tiny URL helper. Kept dependency-free so the React client can
 * import it without dragging in `pg`, `fastembed`, or Mastra itself.
 *
 * Server-side, `MastraPlugin` derives every path from the plugin mount
 * (AppKit conventionally serves plugin `foo` at `/api/foo`). Publishing
 * the resolved paths lets the client compute URLs without hard-coding
 * `/api/mastra` anywhere - rename the plugin and the React client
 * keeps working.
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

/** JSON-safe descriptor published by the Mastra plugin's `clientConfig()`. */
export interface MastraClientConfig {
  /** Plugin mount path. Always `/api/<pluginName>`. */
  basePath: string;
  /**
   * Chat endpoint for the **default** agent, i.e.
   * `${basePath}/route/chat`. Equivalent to `chatUrl(config)`.
   */
  chatPath: string;
  /**
   * Template form used by the route handler:
   * `${basePath}/route/chat/:agentId`. Provided for documentation /
   * tools that want the OpenAPI-style placeholder; clients should
   * normally call {@link chatUrl} instead.
   */
  chatPathTemplate: string;
  /** Models catalogue endpoint: `${basePath}/models`. */
  modelsPath: string;
  /**
   * Thread history endpoint for the **default** agent:
   * `${basePath}/route/history`. Returns AI SDK V5 `UIMessage`s for
   * the current session's thread; takes `page` and `perPage` query
   * params. See {@link historyUrl}.
   */
  historyPath: string;
  /**
   * Templated form of {@link historyPath}: `${basePath}/route/history/:agentId`.
   * Use this to reach a non-default agent's history; clients should
   * normally call {@link historyUrl} instead.
   */
  historyPathTemplate: string;
  /**
   * Chart-rendering endpoint:
   * `${basePath}/route/render-chart`. POST a dataset; receive an
   * Echarts `EChartsOption` JSON. Used by the chat client to fill
   * the placeholders the model emits via `[[chart:<id>]]`
   * markers without blocking the main agent stream.
   */
  renderChartPath: string;
  /** Agent id `chatRoute` binds to when the client doesn't name one. */
  defaultAgent: string;
  /** Every registered agent id in registration order. */
  agents: string[];
}

/**
 * Minimal descriptor for a Databricks Model Serving endpoint. Mirrors
 * the server-side `ServingEndpointSummary` from `serving.ts` and is
 * kept here so the React client can type the `/models` response
 * without importing the full plugin (which would pull in `pg`,
 * `fastembed`, and Mastra itself).
 */
export interface ServingEndpointSummary {
  /** Endpoint name as listed by the Model Serving REST API. */
  name: string;
  /** Task hint (e.g. `"llm/v1/chat"`). Useful for filtering. */
  task?: string;
  /** Ready / updating / failed state. */
  state?: string;
  /** Free-form description; mostly informational. */
  description?: string;
}

/** JSON payload returned by `GET ${basePath}/models`. */
export interface ServingEndpointsResponse {
  endpoints: ServingEndpointSummary[];
}

/**
 * Compute the chat URL for a given agent, falling back to the default
 * when `agentId` is omitted. Returns `config.chatPath` directly for
 * the default agent (the `chatRoute` mount that does not require an
 * `:agentId` segment).
 */
export function chatUrl(
  config: Pick<MastraClientConfig, "chatPath" | "defaultAgent">,
  agentId?: string,
): string {
  const id = agentId ?? config.defaultAgent;
  if (!id || id === config.defaultAgent) return config.chatPath;
  return `${config.chatPath}/${encodeURIComponent(id)}`;
}

/**
 * Structural shape for an AI SDK V5 `UIMessage`. Defined locally so
 * the shared types package stays dependency-free (no `ai` import).
 * The runtime values returned by the `/history` endpoint are produced
 * by `toAISdkV5Messages` and are 1:1 compatible with `UIMessage` from
 * the `ai` package; clients can safely cast when needed.
 */
export interface MastraHistoryUIMessage {
  id: string;
  role: "system" | "user" | "assistant";
  parts: ReadonlyArray<unknown>;
  metadata?: unknown;
}

/** JSON payload returned by `GET ${basePath}/history`. */
export interface MastraHistoryResponse {
  /**
   * Page of UI-formatted messages, oldest -> newest. Always
   * chronological regardless of the underlying pagination order so
   * the client can prepend the array to the live transcript without
   * sorting.
   */
  uiMessages: MastraHistoryUIMessage[];
  /** Zero-indexed page that produced this response. */
  page: number;
  /** Number of items requested per page. */
  perPage: number;
  /** Total number of messages in the thread. */
  total: number;
  /** True when at least one older page is still available. */
  hasMore: boolean;
}

/**
 * Body accepted by `POST ${basePath}/route/render-chart`. The
 * server-side chart-planner agent picks a chart type and axis
 * encodings, then expands the result into a full
 * `EChartsOption` JSON.
 *
 * `data` is an array of objects keyed by column name (the same
 * shape every row in a SQL row set has). `title` is shown above
 * the chart; `description` is an optional one-line intent the
 * planner can use to bias chart-type selection.
 */
export interface RenderChartRequest {
  title: string;
  description?: string;
  data: Array<Record<string, unknown>>;
}

/**
 * JSON returned by `POST ${basePath}/route/render-chart`. The
 * `option` field is an Apache Echarts `EChartsOption` JSON the
 * client passes verbatim to `<ReactECharts option={...} />`.
 * `chartType` echoes the planner's pick so the caller can label
 * the chart in surrounding prose.
 */
export interface RenderChartResponse {
  option: Record<string, unknown>;
  chartType: string;
}

/**
 * Build the history URL for a given agent + page. Mirrors
 * {@link chatUrl}: the default agent uses the bare `historyPath`,
 * any other agent appends `/<encoded id>` to it. `page` and
 * `perPage` are appended as query parameters when provided.
 */
export function historyUrl(
  config: Pick<MastraClientConfig, "historyPath" | "defaultAgent">,
  options: { agentId?: string; page?: number; perPage?: number } = {},
): string {
  const id = options.agentId ?? config.defaultAgent;
  const base =
    !id || id === config.defaultAgent
      ? config.historyPath
      : `${config.historyPath}/${encodeURIComponent(id)}`;
  const params = new URLSearchParams();
  if (options.page !== undefined) params.set("page", String(options.page));
  if (options.perPage !== undefined) {
    params.set("perPage", String(options.perPage));
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}
