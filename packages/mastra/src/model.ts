/**
 * Databricks Model Serving resolver for Mastra agents.
 *
 * Each agent step calls {@link buildModel} with the active
 * `RequestContext`. The user stamped by `MastraServer` carries an
 * AppKit `WorkspaceClient`; we ask it for the workspace host and a
 * fresh bearer header, then point Mastra's OpenAI-compatible provider
 * at `/serving-endpoints` on that host.
 *
 * Model id resolution walks three sources before falling back to the
 * hard-coded default, **in this priority order**:
 *
 *   1. Per-request override stashed by the auth middleware under
 *      {@link MASTRA_MODEL_OVERRIDE_KEY} (header / query / body).
 *   2. The static `modelId` passed in by the agent / plugin (string
 *      sugar on `def.model` or `config.defaultModel`).
 *   3. `DATABRICKS_SERVING_ENDPOINT_NAME` env var.
 *   4. {@link FALLBACK_MODEL_ID}.
 *
 * Whatever wins is then fuzzy-matched against the live
 * `/serving-endpoints` list ({@link listServingEndpoints}) so loose
 * names like `"claude sonnet"` resolve to the real endpoint name.
 * Fuzzy matching is best-effort: when the workspace client throws
 * (network blip, expired token at cache-fill time) we fall back to
 * the input verbatim and let Databricks return the canonical error.
 */

import type { MastraModelConfig } from "@mastra/core/llm";
import type { RequestContext } from "@mastra/core/request-context";

import { MASTRA_USER_KEY, type MastraPluginConfig, type User } from "./config.js";
import {
  listServingEndpoints,
  MASTRA_MODEL_OVERRIDE_KEY,
  resolveModelId,
  resolveServingConfig,
  type ServingEndpointSummary,
} from "./serving.js";

/**
 * Capability tiers for Databricks Foundation Model API endpoints.
 *
 * - {@link ModelTier.Thinking}: deepest reasoning / "thinking" models
 *   (Claude Opus, GPT-5.5 Pro, Gemini Pro, Llama 4 Maverick, etc).
 *   Highest cost and latency; reserve for hard multi-step reasoning.
 * - {@link ModelTier.Balanced}: cost/latency sweet spot for general
 *   agent work (Claude Sonnet, GPT-5.x, Gemini Flash, Llama 3.3 70B).
 *   The right default for most agents.
 * - {@link ModelTier.Fast}: cheap and quick; classification, routing,
 *   tool-arg extraction, simple summarisation (Claude Haiku, GPT-5
 *   mini/nano, Gemini Flash Lite, GPT-OSS 20B, Llama 3.1 8B).
 *
 * String enum so the value is the slug we use in cache keys, logs,
 * and as the value users see in serialized configs.
 */
export enum ModelTier {
  Thinking = "thinking",
  Balanced = "balanced",
  Fast = "fast",
}

/**
 * Catalogue of Databricks-hosted Foundation Model API endpoints,
 * grouped by capability {@link ModelTier} and then by provider. Each
 * inner array is priority-ordered (most powerful first within the
 * same provider+tier).
 *
 * Provider buckets:
 *
 * - `claude`: Anthropic Claude family (closed; flagship reasoning).
 * - `gpt`: OpenAI GPT-5 family (closed; "ChatGPT" on Databricks FMAPI).
 * - `gemini`: Google Gemini family (closed; multimodal + web-search).
 * - `openSource`: open-weights models (widest regional / SKU availability).
 *
 * The list is curated by hand; refresh from the Databricks "supported
 * foundation models" doc when new endpoints land.
 */
