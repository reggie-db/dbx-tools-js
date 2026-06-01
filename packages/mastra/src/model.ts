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
 * Provider-bucketed Foundation Model API endpoints in descending
 * power order within each bucket. The resolver doesn't walk these
 * directly - it walks the interleaved {@link FALLBACK_MODEL_IDS}
 * below - but they're exported so callers can compose their own
 * priority lists on top of `MastraPluginConfig.defaultModelFallbacks`.
 */
export const FALLBACK_MODELS_BY_PROVIDER = {
  /** Anthropic Claude family (closed; flagship reasoning). */
  claude: [
    "databricks-claude-opus-4-8",
    "databricks-claude-opus-4-7",
    "databricks-claude-opus-4-6",
    "databricks-claude-opus-4-5",
    "databricks-claude-opus-4-1",
    "databricks-claude-sonnet-4-6",
    "databricks-claude-sonnet-4-5",
    "databricks-claude-sonnet-4",
    "databricks-claude-haiku-4-5",
  ],
  /** OpenAI GPT-5 family (closed; "ChatGPT" on Databricks FMAPI). */
  gpt: [
    "databricks-gpt-5-5-pro",
    "databricks-gpt-5-5",
    "databricks-gpt-5-4",
    "databricks-gpt-5",
  ],
  /** Open weights (widest regional / SKU availability). */
  openSource: [
    "databricks-llama-4-maverick",
    "databricks-meta-llama-3-3-70b-instruct",
    "databricks-gpt-oss-120b",
    "databricks-gpt-oss-20b",
    "databricks-qwen35-122b-a10b",
    "databricks-meta-llama-3-1-8b-instruct",
  ],
} as const satisfies Record<string, readonly string[]>;

/**
 * Round-robin zip: take one from each input list in order, skipping
 * lists that have already been exhausted. Used to interleave the
 * closed-source provider buckets so the resolver alternates between
 * vendors instead of draining one before trying the next.
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
 * Last-resort model ids used when neither `config.defaultModel`,
 * per-agent `model`, nor `DATABRICKS_SERVING_ENDPOINT_NAME` is set.
 *
 * Walked in order at resolve time: the first id whose endpoint is
 * actually present in the workspace's `/serving-endpoints` listing
 * wins. Workspaces vary - not every region / SKU has every model,
 * and the list of Foundation Model APIs evolves quickly - so the
 * resolver degrades all the way down to a small commodity Llama
 * before giving up.
 *
 * Closed-source tiers are **interleaved** (Claude -> GPT -> Claude
 * -> GPT -> ...) so a workspace missing Claude Opus still gets a
 * top-shelf model on the *second* probe (GPT-5.5 Pro) instead of
 * having to descend the entire Claude ladder before another vendor
 * is tried. Open-weights models are appended verbatim at the end as
 * the universal floor.
 *
 * Concretely:
 *
 * 1. claude-opus-4-8, gpt-5-5-pro,
 *    claude-opus-4-7, gpt-5-5,
 *    claude-opus-4-6, gpt-5-4,
 *    claude-opus-4-5, gpt-5,
 *    claude-opus-4-1,
 *    claude-sonnet-4-6,
 *    claude-sonnet-4-5,
 *    claude-sonnet-4,
 *    claude-haiku-4-5,    (Claude continues solo after GPT-5 list runs out)
 * 2. llama-4-maverick, llama-3.3-70b, gpt-oss-120b, gpt-oss-20b,
 *    qwen35-122b, llama-3.1-8b   (open-weights tail in raw order)
 *
 * Override the entire list via `MastraPluginConfig.defaultModelFallbacks`
 * (e.g. to pin a regulated workspace to a specific approved subset).
 */
export const FALLBACK_MODEL_IDS: readonly string[] = [
  ...interleave(
    FALLBACK_MODELS_BY_PROVIDER.claude,
    FALLBACK_MODELS_BY_PROVIDER.gpt,
  ),
  ...FALLBACK_MODELS_BY_PROVIDER.openSource,
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
