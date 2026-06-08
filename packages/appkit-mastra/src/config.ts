/**
 * Plugin configuration types and shared `RequestContext` keys.
 *
 * Kept in a leaf module so `plugin.ts`, `server.ts`, `model.ts`, and
 * `memory.ts` can import them without creating a cycle.
 */

import type { BasePluginConfig, getExecutionContext } from "@databricks/appkit";
import type { AgentConfig } from "@mastra/core/agent";
import {
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_THREAD_ID_KEY,
} from "@mastra/core/request-context";
import type { PgVectorConfig, PostgresStoreConfig } from "@mastra/pg";

import type { MastraAgentDefinition, MastraTools } from "./agents.js";
import type { GenieSpacesConfig } from "./genie.js";

/**
 * `RequestContext` key under which {@link MastraServer} stores the
 * resolved AppKit user. `model.ts` reads it to mint user-scoped
 * Databricks tokens.
 */
export const MASTRA_USER_KEY = "mastra__user";

/**
 * `RequestContext` keys for AppKit user metadata stamped by
 * {@link MastraServer}. Surfaced as trace metadata via
 * {@link TRACE_REQUEST_CONTEXT_KEYS} so traces are filterable by who
 * issued the request without leaking the full user object.
 */
export const MASTRA_USER_NAME_KEY = "mastra__userName";
export const MASTRA_USER_EMAIL_KEY = "mastra__userEmail";

/**
 * `RequestContext` key for the per-HTTP-request id stamped by
 * {@link MastraServer}. Reads `X-Request-Id` from the incoming
 * headers when present (so an upstream load balancer / API gateway
 * can keep its trace correlation), falls back to a freshly minted
 * UUID. Echoed back on the response and surfaced on every span via
 * {@link TRACE_REQUEST_CONTEXT_KEYS} so logs and traces share a
 * join key.
 */
export const MASTRA_REQUEST_ID_KEY = "mastra__requestId";

/**
 * Canonical list of `RequestContext` keys we want Mastra to extract
 * as metadata on every observability span (agent runs, model calls,
 * tool invocations, workflow steps).
 *
 * Mirrors {@link https://mastra.ai/docs/observability/tracing/overview#automatic-metadata-from-requestcontext}:
 * passed verbatim into `Observability.configs[*].requestContextKeys`,
 * so any key listed here is read from `RequestContext` at trace
 * start and attached as scalar span metadata. Keep the set to plain
 * scalars - never include {@link MASTRA_USER_KEY} (it carries the
 * full AppKit execution context with a `WorkspaceClient` reference).
 *
 * Order is purely cosmetic; Mastra de-dupes internally.
 */
export const TRACE_REQUEST_CONTEXT_KEYS: readonly string[] = [
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_THREAD_ID_KEY,
  MASTRA_REQUEST_ID_KEY,
  MASTRA_USER_NAME_KEY,
  MASTRA_USER_EMAIL_KEY,
  // Model override key is owned by `serving.ts`; spelled inline here
  // so this module stays leaf-level (no cycles with `serving.ts`).
  "mastra__model_override",
];

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
  /**
   * When `true` (default), every agent gets a built-in input
   * processor that strips `chartId` fields from prior assistant
   * tool-invocation results before they reach the model. This
   * prevents the model from reusing turn-scoped chartIds it sees
   * in memory recall (which would leave `[[chart:<id>]]` markers
   * pointing at writer events that no longer exist).
   *
   * Set to `false` to opt out - useful if a non-default agent
   * needs full visibility into prior chartIds (e.g. an audit
   * agent reasoning about chart lineage).
   */
  stripStaleCharts?: boolean;
  /**
   * Style guardrails appended to every agent's `instructions` to curb
   * common LLM-isms (em dashes, emojis, sycophantic openers, throwaway
   * closers, excessive hedging).
   *
   * - `undefined` (default): use the built-in
   *   `DEFAULT_STYLE_INSTRUCTIONS` from `agents.ts`.
   * - `string`: replace the default with the supplied block.
   * - `false`: disable entirely (agents see only their bespoke
   *   `instructions`).
   *
   * Appended (not prepended) so the agent's role and rules come first
   * and the style block leans on the model's recency bias.
   */
  styleInstructions?: string | false;
  /**
   * Genie spaces this plugin's agents can delegate to. One Mastra
   * tool is registered per alias (`genie` for the well-known
   * `default` alias, `genie_<alias>` otherwise). Each tool spins
   * up a per-question Genie sub-agent that runs Databricks
   * "agent mode" against the space, broadcasts wire events to the
   * UI, fetches statement rows for non-empty results, and returns
   * a `(string | data | chart)[]` summary the host UI renders
   * inline.
   *
   * Entries accept either a full {@link GenieSpaceConfig} object
   * or a bare `space_id` string when no extras are needed:
   *
   * ```ts
   * mastra({
   *   genieSpaces: {
   *     default: "01ef0d3c0e1b1f4a8d2c3e4f5a6b7c8d",
   *     forecasts: { spaceId: "01ef...", hint: "weekly demand forecasts" },
   *   },
   * });
   * ```
   *
   * Reach the spaces from an agent's `tools(plugins)` callback via
   * `plugins.genie?.toolkit()`; the resulting tools accept
   * `{ content, conversationId? }` and return a hydrated summary.
   *
   * **Fallback discovery** (highest precedence first): if this
   * field is omitted, the Genie agent also picks up spaces from
   * (1) the AppKit `genie({ spaces: { ... } })` plugin instance
   * when registered, and (2) the `DATABRICKS_GENIE_SPACE_ID`
   * env var (registered under the `default` alias). This keeps
   * existing AppKit deployments working without restating the
   * spaces config in two places.
   */
  genieSpaces?: GenieSpacesConfig;
  /**
   * TTL for the in-memory Genie space metadata cache, in
   * milliseconds. Defaults to 5 minutes. The Genie agent calls
   * `client.genie.getSpace(...)` on every cold-start to get the
   * title / description / warehouse id; cached responses skip the
   * round-trip and concurrent callers coalesce on a single
   * in-flight fetch. Drop to a smaller value when analysts are
   * actively editing space metadata and you want changes visible
   * within seconds; raise it to amortise the round-trip when
   * space metadata is effectively frozen.
   *
   * Backed by AppKit's `CacheManager`, so the cache participates
   * in telemetry spans (`cache.getOrExecute`) and benefits from
   * Lakebase persistence when the `lakebase` plugin is wired up.
   */
  genieSpaceCacheTtlMs?: number;
  /**
   * Maximum LLM steps each agent gets per turn. One step = one
   * round-trip to the underlying model (a tool call consumes a
   * step, the final-text reply consumes one too). Applies to
   * every agent registered through {@link MastraPluginConfig.agents}
   * - per-agent overrides aren't surfaced yet because the same
   * ceiling has been sufficient across every workload we've run.
   *
   * Defaults to {@link DEFAULT_AGENT_MAX_STEPS} (25), sized to fit
   * a decomposed Genie turn (grounding + several `ask_genie` calls
   * + `prepare_chart` per dataset + the final-text reply) with
   * headroom for the model to chain a couple of follow-ups before
   * answering. Mastra's own `agent.generate` default of 5 would
   * cut multi-step orchestration off after 2-3 tool calls, so
   * explicitly raising the ceiling here is what lets the
   * agent-mode loop play out.
   *
   * Lower when an unusually slow or expensive model makes long
   * turns unaffordable; raise for exploratory workloads that need
   * to drill deep into a dataset within a single turn.
   */
  agentMaxSteps?: number;
}
