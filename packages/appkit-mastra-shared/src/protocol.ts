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
 * URL helpers ({@link chatUrl}, {@link historyUrl}) live in the
 * sibling `mastra.ts` module so this file stays purely declarative
 * (schemas + inferred types only).
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
