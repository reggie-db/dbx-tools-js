/**
 * Workspace-aware model selection.
 *
 * Given a caller's intent (an explicit name, a capability
 * {@link ModelTier}, or nothing), the resolver returns the endpoint id
 * to use - always one the workspace actually has, degrading from "best
 * in tier" down to the static fallback floor. Two entry points:
 *
 *   - {@link selectModel} is the high-level, I/O-doing call: hand it a
 *     `WorkspaceClient` and intent and it lists `/serving-endpoints`
 *     (cached) and resolves in one step. This is what a non-Mastra
 *     consumer (e.g. a job that just needs a model name) reaches for.
 *   - {@link resolveModel} is the pure form over an endpoint list you
 *     already hold; `selectModel` is a thin wrapper over it.
 */

import {
  classifyEndpoints,
  ModelTier,
  type ServingEndpointSummary,
} from "@dbx-tools/model-shared";

import { FALLBACK_MODEL_IDS, modelsForTier } from "./fallback.js";
import {
  listServingEndpoints,
  resolveModelId,
  type WorkspaceClientLike,
} from "./serving.js";

/** Caller intent passed to {@link resolveModel}. */
export interface ResolveModelInput {
  /**
   * Explicit model id / loose name (per-request override, agent /
   * plugin default, or env var). When set it wins over `tier` and
   * `fallbacks`.
   */
  explicit?: string;
  /**
   * Fuzzy-match an `explicit` name against the live catalogue so loose
   * names like `"claude sonnet"` resolve. Default `true`. When `false`
   * the explicit input is returned verbatim (Databricks surfaces the
   * canonical 404 if it doesn't exist).
   */
  fuzzy?: boolean;
  /** Fuse.js threshold forwarded to {@link resolveModelId}. */
  threshold?: number;
  /**
   * Capability tier to resolve when no `explicit` id is given. The
   * live catalogue is classified by its Foundation Model API scores
   * and the top available model in the tier wins, falling back to the
   * tier's small static list.
   */
  tier?: ModelTier;
  /**
   * Operator-supplied fallback ids tried *first* in the no-explicit,
   * no-tier path (e.g. a regulated workspace pinned to an approved
   * subset), ahead of the auto-classified catalogue.
   */
  fallbacks?: readonly string[];
}

/** Outcome of {@link resolveModel}: the chosen id plus how it was reached. */
export interface ResolvedModelSelection {
  modelId: string;
  source: "explicit" | "fuzzy-match" | "tier" | "fallback";
}

/** Intent + catalogue knobs passed to {@link selectModel}. */
export interface SelectModelInput extends ResolveModelInput {
  /** TTL override for the cached `/serving-endpoints` listing, in ms. */
  ttlMs?: number;
}

/**
 * Resolve a model id for a workspace in one call: list its
 * `/serving-endpoints` (cached) and run {@link resolveModel} over the
 * result. This is the entry point for any consumer that holds a
 * `WorkspaceClient` and just wants a usable model name - a Lakeflow
 * job, a one-off script, or the Mastra plugin alike.
 *
 * Cheap exit: when an `explicit` name is given and `fuzzy` is off, the
 * catalogue is never fetched - the name is returned verbatim and
 * Databricks surfaces the canonical 404 if it doesn't exist. Catalogue
 * fetches otherwise fail loud: network / auth errors propagate so the
 * caller sees the real SDK message instead of a silent fallback.
 *
 * @param host - Workspace host used as the cache key. Pass the value
 *   resolved from `client.config.getHost()`.
 */
export async function selectModel(
  client: WorkspaceClientLike,
  host: string,
  input: SelectModelInput = {},
): Promise<ResolvedModelSelection> {
  if (input.explicit !== undefined && input.fuzzy === false) {
    return { modelId: input.explicit, source: "explicit" };
  }
  const endpoints = await listServingEndpoints(client, host, {
    ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
  });
  return resolveModel(endpoints, input);
}

/**
 * Resolve a model id from the live catalogue and caller intent.
 *
 * 1. **Explicit ask**: with `fuzzy` off, returned verbatim; otherwise
 *    snapped to the closest live endpoint via {@link resolveModelId}.
 * 2. **Tier intent**: classify the live catalogue and return the top
 *    available model in that tier, then the tier's static list, then
 *    the {@link FALLBACK_MODEL_IDS} floor.
 * 3. **Neither**: walk `fallbacks` first, then the live
 *    score-classified catalogue (Thinking -> Balanced -> Fast), then
 *    the static floor, and return the first id actually present.
 */
export function resolveModel(
  endpoints: readonly ServingEndpointSummary[],
  input: ResolveModelInput = {},
): ResolvedModelSelection {
  if (input.explicit !== undefined) {
    if (input.fuzzy === false) {
      return { modelId: input.explicit, source: "explicit" };
    }
    const { modelId } = resolveModelId(input.explicit, endpoints, {
      threshold: input.threshold,
    });
    return { modelId, source: "fuzzy-match" };
  }

  const classified = classifyEndpoints(endpoints);
  const chain =
    input.tier !== undefined
      ? tierChain(classified, input.tier)
      : defaultChain(classified, input.fallbacks);
  return {
    modelId: pickFirstAvailable(chain, endpoints),
    source: input.tier !== undefined ? "tier" : "fallback",
  };
}

/**
 * Candidate chain for an explicit {@link ModelTier} ask: live models
 * classified into that tier (best-first), then the tier's small static
 * list, then the full fallback floor as a last resort.
 */
function tierChain(
  classified: Record<ModelTier, ServingEndpointSummary[]>,
  tier: ModelTier,
): string[] {
  return dedupe([
    ...classified[tier].map((e) => e.name),
    ...modelsForTier(tier),
    ...FALLBACK_MODEL_IDS,
  ]);
}

/**
 * Candidate chain for the no-explicit default: any operator-supplied
 * `fallbacks` first, then the live score-classified catalogue in
 * descending tier order, then the static fallback floor.
 */
function defaultChain(
  classified: Record<ModelTier, ServingEndpointSummary[]>,
  fallbacks: readonly string[] | undefined,
): string[] {
  const live = [
    ...classified[ModelTier.Thinking],
    ...classified[ModelTier.Balanced],
    ...classified[ModelTier.Fast],
  ].map((e) => e.name);
  return dedupe([...(fallbacks ?? []), ...live, ...FALLBACK_MODEL_IDS]);
}

/** Drop duplicate ids while preserving first-seen order. */
function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Find the first id in `candidates` whose endpoint is present in
 * `endpoints`. Returns the top candidate when the workspace has none
 * of them so callers always get a string; an offline workspace then
 * receives a clean 404 from Databricks instead of a malformed config.
 */
function pickFirstAvailable(
  candidates: readonly string[],
  endpoints: readonly ServingEndpointSummary[],
): string {
  const present = new Set(endpoints.map((e) => e.name));
  for (const candidate of candidates) {
    if (present.has(candidate)) return candidate;
  }
  return candidates[0] ?? FALLBACK_MODEL_IDS[0]!;
}
