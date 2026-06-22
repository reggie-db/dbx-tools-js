/**
 * Mastra-specific glue over the generic `@dbx-tools/model` toolkit.
 *
 * The live `/serving-endpoints` catalogue access, fuzzy name
 * resolution, and tier/fallback selection all live in
 * `@dbx-tools/model`; this module only adds what is specific to the
 * Mastra plugin: pulling a per-request model override off an HTTP
 * request (header / query / body) and projecting the plugin config
 * onto the knobs `buildModel` and the `/models` route share.
 */

import { DEFAULT_FUZZY_THRESHOLD, DEFAULT_MODEL_CACHE_TTL_MS } from "@dbx-tools/model";
import { stringUtils } from "@dbx-tools/shared";

import type { MastraPluginConfig } from "./config.js";

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
 * `@dbx-tools/model` defaults applied. Kept here so `buildModel` and
 * the `/models` route agree on what "enabled" means.
 *
 * `fallbacks` is the priority-ordered list `resolveModel` walks first
 * when nothing explicit is set; defaults to an empty list so the
 * generic resolver falls through to the live catalogue and its own
 * `FALLBACK_MODEL_IDS` floor.
 */
export function resolveServingConfig(config: MastraPluginConfig): {
  ttlMs: number;
  threshold: number;
  fuzzy: boolean;
  allowOverride: boolean;
  fallbacks: readonly string[];
} {
  return {
    ttlMs: config.modelCacheTtlMs ?? DEFAULT_MODEL_CACHE_TTL_MS,
    threshold: config.modelFuzzyThreshold ?? DEFAULT_FUZZY_THRESHOLD,
    fuzzy: config.modelFuzzyMatch !== false,
    allowOverride: config.modelOverride !== false,
    fallbacks: config.defaultModelFallbacks ?? [],
  };
}
