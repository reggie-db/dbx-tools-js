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
