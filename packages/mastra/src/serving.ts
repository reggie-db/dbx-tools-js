/**
 * Dynamic model resolution against Databricks Model Serving.
 *
 * Three concerns live here:
 *
 * 1. **Listing** - {@link listServingEndpoints} pulls the workspace's
 *    `/serving-endpoints` via the SDK and caches the result per host
 *    with a TTL. Concurrent callers share one in-flight promise (the
 *    same coalescing pattern as Python's `cachetools-async`).
 * 2. **Fuzzy matching** - {@link resolveModelId} runs the user's input
 *    through `fuse.js` extended search so loose tokens like
 *    `"claude sonnet"` snap to `databricks-claude-sonnet-4-6` even
 *    when typed without the full endpoint name.
 * 3. **Per-request override** - {@link extractModelOverride} pulls a
 *    model name from the `X-Mastra-Model` header, `?model=` query
 *    string, or `model` body field so the same agent can be exercised
 *    against different endpoints without redeploying.
 *
 * `model.ts` glues these together inside the per-step model resolver;
 * `plugin.ts` exposes the cached list at `GET /models`.
 */

import { CacheManager, type getExecutionContext } from "@databricks/appkit";
import { stringUtils } from "@dbx-tools/appkit-shared";
import Fuse from "fuse.js";

import type { MastraPluginConfig } from "./config.js";

/**
 * Structural type for the Databricks workspace client. Derived from
 * AppKit's `ExecutionContext` so this module doesn't take a direct
 * dependency on `@databricks/sdk-experimental`; the dep flows in
 * transitively through `@databricks/appkit`.
 */
type WorkspaceClientLike = ReturnType<typeof getExecutionContext>["client"];

/**
 * `RequestContext` key under which {@link MastraServer} stores the
 * per-request model override (header / query / body). `model.ts`
 * reads it before falling back to the agent / plugin default.
 */
export const MASTRA_MODEL_OVERRIDE_KEY = "mastra__model_override";

/** HTTP header inspected for a per-request model override. */
export const MODEL_OVERRIDE_HEADER = "x-mastra-model";

/** Query string parameter inspected for a per-request model override. */
export const MODEL_OVERRIDE_QUERY = "model";

/** Body fields (in priority order) inspected for a per-request model override. */
export const MODEL_OVERRIDE_BODY_FIELDS = ["model", "modelId"] as const;

/** Default TTL for the in-memory endpoint cache. Matches the Databricks SDK's session lifetime budget. */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** Default Fuse.js score threshold below which a fuzzy match is accepted. */
const DEFAULT_FUZZY_THRESHOLD = 0.4;

/** Minimal endpoint surface used by callers; matches the SDK's `ServingEndpoint`. */
export interface ServingEndpointSummary {
  /** Endpoint name as listed by the Model Serving REST API. */
  name: string;
  /** Task hint (e.g. `"llm/v1/chat"`). Useful for filtering. */
  task?: string;
  /** Ready / updating / failed state. */
  state?: string;
  /** Free-form description; mostly informational. */
  description?: string;
}

/** Cache key parts under which endpoint listings are stored. */
const CACHE_KEY_NAMESPACE = "mastra:serving-endpoints";

/**
 * Stable `userKey` arg for AppKit's `CacheManager.getOrExecute`.
 * Endpoint visibility is effectively workspace-scoped (we cache by
 * host in the key parts), so a single shared key lets every user of
 * the same workspace share one cached fetch and coalesce on the
 * in-flight promise. Permissions can differ in theory, but the
 * Foundation Model API catalogue is the same view for every caller.
 */
