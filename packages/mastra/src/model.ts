/**
 * Databricks Model Serving resolver for Mastra agents.
 *
 * Each agent step calls {@link buildModel} with the active
 * `RequestContext`. The user stamped by `MastraServer` carries an
 * AppKit `WorkspaceClient`; we ask it for the workspace host and a
 * fresh bearer header, then point Mastra's OpenAI-compatible provider
 * at `/serving-endpoints` on that host.
 */

import type { MastraModelConfig } from "@mastra/core/llm";
import type { RequestContext } from "@mastra/core/request-context";

import { MASTRA_USER_KEY, type MastraPluginConfig, type User } from "./config.js";

/**
 * Resolve a `MastraModelConfig` for the current agent step.
 *
 * Runs while `agent.stream` is inside the `asUser(req)` scope so tokens
 * are user-scoped. Outside an active user context, the workspace
 * client falls back to the service principal, which is still a valid
 * token source for internal calls.
 */
export async function buildModel(
  config: MastraPluginConfig,
  requestContext: RequestContext,
): Promise<MastraModelConfig> {
  const user = requestContext.get(MASTRA_USER_KEY) as User;
  const clientConfig = user.executionContext.client.config;
  const host = await clientConfig.getHost();
  const headers = new Headers();
  await clientConfig.authenticate(headers);
  // The OpenAI Node SDK appends paths like `/chat/completions` to whatever
  // URL we hand it. Drop the trailing slash so the resulting URL stays
  // well-formed (`/serving-endpoints/chat/completions`).
  const url = new URL("/serving-endpoints", host).toString().replace(/\/$/, "");
  return {
    providerId: config.providerId ?? "databricks",
    modelId: "databricks-claude-sonnet-4-6",
    url,
    headers: Object.fromEntries(headers.entries()),
  };
}
