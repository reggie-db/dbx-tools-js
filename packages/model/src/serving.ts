/**
 * Live Databricks Model Serving catalogue access.
 *
 * Lists the workspace's `/serving-endpoints` once per host and caches
 * the result with a TTL via AppKit's `CacheManager`, with concurrent
 * callers sharing one in-flight promise (the coalescing pattern of
 * Python's `cachetools-async`). Surfaces each endpoint as a stable
 * {@link ServingEndpointSummary} - including the Foundation Model API
 * `quality` / `speed` / `cost` profile when present - and snaps loose,
 * human-typed names to real endpoint ids through `fuse.js` extended
 * search so tokens like `"claude sonnet"` resolve to
 * `databricks-claude-sonnet-4-6`.
 */

import { CacheManager, type getExecutionContext } from "@databricks/appkit";
import type { ModelProfile, ServingEndpointSummary } from "@dbx-tools/model-shared";
import { logUtils, stringUtils } from "@dbx-tools/shared";
import Fuse from "fuse.js";

const log = logUtils.logger("model/serving");

/**
 * Structural type for the Databricks workspace client. Derived from
 * AppKit's `ExecutionContext` so this module doesn't take a direct
 * dependency on `@databricks/sdk-experimental`; the dep flows in
 * transitively through `@databricks/appkit`.
 */
export type WorkspaceClientLike = ReturnType<typeof getExecutionContext>["client"];

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
 * @param opts.ttlMs - Override the default TTL just for this call.
 *   Forwarded to `CacheManager` as seconds.
 */
export async function listServingEndpoints(
  client: WorkspaceClientLike,
  host: string,
  opts: { ttlMs?: number } = {},
): Promise<ServingEndpointSummary[]> {
  const ttlSec = Math.max(
    1,
    Math.round((opts.ttlMs ?? DEFAULT_MODEL_CACHE_TTL_MS) / 1000),
  );
  return CacheManager.getInstanceSync().getOrExecute(
    [CACHE_KEY_NAMESPACE, host],
    () => fetchEndpoints(client),
    SHARED_USER_KEY,
    { ttl: ttlSec },
  );
}

async function fetchEndpoints(
  client: WorkspaceClientLike,
): Promise<ServingEndpointSummary[]> {
  const startedAt = Date.now();
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
  log.debug("listed", { count: out.length, elapsedMs: Date.now() - startedAt });
  return out;
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

/** Options accepted by {@link resolveModelId}. */
export interface ResolveModelOptions {
  /** Fuse.js threshold (0 = exact, 1 = anything). Default `0.4`. */
  threshold?: number;
}

/**
 * Snap a user-supplied model name to the closest configured serving
 * endpoint:
 *
 * 1. Exact name match wins immediately (no fuzzy needed).
 * 2. Otherwise the input is tokenized (dashes / underscores / spaces
 *    become separators) and fed through Fuse.js extended search,
 *    which AND-s each token with fuzzy matching enabled. This is the
 *    "tokenized fuzzy match" the user reaches for when they type
 *    `"claude sonnet"` instead of the full endpoint name.
 * 3. If the best Fuse score is above `threshold`, return the input
 *    unchanged and let the upstream call surface the 404. This keeps
 *    deliberate model ids (e.g. brand new endpoints) from being
 *    silently rewritten to a similar-looking neighbour.
 *
 * Pass an empty endpoint list to short-circuit fuzzy matching - the
 * input is returned verbatim. This is what callers do when the
 * workspace client can't be reached at resolve time.
 */
export function resolveModelId(
  input: string,
  endpoints: readonly ServingEndpointSummary[],
  opts: ResolveModelOptions = {},
): ResolvedModel {
  if (endpoints.length === 0) {
    log.debug("resolve:no-endpoints", { input });
    return { modelId: input, matched: false };
  }
  for (const ep of endpoints) {
    if (ep.name === input) {
      log.debug("resolve:exact", { input });
      return { modelId: ep.name, matched: true, score: 0 };
    }
  }
  const threshold = opts.threshold ?? DEFAULT_FUZZY_THRESHOLD;
  const fuse = new Fuse(endpoints, {
    keys: ["name"],
    threshold,
    ignoreLocation: true,
    includeScore: true,
    useExtendedSearch: true,
    isCaseSensitive: false,
  });
  // Fuse 7.3 has no built-in tokenize hook; in extended search,
  // space-separated tokens are AND-ed with fuzzy matching enabled. We
  // lean on the shared tokenizer so the splitting rules stay
  // consistent with the rest of the toolkit.
  const query = Array.from(
    stringUtils.tokenizeWithOptions({ lowerCase: true, camelCase: false }, input),
  ).join(" ");
  if (!query) {
    log.debug("resolve:empty-tokens", { input });
    return { modelId: input, matched: false };
  }
  const results = fuse.search(query);
  const best = results[0];
  if (best?.item.name && (best.score ?? 0) <= threshold) {
    log.debug("resolve:fuzzy-match", {
      input,
      modelId: best.item.name,
      score: best.score,
    });
    return { modelId: best.item.name, matched: true, score: best.score };
  }
  log.debug("resolve:no-match", {
    input,
    bestScore: best?.score,
    threshold,
  });
  return { modelId: input, matched: false };
}
