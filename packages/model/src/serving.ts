/**
 * Live Databricks Model Serving catalogue access.
 *
 * Lists the workspace's `/serving-endpoints` once per host and caches
 * the result with a TTL via AppKit's `CacheManager`, with concurrent
 * callers sharing one in-flight promise (the coalescing pattern of
 * Python's `cachetools-async`). Surfaces each endpoint as a stable
 * {@link ServingEndpointSummary} - including the Foundation Model API
 * `quality` / `speed` / `cost` profile when present, the classified
 * {@link ModelClass}, and (for embedding endpoints) the measured vector
 * `dimension` - and snaps loose, human-typed names to real endpoint ids
 * through `fuse.js` extended search so tokens like `"claude sonnet"`
 * resolve to `databricks-claude-sonnet-4-6`.
 *
 * The class stamp and embedding dimension are computed once per cache
 * load: every embedding endpoint is "pinged" in parallel and the
 * resulting vector length recorded, so the cost is paid on a cache miss,
 * not per read. The ping is best-effort - a failure logs at debug and
 * leaves `dimension` unset rather than failing the whole listing.
 */

import { CacheManager } from "@databricks/appkit";
import {
  classifyEndpoints,
  ModelClass,
  type ModelProfile,
  type ServingEndpointSummary,
} from "@dbx-tools/model-shared";
import type { appkitUtils } from "@dbx-tools/shared";
import { commonUtils, logUtils, stringUtils } from "@dbx-tools/shared";
import Fuse from "fuse.js";

import { MODEL_CLASS_ORDER } from "./classes.js";

const log = logUtils.logger("model/serving");

/**
 * Structural type for the Databricks workspace client, re-exported from
 * `@dbx-tools/shared` so the rest of this package can keep importing it
 * from here. See `appkitUtils.WorkspaceClientLike` for the canonical
 * definition.
 */
export type WorkspaceClientLike = appkitUtils.WorkspaceClientLike;

/** Default TTL for the in-memory endpoint cache. Matches the Databricks SDK's session lifetime budget. */
export const DEFAULT_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

/** Default Fuse.js score threshold below which a fuzzy match is accepted. */
export const DEFAULT_FUZZY_THRESHOLD = 0.4;

/** Cache key parts under which endpoint listings are stored. */
const CACHE_KEY_NAMESPACE = "serving-endpoints";

/**
 * Stable `userKey` arg for AppKit's `CacheManager.getOrExecute`.
 * Endpoint visibility is effectively workspace-scoped (we cache by
 * host in the key parts), so a single shared key lets every user of
 * the same workspace share one cached fetch and coalesce on the
 * in-flight promise. Permissions can differ in theory, but the
 * Foundation Model API catalogue is the same view for every caller.
 */
const SHARED_USER_KEY = "model-shared";

/** Options for {@link listServingEndpoints}. */
export interface ListServingEndpointsOptions {
  /**
   * Override the default cache TTL for this call, in milliseconds.
   * Forwarded to `CacheManager` as seconds.
   */
  ttlMs?: number;
}

/**
 * List Model Serving endpoints for the workspace owning `client`,
 * routed through AppKit's `CacheManager`. The manager gives us
 * everything `cachetools.TTLCache` provides plus what
 * `cachetools-async` adds on top: per-entry TTL, in-flight request
 * coalescing (concurrent callers share one fetch via the manager's
 * internal `inFlightRequests` map), bounded size, telemetry spans
 * (`cache.getOrExecute`), and optional Lakebase persistence so the
 * catalogue survives restarts when the lakebase plugin is wired up.
 *
 * Returns plain {@link ServingEndpointSummary} objects (a stable
 * subset of the SDK type) so cache hits never expose stale SDK
 * internals. Errors from `CacheManager` or the SDK fetch propagate
 * to the caller - we don't swallow them so users see the real
 * auth / network issue.
 *
 * @param host - Workspace host used as the cache key. Pass the value
 *   resolved from `client.config.getHost()` so multi-host apps share
 *   one entry per workspace.
 * @param options.ttlMs - Override the default TTL just for this call.
 *   Forwarded to `CacheManager` as seconds.
 */
export async function listServingEndpoints(
  client: WorkspaceClientLike,
  host: string,
  options: ListServingEndpointsOptions = {},
): Promise<ServingEndpointSummary[]> {
  const ttlSec = Math.max(
    1,
    Math.round((options.ttlMs ?? DEFAULT_MODEL_CACHE_TTL_MS) / 1000),
  );
  return CacheManager.getInstanceSync().getOrExecute(
    [CACHE_KEY_NAMESPACE, host],
    () => fetchEndpoints(client),
    SHARED_USER_KEY,
    { ttl: ttlSec },
  );
}

