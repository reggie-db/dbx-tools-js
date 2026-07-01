/**
 * Workspace-aware model selection.
 *
 * Given a caller's intent - a search string, a capability
 * {@link ModelClass} ceiling, both, or nothing - the toolkit returns
 * matching endpoints ranked by match quality then class, or collapses
 * to the single best id the workspace actually has, degrading from
 * "best in range" down to the static fallback floor. Selection is
 * chat-only: embedding endpoints surface only when `modelClass` is
 * explicitly {@link ModelClass.Embedding}.
 *
 * Two shapes of selection, each in a pure form (over an endpoint list
 * the caller already holds) and an I/O wrapper (that lists
 * `/serving-endpoints` first): ranking, which returns a match- then
 * class-ordered list, and single-selection, which collapses to one id
 * plus how it was reached and layers the operator-pinned fallback /
 * static-floor safety net on top. A chat `modelClass` acts as a
 * ceiling: that band and the less-capable chat bands below it are
 * eligible (see {@link classesAtOrBelow}), so a `chat-balanced` ask can
 * fall to `chat-fast` but never escalate to `chat-thinking`.
 */

import {
  classifyEndpoints,
  ModelClass,
  type ModelQuery,
  type RankedModel,
  type ServingEndpointSummary,
} from "@dbx-tools/model-shared";

import { CHAT_CLASS_ORDER, classesAtOrBelow, MODEL_CLASS_ORDER } from "./classes.js";
import { FALLBACK_MODEL_IDS, modelsForClass } from "./fallback.js";
import {
  listServingEndpoints,
  searchServingEndpoints,
  type WorkspaceClientLike,
} from "./serving.js";

/** Caller intent passed to {@link resolveModel}. */
export interface ResolveModelInput {
  /**
   * Explicit model id / loose name (per-request override, agent /
   * plugin default, or env var). When set it wins over `modelClass`
   * and `fallbacks`.
   */
  explicit?: string;
  /**
   * Fuzzy-match an `explicit` name against the live catalogue so loose
   * names like `"claude sonnet"` resolve. Default `true`. When `false`
   * the explicit input is returned verbatim (Databricks surfaces the
   * canonical 404 if it doesn't exist).
   */
  fuzzy?: boolean;
  /** Fuse.js threshold forwarded to the fuzzy `search` match ({@link searchServingEndpoints}). */
  threshold?: number;
  /**
   * Chat capability class to resolve when no `explicit` id is given.
   * The live catalogue is classified by its Foundation Model API scores
   * and the top available model in the class (and the chat bands below
   * it) wins, falling back to the class's small static list.
   */
  modelClass?: ModelClass;
  /**
   * Operator-supplied fallback ids tried *first* in the no-explicit,
   * no-class path (e.g. a regulated workspace pinned to an approved
   * subset), ahead of the auto-classified catalogue.
   */
  fallbacks?: readonly string[];
}

/** Outcome of {@link resolveModel}: the chosen id plus how it was reached. */
export interface ResolvedModelSelection {
  modelId: string;
  source: "explicit" | "fuzzy-match" | "class" | "fallback";
}

/** Intent + catalogue knobs passed to {@link selectModel}. */
export interface SelectModelInput extends ResolveModelInput {
  /** TTL override for the cached `/serving-endpoints` listing, in ms. */
  ttlMs?: number;
}

/** TTL override merged into a {@link ModelQuery} for {@link searchModels}. */
export interface SearchModelsInput extends ModelQuery {
  /** TTL override for the cached `/serving-endpoints` listing, in ms. */
  ttlMs?: number;
}

/**
 * Round a Fuse score to the display precision so version siblings that
 * match a token identically (e.g. `opus-4-7` vs `opus-4-8` for the
 * query `"opus"`) tie on match and let the class / within-class rank
 * decide - which is what surfaces the newer, higher-quality sibling.
 */
function matchBucket(score: number | undefined): number {
  return Math.round((score ?? 0) * 1000);
}

/**
 * Rank the live catalogue against a {@link ModelQuery}, best-first.
 *
 * Candidates are the classified endpoints in the eligible classes:
 * {@link classesAtOrBelow} the requested `modelClass`, or - when none is
 * given - the chat bands only ({@link CHAT_CLASS_ORDER}), so a general
 * ask never surfaces an embedding endpoint. Each class bucket is
 * already best-first from {@link classifyEndpoints}. Ranking is **match
 * then class**:
 *
 * 1. With a `search`, only endpoints matching it survive, ordered by
 *    match distance (bucketed via {@link matchBucket} so near-identical
 *    scores tie), then by class (more capable first), then by the stable
 *    within-class rank.
 * 2. Without a `search`, the class-then-rank candidate order stands.
 *
 * A `limit` truncates the result. Returns `[]` when nothing is
 * eligible or matches - callers layer their own fallback.
 */
