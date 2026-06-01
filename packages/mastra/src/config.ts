/**
 * Plugin configuration types and shared `RequestContext` keys.
 *
 * Kept in a leaf module so `plugin.ts`, `server.ts`, `model.ts`, and
 * `memory.ts` can import them without creating a cycle.
 */

import type { BasePluginConfig, getExecutionContext } from "@databricks/appkit";
import type { AgentConfig } from "@mastra/core/agent";
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
   * Code-defined agents. Accepts three shapes for convenience:
   *
   * - **Record**: `{ analyst: def, helper: def }` - keys become the
   *   registered ids and the first key is the default.
   * - **Single definition**: `def` - registered under
   *   `slugify(def.name)` (or `"default"` when `name` is omitted) and
   *   automatically marked as the default agent.
   * - **Array**: `[def1, def2]` - each registered under
   *   `slugify(def.name)` (or `agent_${i}` when `name` is omitted);
   *   the first entry is the default.
   *
   * Each entry becomes a Mastra `Agent` reachable at
   * `/api/<plugin>/route/chat/<id>` (the chat route also matches
   * `:agentId`). When `agents` is omitted entirely, the plugin
   * registers a single built-in `default` analyst so the bare
   * `mastra()` call still mounts a working chat endpoint.
   *
   * @example Single-agent shorthand
   * ```ts
   * mastra({
   *   agents: createAgent({ instructions: "..." }),
   * });
   * ```
   *
   * @example Array
   * ```ts
   * mastra({
   *   agents: [
   *     createAgent({ name: "analyst", instructions: "..." }),
   *     createAgent({ name: "helper", instructions: "..." }),
   *   ],
   * });
   * ```
   *
   * @example Record (explicit ids)
   * ```ts
   * mastra({
   *   agents: {
   *     analyst: createAgent({ instructions: "..." }),
   *     helper: createAgent({ instructions: "..." }),
   *   },
   *   defaultAgent: "analyst",
   * });
   * ```
   */
  agents?:
    | Record<string, MastraAgentDefinition>
    | MastraAgentDefinition
    | MastraAgentDefinition[];
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
  /**
   * Plugin-level default model applied to every agent that omits its
   * own `model`. Mirrors AppKit's `agents({ defaultModel })`.
   *
   * - `string`: shorthand for "use the OBO auto-resolver but swap the
   *   `modelId`" (e.g. `"databricks-claude-sonnet-4-6"`).
   * - Any other Mastra `DynamicArgument<MastraModelConfig>`: passed
   *   through verbatim. Use this when you need full control over auth
   *   or `providerId`.
   *
   * Resolution order per agent: `def.model` → `defaultModel` →
   * built-in `/serving-endpoints` resolver.
   */
  defaultModel?: AgentConfig["model"] | string;
  /**
   * Allow loose model names (`"claude sonnet"`) to be fuzzy-matched
   * against the workspace's Model Serving endpoints. Defaults to
   * `true`; set `false` to require exact endpoint names everywhere.
   */
  modelFuzzyMatch?: boolean;
  /**
   * Fuse.js score threshold for the fuzzy matcher (0 = exact match,
   * 1 = anything matches). Defaults to `0.4`. Lower values reject
   * loose matches; raise it if you have a sprawling endpoint
   * catalogue with similar-looking names.
   */
  modelFuzzyThreshold?: number;
  /**
   * TTL for the in-memory serving-endpoints list cache, in
   * milliseconds. Defaults to 5 minutes. The cache is per workspace
   * host and shared across users; concurrent callers coalesce on a
   * single in-flight fetch.
   */
  modelCacheTtlMs?: number;
  /**
   * Allow clients to override the active model per request via the
   * `X-Mastra-Model` header, `?model=` query string, or `model` body
   * field. Defaults to `true`. Disable when running multi-tenant
   * where untrusted clients shouldn't pick the backing endpoint.
   */
  modelOverride?: boolean;
  /**
   * Priority-ordered list of endpoint names tried when no agent /
   * plugin / env / request-override model id is set. The resolver
   * picks the first id that is actually present in the workspace's
   * `/serving-endpoints` listing - this is what lets a workspace
   * without Claude Opus still get a sensible default automatically.
   *
   * Defaults to the built-in list in `model.ts` (`FALLBACK_MODEL_IDS`):
   * Claude (Opus -> Sonnet -> Haiku), then OpenAI GPT-5 family, then
   * open weights (Llama 4, Llama 3.3, GPT-OSS, Qwen, Llama 3.1).
   * Override here to pin a regulated workspace to an approved subset
   * or to add custom endpoints in front of the public catalogue.
   */
  defaultModelFallbacks?: readonly string[];
}
