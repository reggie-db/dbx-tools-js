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
 * Build the generic embed fetch URL for a marker of kind `type`
 * and the given `id`. Substitutes the `:type` and `:id`
 * placeholders in {@link MastraClientConfig.embedPathTemplate}
 * (`${basePath}/embed/:type/:id`) and appends any `query` entries
 * as query-string params.
 *
 * This is the single resolver for every embed marker the agent
 * emits - `[chart:<id>]`, `[data:<id>]`, and any future kind. The
 * `type` segment is opaque here; the server dispatches on it and
 * returns `404` for a type it doesn't register (or for an
 * unknown / expired id of a known type), which the host treats as
 * a missing slot. Per-type query knobs ride in `query`:
 *
 *   - `chart`: `{ timeoutMs }` tunes the long-poll window.
 *   - `data`: `{ limit }` caps the rows returned.
 *
 * @example
 * ```ts
 * embedUrl(config, "chart", chartId, { timeoutMs: 30_000 });
 * embedUrl(config, "data", statementId, { limit: 100 });
 * ```
 */
export function embedUrl(
  config: Pick<MastraClientConfig, "embedPathTemplate">,
  type: string,
  id: string,
  query: Record<string, number | string> = {},
): string {
  const base = config.embedPathTemplate
    .replace(":type", encodeURIComponent(type))
    .replace(":id", encodeURIComponent(id));
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}