/**
 * List the workspace's serving endpoints as minimal
 * {@link ServingEndpointSummary} objects straight from the SDK: no
 * caching, and none of the cache-load enrichment ({@link listServingEndpoints}
 * adds the {@link ModelClass} stamp and the embedding-dimension probe).
 * Use this for a one-shot, dependency-light listing - e.g. a CLI that
 * only needs names/tasks for fuzzy resolution and doesn't want AppKit's
 * `CacheManager` or the per-embedding ping cost. Prefer
 * {@link listServingEndpoints} for the cached, enriched view.
 */
export async function listServingEndpointsUncached(
  client: WorkspaceClientLike,
): Promise<ServingEndpointSummary[]> {
  const out: ServingEndpointSummary[] = [];
  for await (const ep of client.servingEndpoints.list()) {
    if (!ep.name) continue;
    const profile = extractProfile(ep);
    out.push({
      name: ep.name,
      ...(ep.task !== undefined ? { task: ep.task } : {}),
      ...(ep.state?.ready !== undefined ? { state: String(ep.state.ready) } : {}),
      ...(ep.description !== undefined ? { description: ep.description } : {}),
      ...(profile ? { profile } : {}),
    });
  }
  return out;
}

async function fetchEndpoints(
  client: WorkspaceClientLike,
): Promise<ServingEndpointSummary[]> {
  const startedAt = Date.now();
  const out = await listServingEndpointsUncached(client);
  stampModelClasses(out);
  await measureEmbeddingDimensions(client, out);
  log.debug("listed", { count: out.length, elapsedMs: Date.now() - startedAt });
  return out;
}

/**
 * Stamp each summary's {@link ServingEndpointSummary.class} from the
 * relative classification of the whole set. Mutates `summaries` in
 * place. Endpoints the classifier doesn't recognize (custom, unscored,
 * non-LLM) are left without a class.
 */
function stampModelClasses(summaries: ServingEndpointSummary[]): void {
  const buckets = classifyEndpoints(summaries);
  const classOf = new Map<string, ModelClass>();
  for (const cls of MODEL_CLASS_ORDER) {
    for (const ep of buckets[cls]) classOf.set(ep.name, cls);
  }
  for (const summary of summaries) {
    const cls = classOf.get(summary.name);
    if (cls !== undefined) summary.class = cls;
  }
}

/**
 * Measure the embedding vector dimension of every
 * {@link ModelClass.Embedding} endpoint by pinging it once, all in
 * parallel. Mutates the matching summaries in place with the resulting
 * `dimension`. Runs only on a cache miss (it's called from
 * {@link fetchEndpoints}), so the probe cost is amortized across the
 * cached TTL window. Per-endpoint failures are swallowed (logged at
 * warn) so one unreachable embedding model never fails the listing.
 */
async function measureEmbeddingDimensions(
  client: WorkspaceClientLike,
  summaries: ServingEndpointSummary[],
): Promise<void> {
  await Promise.all(
    summaries
      .filter((s) => s.class === ModelClass.Embedding)
      .map(async (summary) => {
        const dimension = await pingEmbeddingDimension(client, summary.name);
        if (dimension !== undefined) summary.dimension = dimension;
      }),
  );
}

/**
 * Best-effort embedding dimension probe: query `name` with a tiny
 * `"ping"` input and return the length of the returned vector. Returns
 * `undefined` (and logs at warn) when the endpoint can't be queried or
 * returns no vector - the dimension is informational, never required.
 */
async function pingEmbeddingDimension(
  client: WorkspaceClientLike,
  name: string,
): Promise<number | undefined> {
  try {
    const response = await client.servingEndpoints.query({ name, input: "ping" });
    const dimension = response.data?.[0]?.embedding?.length;
    if (typeof dimension === "number" && dimension > 0) return dimension;
    log.warn("embedding ping returned no vector", { name });
    return undefined;
  } catch (err) {
    log.warn("embedding ping failed", { name, error: commonUtils.errorMessage(err) });
    return undefined;
  }
}

/**
 * Pull the Foundation Model API `quality` / `speed` / `cost` scores
 * off a serving-endpoint listing entry. Databricks returns these
 * under `config.served_entities[].foundation_model.ai_gateway_model_profile`
 * (snake_case at the wire level, preserved verbatim by the SDK), but
 * the field is newer than the typed `FoundationModel` interface, so we
 * read it through a structural cast. Returns `undefined` when no
 * served entity carries a profile (custom models, embeddings, and
 * brand-new endpoints that Databricks has not scored yet).
 */