export function rankModels(
  endpoints: readonly ServingEndpointSummary[],
  query: ModelQuery = {},
): RankedModel[] {
  const classified = classifyEndpoints(endpoints);
  const eligible =
    query.modelClass !== undefined
      ? classesAtOrBelow(query.modelClass)
      : CHAT_CLASS_ORDER;

  // Flatten eligible classes in capability order, carrying each
  // endpoint's class; bucket order is already best-first.
  const candidates: RankedModel[] = [];
  for (const modelClass of eligible) {
    for (const endpoint of classified[modelClass])
      candidates.push({ endpoint, modelClass });
  }

  const search = query.search?.trim();
  let ranked: RankedModel[];
  if (search) {
    const scores = new Map<string, number>();
    for (const match of searchServingEndpoints(
      search,
      candidates.map((c) => c.endpoint),
      query.threshold !== undefined ? { threshold: query.threshold } : {},
    )) {
      scores.set(match.endpoint.name, match.score);
    }
    // `Array.prototype.sort` is stable, so endpoints equal on match and
    // class keep their best-first within-class order.
    ranked = candidates
      .filter((c) => scores.has(c.endpoint.name))
      .map((c) => ({ ...c, score: scores.get(c.endpoint.name) }))
      .sort((a, b) => {
        const byMatch = matchBucket(a.score) - matchBucket(b.score);
        if (byMatch !== 0) return byMatch;
        return (
          MODEL_CLASS_ORDER.indexOf(a.modelClass) -
          MODEL_CLASS_ORDER.indexOf(b.modelClass)
        );
      });
  } else {
    ranked = candidates;
  }

  return query.limit !== undefined ? ranked.slice(0, Math.max(0, query.limit)) : ranked;
}

/**
 * Rank a workspace's catalogue in one call: list its
 * `/serving-endpoints` (cached) and run {@link rankModels} over the
 * result. The list counterpart to {@link selectModel}, for a consumer
 * that wants the full ranked set (a model picker, a CLI) rather than a
 * single id. Catalogue fetches fail loud: network / auth errors
 * propagate so the caller sees the real SDK message.
 *
 * @param host - Workspace host used as the cache key. Pass the value
 *   resolved from `client.config.getHost()`.
 */
export async function searchModels(
  client: WorkspaceClientLike,
  host: string,
  input: SearchModelsInput = {},
): Promise<RankedModel[]> {
  const endpoints = await listServingEndpoints(
    client,
    host,
    input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {},
  );
  return rankModels(endpoints, input);
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
 * Resolve a single model id from the live catalogue and caller intent,
 * delegating the live selection to {@link rankModels} with `limit: 1`.
 *
 * 1. **Explicit ask**: with `fuzzy` off, returned verbatim; otherwise
 *    fuzzy-ranked within the (optional) class ceiling and the best taken,
 *    falling back to the input verbatim when nothing matches.
 * 2. **No explicit ask**: an operator-pinned `fallback` that exists in
 *    the live catalogue wins first; then the ranked live catalogue
 *    (class ceiling applied); then the static {@link FALLBACK_MODEL_IDS}
 *    floor when the catalogue yields nothing in range.
 */
export function resolveModel(
  endpoints: readonly ServingEndpointSummary[],
  input: ResolveModelInput = {},
): ResolvedModelSelection {
  if (input.explicit !== undefined) {
    if (input.fuzzy === false) {
      return { modelId: input.explicit, source: "explicit" };
    }
    const [top] = rankModels(endpoints, buildQuery(input, input.explicit));
    return { modelId: top?.endpoint.name ?? input.explicit, source: "fuzzy-match" };
  }

  // Operator-pinned fallbacks win when present and live (e.g. a
  // regulated workspace restricted to an approved subset).
  if (input.modelClass === undefined && input.fallbacks && input.fallbacks.length > 0) {
    const present = new Set(endpoints.map((e) => e.name));
    const pinned = input.fallbacks.find((id) => present.has(id));
    if (pinned) return { modelId: pinned, source: "fallback" };
  }

  const source = input.modelClass !== undefined ? "class" : "fallback";
  const [top] = rankModels(endpoints, buildQuery(input, undefined));
  if (top) return { modelId: top.endpoint.name, source };

  // Live catalogue yielded nothing in range: walk the static floor.
  const floor =
    input.modelClass !== undefined
      ? dedupe([...modelsForClass(input.modelClass), ...FALLBACK_MODEL_IDS])
      : dedupe([...(input.fallbacks ?? []), ...FALLBACK_MODEL_IDS]);
  return { modelId: pickFirstAvailable(floor, endpoints), source };
}

/** Build a {@link ModelQuery} from {@link ResolveModelInput} for the `limit: 1` delegation. */
function buildQuery(input: ResolveModelInput, search: string | undefined): ModelQuery {
  return {
    ...(search !== undefined ? { search } : {}),
    ...(input.modelClass !== undefined ? { modelClass: input.modelClass } : {}),
    ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
    limit: 1,
  };
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