export const MODEL_CATALOG = {
  [ModelTier.Thinking]: {
    claude: [
      "databricks-claude-opus-4-8",
      "databricks-claude-opus-4-7",
      "databricks-claude-opus-4-6",
      "databricks-claude-opus-4-5",
      "databricks-claude-opus-4-1",
    ],
    gpt: ["databricks-gpt-5-5-pro"],
    gemini: [
      "databricks-gemini-3-1-pro",
      "databricks-gemini-3-pro",
      "databricks-gemini-2-5-pro",
    ],
    openSource: [
      "databricks-llama-4-maverick",
      "databricks-gpt-oss-120b",
      "databricks-meta-llama-3-1-405b-instruct",
    ],
  },
  [ModelTier.Balanced]: {
    claude: [
      "databricks-claude-sonnet-4-6",
      "databricks-claude-sonnet-4-5",
      "databricks-claude-sonnet-4",
    ],
    gpt: [
      "databricks-gpt-5-5",
      "databricks-gpt-5-4",
      "databricks-gpt-5-2",
      "databricks-gpt-5-1",
      "databricks-gpt-5",
    ],
    gemini: [
      "databricks-gemini-3-5-flash",
      "databricks-gemini-3-flash",
      "databricks-gemini-2-5-flash",
    ],
    openSource: [
      "databricks-meta-llama-3-3-70b-instruct",
      "databricks-qwen3-next-80b-a3b-instruct",
      "databricks-qwen35-122b-a10b",
    ],
  },
  [ModelTier.Fast]: {
    claude: ["databricks-claude-haiku-4-5"],
    gpt: [
      "databricks-gpt-5-4-mini",
      "databricks-gpt-5-4-nano",
      "databricks-gpt-5-mini",
      "databricks-gpt-5-nano",
    ],
    gemini: ["databricks-gemini-3-1-flash-lite"],
    openSource: [
      "databricks-gpt-oss-20b",
      "databricks-gemma-3-12b",
      "databricks-meta-llama-3-1-8b-instruct",
    ],
  },
} as const satisfies Record<ModelTier, Record<string, readonly string[]>>;

/**
 * Round-robin zip: take one from each input list in order, skipping
 * lists that have already been exhausted. Used to interleave provider
 * buckets within a tier so the resolver alternates between vendors
 * instead of draining one before trying the next.
 *
 * Example: `interleave(["a1","a2","a3"], ["b1","b2"])` ->
 * `["a1","b1","a2","b2","a3"]`.
 */
function interleave<T>(...lists: readonly (readonly T[])[]): T[] {
  const out: T[] = [];
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i++) {
    for (const list of lists) {
      if (i < list.length) out.push(list[i]!);
    }
  }
  return out;
}

/**
 * Priority-ordered model ids for a single capability {@link ModelTier},
 * interleaved across providers so a workspace missing the top Claude
 * still lands on a flagship GPT / Gemini on the next probe.
 *
 * Provider order within the interleave: Claude, GPT, Gemini, then the
 * open-weights tail appended verbatim as the universal floor (widest
 * regional availability).
 *
 * @example
 * ```ts
 * mastra({
 *   defaultModelFallbacks: modelsForTier(ModelTier.Fast),
 * });
 * ```
 */
export function modelsForTier(tier: ModelTier): readonly string[] {
  const bucket = MODEL_CATALOG[tier];
  return [
    ...interleave(bucket.claude, bucket.gpt, bucket.gemini),
    ...bucket.openSource,
  ];
}

/**
 * Top model id at the given {@link ModelTier}. Sync; the agent-step
 * resolver fuzzy-matches it against the workspace catalogue at call
 * time, so this works even when the literal top pick isn't deployed.
 *
 * Use when wiring a tier-appropriate model into an agent definition:
 *
 * @example
 * ```ts
 * const classifier = createAgent({
 *   instructions: "Classify this email",
 *   model: modelForTier(ModelTier.Fast),  // cheap, quick
 * });
 *
 * const planner = createAgent({
 *   instructions: "Plan a multi-step migration",
 *   model: modelForTier(ModelTier.Thinking),  // deep reasoning
 * });
 * ```
 */
export function modelForTier(tier: ModelTier): string {
  return modelsForTier(tier)[0]!;
}

/**
 * Last-resort model ids used when neither `config.defaultModel`,
 * per-agent `model`, nor `DATABRICKS_SERVING_ENDPOINT_NAME` is set.
 *
 * Walked in order at resolve time: the first id whose endpoint is
 * actually present in the workspace's `/serving-endpoints` listing
 * wins. Workspaces vary - not every region / SKU has every model,
 * and the list of Foundation Model APIs evolves quickly - so the
 * resolver degrades all the way from "best thinking model" down to
 * "smallest commodity Llama" before giving up.
 *
 * Built by chaining the per-tier interleaves (Thinking -> Balanced
 * -> Fast); within each tier the providers are round-robin-zipped
 * (Claude, GPT, Gemini, then open-weights tail). Override the entire
 * list via `MastraPluginConfig.defaultModelFallbacks` (e.g. to pin a
 * regulated workspace to a specific approved subset, or to bias the
 * priority toward a particular tier).
 */