const SHARED_USER_KEY = "mastra-shared";

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
  const ttlSec = Math.max(1, Math.round((opts.ttlMs ?? DEFAULT_TTL_MS) / 1000));
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
  const out: ServingEndpointSummary[] = [];
  for await (const ep of client.servingEndpoints.list()) {
    if (!ep.name) continue;
    out.push({
      name: ep.name,
      ...(ep.task !== undefined ? { task: ep.task } : {}),
      ...(ep.state?.ready !== undefined ? { state: String(ep.state.ready) } : {}),
      ...(ep.description !== undefined ? { description: ep.description } : {}),
    });
  }
  return out;
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
 * input is returned verbatim. This is what {@link buildModel} does
 * when the workspace client can't be reached at resolve time.
 */
export function resolveModelId(
  input: string,
  endpoints: readonly ServingEndpointSummary[],
  opts: ResolveModelOptions = {},
): ResolvedModel {
  if (endpoints.length === 0) {
    return { modelId: input, matched: false };
  }
  for (const ep of endpoints) {
    if (ep.name === input) {
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
  if (!query) return { modelId: input, matched: false };
  const results = fuse.search(query);
  const best = results[0];
  if (best?.item.name && (best.score ?? 0) <= threshold) {
    return { modelId: best.item.name, matched: true, score: best.score };
  }
  return { modelId: input, matched: false };
}

/**
 * Minimal Express-ish request shape used by {@link extractModelOverride}.
 * Keeps this module independent of `express` so the helper can be
 * reused from non-Express adapters.
 */
export interface ModelOverrideRequest {
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, unknown> | undefined;
  body?: unknown;
}

/**
 * Pull a model override out of a single HTTP request, checking
 * sources in priority order:
 *
 *   1. `X-Mastra-Model` header
 *   2. `?model=` query string parameter
 *   3. Body field (`model` or `modelId`, in that order)
 *
 * Returns `null` when nothing is set, so callers can wrap with
 * `if (override) ...` without juggling empty strings. Body inspection
 * is lenient - any plain object with one of the configured keys
 * counts, mirroring how AI SDK chat clients pass arbitrary metadata
 * alongside `messages`.
 */
export function extractModelOverride(req: ModelOverrideRequest): string | null {
  const headers = req.headers;
  if (headers) {
    const headerVal = stringUtils.firstNonEmpty(
      headers[MODEL_OVERRIDE_HEADER] ?? headers[MODEL_OVERRIDE_HEADER.toLowerCase()],
    );
    if (headerVal) return headerVal;
  }
  if (req.query) {
    const queryVal = stringUtils.firstNonEmpty(req.query[MODEL_OVERRIDE_QUERY]);
    if (queryVal) return queryVal;
  }
  if (req.body && typeof req.body === "object") {
    const record = req.body as Record<string, unknown>;
    for (const field of MODEL_OVERRIDE_BODY_FIELDS) {
      const bodyVal = stringUtils.firstNonEmpty(record[field]);
      if (bodyVal) return bodyVal;
    }
  }
  return null;
}

/**
 * Read the fuzzy-resolution config knobs off the plugin config with
 * defaults applied. Kept here so `buildModel` and the `/models` route
 * agree on what "enabled" means.
 *
 * `fallbacks` is the priority-ordered list `pickModelId` walks when
 * nothing explicit is set; defaults live in `model.ts`
 * (`FALLBACK_MODEL_IDS`) and are passed in by callers to avoid a
 * circular import between `serving.ts` and `model.ts`.
 */
export function resolveServingConfig(
  config: MastraPluginConfig,
  defaultFallbacks: readonly string[] = [],
): {
  ttlMs: number;
  threshold: number;
  fuzzy: boolean;
  allowOverride: boolean;
  fallbacks: readonly string[];
} {
  return {
    ttlMs: config.modelCacheTtlMs ?? DEFAULT_TTL_MS,
    threshold: config.modelFuzzyThreshold ?? DEFAULT_FUZZY_THRESHOLD,
    fuzzy: config.modelFuzzyMatch !== false,
    allowOverride: config.modelOverride !== false,
    fallbacks: config.defaultModelFallbacks ?? defaultFallbacks,
  };
}