function extractProfile(ep: unknown): ModelProfile | undefined {
  const entities = (
    ep as {
      config?: {
        served_entities?: Array<{
          foundation_model?: {
            ai_gateway_model_profile?: {
              quality?: number;
              speed?: number;
              cost?: number;
            };
          };
        }>;
      };
    }
  ).config?.served_entities;
  if (!entities) return undefined;
  for (const entity of entities) {
    const raw = entity.foundation_model?.ai_gateway_model_profile;
    if (!raw) continue;
    const profile: ModelProfile = {};
    if (Number.isFinite(raw.quality)) profile.quality = raw.quality;
    if (Number.isFinite(raw.speed)) profile.speed = raw.speed;
    if (Number.isFinite(raw.cost)) profile.cost = raw.cost;
    if (Object.keys(profile).length > 0) return profile;
  }
  return undefined;
}

/**
 * Force-evict cached endpoint listings via AppKit's `CacheManager`.
 * With a `host` deletes that one workspace's entry; without one
 * clears every cache entry on the manager (since `CacheManager`
 * doesn't expose a namespace-scoped clear, this is the brute-force
 * path - fine for tests, avoid in steady-state code).
 */
export async function clearServingEndpointsCache(host?: string): Promise<void> {
  const cache = CacheManager.getInstanceSync();
  if (host) {
    const key = cache.generateKey([CACHE_KEY_NAMESPACE, host], SHARED_USER_KEY);
    await cache.delete(key);
  } else {
    await cache.clear();
  }
}

/**
 * Result of fuzzy-resolving a user-supplied model name against the
 * live endpoint list. `score` is Fuse.js's distance (`0` is exact,
 * `1` is no match); `matched` is `false` when the score exceeds the
 * configured threshold so callers can fall back to the original
 * input (Databricks will then return a clean 404).
 */
export interface ResolvedModel {
  modelId: string;
  matched: boolean;
  score?: number;
}

/** Options accepted by {@link resolveModelId} / {@link searchServingEndpoints}. */
export interface ResolveModelOptions {
  /** Fuse.js threshold (0 = exact, 1 = anything). Default `0.4`. */
  threshold?: number;
}

/** A serving endpoint paired with its fuzzy-match distance for a query. */
export interface ScoredEndpoint {
  endpoint: ServingEndpointSummary;
  /** Fuse.js distance: `0` is exact, `1` is no match. */
  score: number;
}

/**
 * Fuzzy-rank endpoints by how closely their `name` matches `input`,
 * best (lowest score) first, keeping only those within `threshold`:
 *
 * 1. An exact name match short-circuits to a single `score: 0` result.
 * 2. Otherwise the input is tokenized (dashes / underscores / spaces
 *    become separators) and fed through Fuse.js extended search, which
 *    AND-s each token with fuzzy matching enabled - the "tokenized
 *    fuzzy match" a caller reaches for when they type `"claude sonnet"`
 *    instead of the full endpoint name.
 *
 * Returns `[]` for an empty endpoint list or when `input` tokenizes to
 * nothing, so callers fall back to the raw input and let Databricks
 * surface a clean 404. This multi-result core is shared by
 * {@link resolveModelId} (single best) and the ranked `rankModels`
 * selector.
 */
export function searchServingEndpoints(
  input: string,
  endpoints: readonly ServingEndpointSummary[],
  options: ResolveModelOptions = {},
): ScoredEndpoint[] {
  if (endpoints.length === 0) return [];
  for (const ep of endpoints) {
    if (ep.name === input) return [{ endpoint: ep, score: 0 }];
  }
  const threshold = options.threshold ?? DEFAULT_FUZZY_THRESHOLD;
  // Fuse 7.3 has no built-in tokenize hook; in extended search,
  // space-separated tokens are AND-ed with fuzzy matching enabled. We
  // lean on the shared tokenizer so the splitting rules stay
  // consistent with the rest of the toolkit.
  const query = Array.from(
    stringUtils.tokenizeWithOptions({ lowerCase: true, camelCase: false }, input),
  ).join(" ");
  if (!query) return [];
  const fuse = new Fuse(endpoints, {
    keys: ["name"],
    threshold,
    ignoreLocation: true,
    includeScore: true,
    useExtendedSearch: true,
    isCaseSensitive: false,
  });
  return fuse
    .search(query)
    .filter((r) => (r.score ?? 0) <= threshold)
    .map((r) => ({ endpoint: r.item, score: r.score ?? 0 }));
}

/**
 * Snap a user-supplied model name to the single closest configured
 * serving endpoint via {@link searchServingEndpoints}. Returns the
 * input unchanged with `matched: false` when nothing scores within the
 * threshold (or the catalogue is empty), so a deliberate model id is
 * never silently rewritten to a similar-looking neighbour and the
 * upstream call surfaces the canonical 404.
 */
export function resolveModelId(
  input: string,
  endpoints: readonly ServingEndpointSummary[],
  options: ResolveModelOptions = {},
): ResolvedModel {
  const [best] = searchServingEndpoints(input, endpoints, options);
  if (best) {
    return { modelId: best.endpoint.name, matched: true, score: best.score };
  }
  return { modelId: input, matched: false };
}