export const FALLBACK_MODEL_IDS: readonly string[] = [
  ...modelsForTier(ModelTier.Thinking),
  ...modelsForTier(ModelTier.Balanced),
  ...modelsForTier(ModelTier.Fast),
];

/** Optional overrides accepted by {@link buildModel}. */
export interface BuildModelOverrides {
  /**
   * Static model id from the agent / plugin config (string sugar on
   * `def.model` or `config.defaultModel`). Loses to the per-request
   * override but wins over env / fallback.
   */
  modelId?: string;
}

/**
 * Resolve a `MastraModelConfig` for the current agent step. Runs
 * while `agent.stream` is inside the `asUser(req)` scope so tokens
 * are user-scoped; outside an active user context the workspace
 * client falls back to the service principal.
 */
export async function buildModel(
  config: MastraPluginConfig,
  requestContext: RequestContext,
  overrides: BuildModelOverrides = {},
): Promise<MastraModelConfig> {
  const user = requestContext.get(MASTRA_USER_KEY) as User;
  const clientConfig = user.executionContext.client.config;
  const host = (await clientConfig.getHost()).toString();
  const headers = new Headers();
  await clientConfig.authenticate(headers);
  // The OpenAI Node SDK appends paths like `/chat/completions` to whatever
  // URL we hand it. Drop the trailing slash so the resulting URL stays
  // well-formed (`/serving-endpoints/chat/completions`).
  const url = new URL("/serving-endpoints", host).toString().replace(/\/$/, "");

  const modelId = await pickModelId(config, requestContext, overrides, user, host);

  return {
    providerId: config.providerId ?? "databricks",
    modelId,
    url,
    headers: Object.fromEntries(headers.entries()),
  };
}

/**
 * Walk the resolution ladder and pick a modelId.
 *
 * 1. **Explicit ask** (per-request override, agent `model` string,
 *    `config.defaultModel` string, or `DATABRICKS_SERVING_ENDPOINT_NAME`):
 *    when fuzzy matching is on, snap the input to the closest live
 *    endpoint so loose names like `"claude sonnet"` resolve. When it's
 *    off (or no endpoint matches within threshold), the input is used
 *    verbatim and Databricks surfaces the canonical 404.
 *
 * 2. **No explicit ask**: walk
 *    {@link MastraPluginConfig.defaultModelFallbacks} (or
 *    {@link FALLBACK_MODEL_IDS} when unset) and return the first id
 *    whose endpoint is actually present in the workspace listing. A
 *    workspace without Claude Opus still gets a sensible default by
 *    skipping ahead to whichever Sonnet / GPT-5 / Llama variant is
 *    wired up.
 *
 * Catalogue fetches fail loud: network / auth errors propagate to the
 * caller so they see the real SDK message instead of a silent fallback
 * to the top of the priority list.
 */
async function pickModelId(
  config: MastraPluginConfig,
  requestContext: RequestContext,
  overrides: BuildModelOverrides,
  user: User,
  host: string,
): Promise<string> {
  const serving = resolveServingConfig(config, FALLBACK_MODEL_IDS);
  const override = serving.allowOverride
    ? (requestContext.get(MASTRA_MODEL_OVERRIDE_KEY) as string | undefined)
    : undefined;
  const explicit =
    override ?? overrides.modelId ?? process.env.DATABRICKS_SERVING_ENDPOINT_NAME;

  // Cheap exit: when the caller named a specific model and fuzzy
  // matching is off, there's no reason to touch the catalogue at all.
  if (explicit !== undefined && !serving.fuzzy) return explicit;

  const endpoints = await listServingEndpoints(user.executionContext.client, host, {
    ttlMs: serving.ttlMs,
  });

  if (explicit !== undefined) {
    return resolveModelId(explicit, endpoints, { threshold: serving.threshold })
      .modelId;
  }
  return pickFirstAvailable(serving.fallbacks, endpoints);
}

/**
 * Find the first id in `fallbacks` whose endpoint is present in
 * `endpoints`. Returns the top fallback when the workspace has none
 * of them so callers always get a string; an offline workspace will
 * then receive a clean 404 from Databricks instead of a malformed
 * config.
 */
function pickFirstAvailable(
  fallbacks: readonly string[],
  endpoints: readonly ServingEndpointSummary[],
): string {
  const present = new Set(endpoints.map((e) => e.name));
  for (const candidate of fallbacks) {
    if (present.has(candidate)) return candidate;
  }
  return fallbacks[0] ?? FALLBACK_MODEL_IDS[0]!;
}
