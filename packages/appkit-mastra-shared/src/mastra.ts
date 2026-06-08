/**
 * URL helpers for the Mastra plugin's published
 * {@link MastraClientConfig} surface. Kept in a separate module
 * from `protocol.ts` so the protocol stays purely declarative
 * (schemas + inferred types) and consumers that only need URL
 * composition import this file without re-evaluating the schemas.
 *
 * Both helpers accept a `Pick<MastraClientConfig, ...>` so callers
 * can pass a freshly read config or any object that exposes the
 * relevant fields - useful for tests and for partial configs the
 * React client composes from `usePluginClientConfig`.
 */

import type { MastraClientConfig } from "./protocol.js";

/**
 * Compute the chat URL for a given agent, falling back to the
 * default when `agentId` is omitted. Returns `config.chatPath`
 * directly for the default agent (the `chatRoute` mount that does
 * not require an `:agentId` segment).
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

/**
 * Build the chart fetch URL for a given `chartId`.
 * Substitutes the `:chartId` placeholder in
 * {@link MastraClientConfig.chartsPathTemplate} and appends
 * `?timeoutMs=<n>` when an explicit long-poll budget is supplied.
 *
 * The host UI typically polls this URL when it encounters a
 * `[chart:<chartId>]` marker in an assistant reply: the server
 * blocks until the chart cache entry transitions to
 * `ready` / `error` or the long-poll budget elapses, at which
 * point it returns the last seen value (still `processing`) so
 * the client can re-poll. A `404` means the chartId is unknown
 * or its 1h TTL has elapsed; treat it as a missing slot.
 */
export function chartUrl(
  config: Pick<MastraClientConfig, "chartsPathTemplate">,
  chartId: string,
  options: { timeoutMs?: number } = {},
): string {
  const base = config.chartsPathTemplate.replace(
    ":chartId",
    encodeURIComponent(chartId),
  );
  if (options.timeoutMs === undefined) return base;
  const params = new URLSearchParams();
  params.set("timeoutMs", String(options.timeoutMs));
  return `${base}?${params.toString()}`;
}

/**
 * Build the statement fetch URL for a given `statementId`.
 * Substitutes the `:statementId` placeholder in
 * {@link MastraClientConfig.statementsPathTemplate} and appends
 * `?limit=<n>` when an explicit row cap is supplied.
 *
 * The host UI hits this URL when it encounters a
 * `[data:<statement_id>]` marker in an assistant reply: a single
 * OBO-scoped fetch returns the rows of the corresponding Genie /
 * Statement Execution result so the client can render an inline
 * table. A `404` means the statement id is unknown or no longer
 * resolvable through the workspace; treat as a missing slot.
 */
export function statementUrl(
  config: Pick<MastraClientConfig, "statementsPathTemplate">,
  statementId: string,
  options: { limit?: number } = {},
): string {
  const base = config.statementsPathTemplate.replace(
    ":statementId",
    encodeURIComponent(statementId),
  );
  if (options.limit === undefined) return base;
  const params = new URLSearchParams();
  params.set("limit", String(options.limit));
  return `${base}?${params.toString()}`;
}
