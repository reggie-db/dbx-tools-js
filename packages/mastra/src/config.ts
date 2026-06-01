/**
 * Plugin configuration types and shared `RequestContext` keys.
 *
 * Kept in a leaf module so `plugin.ts`, `server.ts`, `model.ts`, and
 * `memory.ts` can import them without creating a cycle.
 */

import type { BasePluginConfig, getExecutionContext } from "@databricks/appkit";
import type { PgVectorConfig, PostgresStoreConfig } from "@mastra/pg";

import type { MastraAgentDefinition, MastraTools } from "./agents.js";

/**
 * `RequestContext` key under which {@link MastraServer} stores the
 * resolved AppKit user. `model.ts` reads it to mint user-scoped
 * Databricks tokens.
 */
export const MASTRA_USER_KEY = "mastra__user";

/** AppKit execution context plus the canonical user id. */
export interface User {
  id: string;
  executionContext: ReturnType<typeof getExecutionContext>;
}

/** PgVector config with an optional Mastra store id. */
export type MastraMemoryConfig = PgVectorConfig & {
  id?: string;
};

/** Configuration accepted by the Mastra AppKit plugin. */
export interface MastraPluginConfig extends BasePluginConfig {
  /**
   * Reserved for aligning model resolution with the AppKit `serving`
   * plugin. Not read by the current implementation.
   */
  servingAlias?: string;
  /** Mastra OpenAI-compatible provider id. Defaults to `"databricks"`. */
  providerId?: string;
  /**
   * PostgresStore for Mastra threads/messages. `true` reuses the
   * `lakebase` plugin's pool; an object opens a dedicated store.
   */
  storage?: boolean | PostgresStoreConfig;
  /**
   * PgVector store for Mastra memory recall. `true` reuses the
   * `lakebase` plugin's pool; an object opens a dedicated store.
   */
  memory?: boolean | MastraMemoryConfig;
  /**
   * Code-defined agents keyed by registry id. Each entry becomes a
   * Mastra `Agent` reachable at
   * `/api/<plugin>/route/chat/<id>` (the chat route also matches
   * `:agentId`). When omitted, the plugin registers a single built-in
   * `default` analyst so the bare `mastra()` call still mounts a
   * working chat endpoint.
   *
   * @example
   * ```ts
   * mastra({
   *   agents: {
   *     analyst: {
   *       instructions: "...",
   *       tools(plugins) {
   *         return {
   *           ...(plugins.genie?.toolkit({ aliases: ["default"] }) ?? {}),
   *         };
   *       },
   *     },
   *     helper: { instructions: "..." },
   *   },
   *   defaultAgent: "analyst",
   * });
   * ```
   */
  agents?: Record<string, MastraAgentDefinition>;
  /**
   * Ambient tools spread into every registered agent's tools record;
   * per-agent tools win on key collision. Use for a small shared
   * library; for per-agent tools set `agents[id].tools` instead.
   */
  tools?: MastraTools;
  /**
   * Agent id used by `chatRoute` when the client doesn't specify one.
   * Defaults to the first key in `agents` (or `"default"` when
   * `agents` is omitted). Must match an id in `agents` when both are
   * set; a mismatch throws at setup with the available candidates.
   */
  defaultAgent?: string;
}
