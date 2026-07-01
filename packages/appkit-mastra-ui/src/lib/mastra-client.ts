import { usePluginClientConfig } from "@databricks/appkit-ui/react";
import {
  ChartSchema,
  MASTRA_ROUTES,
  MODEL_OVERRIDE_HEADER,
  MastraClearHistoryResponseSchema,
  MastraDeleteThreadResponseSchema,
  MastraFeedbackResponseSchema,
  MastraHistoryResponseSchema,
  MastraSuggestionsResponseSchema,
  MastraThreadsResponseSchema,
  MastraUpdateThreadResponseSchema,
  ServingEndpointsResponseSchema,
  StatementDataSchema,
  THREAD_ID_HEADER,
  type Chart,
  type MastraClearHistoryResponse,
  type MastraClientConfig,
  type MastraDeleteThreadResponse,
  type MastraFeedbackRequest,
  type MastraFeedbackResponse,
  type MastraHistoryResponse,
  type MastraThread,
  type MastraThreadsResponse,
  type MastraUpdateThreadResponse,
  type ServingEndpointSummary,
  type StatementData,
} from "@dbx-tools/appkit-mastra-shared";
import { commonUtils } from "@dbx-tools/shared";
import { MastraClient } from "@mastra/client-js";
import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * `@mastra/client-js` `MastraClient` extended with the Mastra plugin's
 * custom routes. One client drives everything the chat UI needs:
 *
 *   - Conversation streaming via the inherited
 *     `getAgent(id).stream()` (the standard Mastra agent route).
 *   - Thread history (`history` / `clearHistory`), the conversation
 *     list (`threads` / `removeThread` / `renameThread`), the model
 *     catalogue (`models`),
 *     Genie starter prompts (`suggestions`), MLflow feedback logging
 *     (`feedback`), and inline embed resolution (`chart` / `statement`)
 *     over the plugin's own routes - all derived from `basePath` +
 *     {@link MASTRA_ROUTES}.
 *
 * Built from the plugin's published `clientConfig()` payload
 * ({@link MastraClientConfig}). `credentials: "include"` is set once at
 * construction so the session cookie (which pins the server-side
 * thread id) travels with every request, streaming included.
 */
export class MastraPluginClient extends MastraClient {
  /** Plugin mount prefix (`/api/<plugin-name>`); all custom routes derive from it. */
  readonly basePath: string;
  /** Agent the bare (un-suffixed) routes resolve to. */
  readonly defaultAgent: string;
  /** Registered agent ids, surfaced for pickers. */
  readonly agents: readonly string[];
  /**
   * Whether the server can log feedback to MLflow. When `false`, the
   * chat UI hides thumbs / comment controls and {@link feedback} would
   * be rejected server-side, so callers gate on this before offering
   * feedback affordances.
   */
  readonly feedbackEnabled: boolean;

  constructor(config: MastraClientConfig) {
    super({
      baseUrl:
        typeof window !== "undefined" ? window.location.origin : "http://localhost",
      apiPrefix: config.basePath,
      credentials: "include",
      headers: {},
    });
    this.basePath = config.basePath;
    this.defaultAgent = config.defaultAgent;
    this.agents = config.agents;
    this.feedbackEnabled = config.feedbackEnabled;
  }

  /**
   * Set (or clear) the per-request model override sent on every
   * streaming call as `X-Mastra-Model`. The Mastra plugin's middleware
   * reads it and overrides the resolved model for that request without
   * an agent redeploy. `model` is either a concrete endpoint name
   * (fuzzy-matched server-side) or a model class slug
   * (`ModelClass.ChatFast` / `"chat-thinking"`); pass `undefined` to
   * fall back to the agent's configured default.
   *
   * Mutates the shared `options.headers` in place (rather than
   * rebuilding the client) so the client identity stays stable across
   * model changes - hooks can depend on it without refiring history
   * loads when only the model changes.
   */
  setModelOverride(model?: string): void {
    const headers = (this.options.headers ??= {});
    if (model) headers[MODEL_OVERRIDE_HEADER] = model;
    else delete headers[MODEL_OVERRIDE_HEADER];
  }

  /**
   * Select (or clear) the conversation thread every subsequent request
   * targets, sent as the thread-selection header (`THREAD_ID_HEADER`).
   * The plugin's middleware pins `RequestContext`'s thread id to it, so
   * the agent stream persists into - and `history()` reads from - the
   * chosen thread instead of the default per-session one. Pass
   * `undefined` to fall back to the session thread.
   *
   * Mutates the shared `options.headers` in place (like
   * {@link setModelOverride}) so the client identity stays stable; the
   * inherited `agent.stream()` and the custom routes
   * ({@link history} / {@link clearHistory} / {@link threads}) all read
   * these headers, so selecting a thread routes every call at once.
   */
  setThreadId(threadId?: string): void {
    const headers = (this.options.headers ??= {});
    if (threadId) headers[THREAD_ID_HEADER] = threadId;
    else delete headers[THREAD_ID_HEADER];
  }

  /**
   * Fetch the cached Model Serving endpoint catalogue from
   * `GET ${basePath}/models`. Returns every endpoint the plugin
   * publishes (server-cached for ~5 minutes); callers filter to
   * chat-capable models for a picker.
   */
  async models(signal?: AbortSignal): Promise<ServingEndpointSummary[]> {
    const payload = await this.#getJson(
      `${this.basePath}${MASTRA_ROUTES.models}`,
      ServingEndpointsResponseSchema,
      signal,
    );
    return payload.endpoints;
  }

  /**
   * Fetch the curated starter questions for `agentId`'s Genie space
   * from `GET ${basePath}/suggestions`. Empty when the agent has no
   * Genie space (or it defines none).
   */
  async suggestions(agentId?: string, signal?: AbortSignal): Promise<string[]> {
    const payload = await this.#getJson(
      this.#agentScoped(MASTRA_ROUTES.suggestions, agentId),
      MastraSuggestionsResponseSchema,
      signal,
    );
    return payload.questions;
  }

  /**
   * Fetch one page of thread history from `GET ${basePath}/history`.
   * Messages come back oldest -> newest so the caller can prepend them
   * to a live transcript.
   */
  async history(
    options: {
      agentId?: string;
      page?: number;
      perPage?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<MastraHistoryResponse> {
    const params = new URLSearchParams();
    if (options.page !== undefined) params.set("page", String(options.page));
    if (options.perPage !== undefined) params.set("perPage", String(options.perPage));
    const qs = params.toString();
    const base = this.#agentScoped(MASTRA_ROUTES.history, options.agentId);
    return this.#getJson(
      qs ? `${base}?${qs}` : base,
      MastraHistoryResponseSchema,
      options.signal,
    );
  }

  /**
   * Wipe the caller's thread history (`DELETE ${basePath}/history`).
   * The session cookie that anchors the thread id is preserved - only
   * the messages go away. Idempotent: a fresh thread reports
   * `cleared: 0` without erroring.
   */
  async clearHistory(
    options: { agentId?: string; signal?: AbortSignal } = {},
  ): Promise<MastraClearHistoryResponse> {
    return this.#mutateJson(
      this.#agentScoped(MASTRA_ROUTES.history, options.agentId),
      "DELETE",
      MastraClearHistoryResponseSchema,
      options.signal ? { signal: options.signal } : {},
    );
  }

  /**
   * Fetch one page of the caller's conversation threads from
   * `GET ${basePath}/threads`, newest first. Used to render the
   * conversation list / sidebar so the user can switch between the
   * threads they own for this resource. Scoped server-side to the
   * caller's resource id, so it only ever returns the user's own
   * conversations.
   */
  async threads(
    options: {
      agentId?: string;
      page?: number;
      perPage?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<MastraThreadsResponse> {
    const params = new URLSearchParams();
    if (options.page !== undefined) params.set("page", String(options.page));
    if (options.perPage !== undefined) params.set("perPage", String(options.perPage));
    const qs = params.toString();
    const base = this.#agentScoped(MASTRA_ROUTES.threads, options.agentId);
    return this.#getJson(
      qs ? `${base}?${qs}` : base,
      MastraThreadsResponseSchema,
      options.signal,
    );
  }

  /**
   * Delete a single conversation thread by id via the plugin's own
   * `DELETE ${basePath}/threads` route (named `removeThread` to avoid
   * clashing with the inherited `MastraClient.deleteThread`, which hits
   * Mastra's stock thread route rather than our OBO-scoped, custom
   * mount). The id is sent as the thread-selection header for this one
   * call (without disturbing the client's currently-selected thread,
   * set via {@link setThreadId}), so the sidebar can remove any thread
   * while the user stays on another. Idempotent: deleting an unknown /
   * already-removed thread reports `deleted: false` without erroring.
   */
  async removeThread(
    threadId: string,
    options: { agentId?: string; signal?: AbortSignal } = {},
  ): Promise<MastraDeleteThreadResponse> {
    return this.#mutateJson(
      this.#agentScoped(MASTRA_ROUTES.threads, options.agentId),
      "DELETE",
      MastraDeleteThreadResponseSchema,
      {
        headers: { [THREAD_ID_HEADER]: threadId },
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
  }

  /**
   * Rename a single conversation thread via the plugin's own
   * `PATCH ${basePath}/threads` route. The id travels as the
   * thread-selection header for this one call (mirroring
   * {@link removeThread}, so the sidebar can rename any thread without
   * disturbing the client's currently-selected thread) and the new
   * `title` rides in the JSON body. The server enforces ownership and
   * echoes back the updated thread, so the caller can reflect the new
   * title immediately. Throws on an unknown / unowned thread (HTTP 404).
   */
  async renameThread(
    threadId: string,
    title: string,
    options: { agentId?: string; signal?: AbortSignal } = {},
  ): Promise<MastraUpdateThreadResponse> {
    return this.#mutateJson(
      this.#agentScoped(MASTRA_ROUTES.threads, options.agentId),
      "PATCH",
      MastraUpdateThreadResponseSchema,
      {
        body: { title },
        headers: { [THREAD_ID_HEADER]: threadId },
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
  }

  /**
   * Log user feedback for a turn to `POST ${basePath}/route/feedback`.
   * `traceId` is the `tr-<hex>` value the server sent on the stream
   * response (via `MLFLOW_TRACE_ID_HEADER`) for that assistant message;
   * `value` carries a thumbs (boolean) / rating, and/or `comment`
   * carries freeform text. The server logs it as a HUMAN assessment on
   * the trace, attributed to the signed-in user.
   *
   * Resolves with `{ ok: false }` (not a throw) when the assessment
   * couldn't be recorded yet - most often because the trace is still
   * exporting to MLflow - so callers can prompt a retry. Throws only on
   * a transport / HTTP-level failure.
   */
  async feedback(input: MastraFeedbackRequest): Promise<MastraFeedbackResponse> {
    return this.#mutateJson(
      `${this.basePath}${MASTRA_ROUTES.feedback}`,
      "POST",
      MastraFeedbackResponseSchema,
      { body: input },
    );
  }

  /**
   * Resolve a `[chart:<id>]` marker from
   * `GET ${basePath}/embed/chart/:id`. The chart planner runs in the
   * background, so the server long-polls the cache and returns the
   * settled entry in one response. A 404 (unknown / expired id)
   * resolves to `undefined` so the slot renders nothing.
   */
  chart(id: string, signal?: AbortSignal): Promise<Chart | undefined> {
    return this.#embed("chart", id, ChartSchema.parse, signal);
  }

  /**
   * Resolve a `[data:<id>]` marker from
   * `GET ${basePath}/embed/data/:id`. Returns the same coerced rows the
   * `get_statement` tool produced for the model. A 404 resolves to
   * `undefined`.
   */
  statement(id: string, signal?: AbortSignal): Promise<StatementData | undefined> {
    return this.#embed("data", id, StatementDataSchema.parse, signal);
  }

  /**
   * Compose an agent-scoped URL: `${basePath}${segment}` for the
   * default agent (the mount that does not require an `:agentId`), or
   * `${basePath}${segment}/<encoded id>` for any other agent.
   */
  #agentScoped(segment: string, agentId: string | undefined): string {
    const path = `${this.basePath}${segment}`;
    const id = agentId ?? this.defaultAgent;
    return !id || id === this.defaultAgent ? path : `${path}/${encodeURIComponent(id)}`;
  }

  /**
   * Snapshot of the client's per-request override headers (model +
   * thread selection) for the custom-route fetches that don't go
   * through `@mastra/client-js`'s own request pipeline. Returns a fresh
   * object each call so a caller can safely add one-off headers without
   * mutating the shared `options.headers`. The thread-selection header
   * here is what routes `history()` / `clearHistory()` / `threads()` to
   * the currently-selected thread (see {@link setThreadId}).
   */
  #defaultHeaders(): Record<string, string> {
    return { ...((this.options.headers as Record<string, string>) ?? {}) };
  }

  /** GET + JSON-parse + schema-validate against a route that always 200s. */
  async #getJson<T>(
    url: string,
    schema: { parse: (raw: unknown) => T },
    signal?: AbortSignal,
  ): Promise<T> {
    const init: RequestInit = {
      credentials: "include",
      headers: this.#defaultHeaders(),
    };
    if (signal) init.signal = signal;
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return schema.parse(await res.json());
  }

  /**
   * `POST` / `DELETE` / `PATCH` + JSON-parse + schema-validate for the
   * mutating routes (`clearHistory` / `removeThread` / `renameThread` /
   * `feedback`). A JSON body, when present, sets `Content-Type`;
   * `options.headers` add one-off headers (e.g. the thread-selection
   * header for a targeted delete / rename) over the client's default
   * override headers.
   */
  async #mutateJson<T>(
    url: string,
    method: "POST" | "DELETE" | "PATCH",
    schema: { parse: (raw: unknown) => T },
    options: {
      body?: unknown;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    const headers = { ...this.#defaultHeaders(), ...options.headers };
    const init: RequestInit = { method, credentials: "include", headers };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    if (options.signal) init.signal = options.signal;
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return schema.parse(await res.json());
  }

  /**
   * Single-shot fetch of an embed marker of kind `type`. A 404
   * (unknown embed type, or unknown / expired id) resolves to
   * `undefined` so the host treats it as a missing slot. Caching /
   * long-poll retry policy is the caller's concern.
   */
  async #embed<T>(
    type: string,
    id: string,
    parse: (raw: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    const url = `${this.basePath}${MASTRA_ROUTES.embed}/${encodeURIComponent(
      type,
    )}/${encodeURIComponent(id)}`;
    const init: RequestInit = { credentials: "include" };
    if (signal) init.signal = signal;
    const res = await fetch(url, init);
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parse(await res.json());
  }
}

/**
 * Read the Mastra plugin's `clientConfig()` payload (`basePath`,
 * default agent, registered agent list). One call per render; values
 * are cached at boot by `usePluginClientConfig`.
 */
export const useMastraConfig = (): MastraClientConfig =>
  usePluginClientConfig<MastraClientConfig>("mastra");

/**
 * The single {@link MastraPluginClient} for the plugin, built once from
 * the published `basePath`. Use it for everything: stream a turn with
 * `client.getAgent(agentId).stream(...)`, page history with
 * `client.history()`, resolve embeds with `client.chart(id)`, etc.
 * Rebuilt only when `basePath` / `defaultAgent` change (e.g. a custom
 * mount), so it's safe as a `useMemo` / `useCallback` / `useEffect`
 * dependency; the per-request model override is applied in place via
 * {@link MastraPluginClient.setModelOverride} without changing identity.
 */
export const useMastraClient = (): MastraPluginClient => {
  const config = useMastraConfig();
  return useMemo(
    () => new MastraPluginClient(config),
    // `config` identity can churn across renders; the route layout is
    // fully determined by these two scalars.
    [config.basePath, config.defaultAgent],
  );
};

/**
 * Fetch the cached Model Serving endpoint catalogue exposed by the
 * Mastra plugin (`client.models()`). Filters out non-LLM endpoints
 * (anything without a `llm/v1/*` task) so the dropdown doesn't surface
 * embedding / vision / agent-bricks endpoints. The response itself is
 * server-cached for 5 minutes so polling cost is negligible.
 *
 * Pass `enabled: false` to skip the fetch entirely (e.g. when the
 * model picker is hidden), in which case `models` stays empty.
 */
export const useMastraModels = (
  enabled = true,
): {
  models: ServingEndpointSummary[];
  loading: boolean;
  error: Error | null;
} => {
  const client = useMastraClient();
  const [models, setModels] = useState<ServingEndpointSummary[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    client
      .models(controller.signal)
      .then((endpoints) => {
        if (controller.signal.aborted) return;
        // Filter to chat-capable endpoints, dropping embeddings (which
        // carry the `llm/v1/embeddings` task) so the chat picker never
        // lists a vectoriser. If the server didn't tag tasks at all,
        // pass everything through so we don't show an empty list.
        const llms = endpoints.filter(
          (e) =>
            e.task !== "llm/v1/embeddings" && (!e.task || e.task.startsWith("llm/v1/")),
        );
        setModels(llms.length > 0 ? llms : endpoints);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(commonUtils.toError(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [client, enabled]);

  return { models, loading, error };
};

/**
 * Fetch the curated starter questions for an agent's Genie space via
 * `client.suggestions(agentId)`. These are the `sample_questions` an
 * author configured on the space, surfaced as one-tap prompts on the
 * chat empty state. The server returns an empty list when the agent
 * has no Genie space, so `questions` stays empty in that case and the
 * UI shows a bare empty state rather than built-in example prompts.
 *
 * Pass `enabled: false` to skip the fetch (e.g. when the caller
 * supplies its own explicit suggestion list), in which case
 * `questions` stays empty. Any fetch error degrades silently to no
 * suggestions - they're a non-critical enhancement.
 */
export const useMastraSuggestions = (
  agentId?: string,
  enabled = true,
): { questions: string[]; loading: boolean } => {
  const client = useMastraClient();
  const [questions, setQuestions] = useState<string[]>([]);
  const [loading, setLoading] = useState(enabled);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      setQuestions([]);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    client
      .suggestions(agentId, controller.signal)
      .then((qs) => {
        if (controller.signal.aborted) return;
        setQuestions(Array.isArray(qs) ? qs : []);
      })
      .catch(() => {
        // Non-critical: a failed lookup just means no starter prompts.
        if (!controller.signal.aborted) setQuestions([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [client, agentId, enabled]);

  return { questions, loading };
};

/**
 * Fetch (and re-fetch) the caller's conversation threads for an agent
 * via `client.threads(agentId)`. Drives the conversation list / sidebar
 * so the user can switch between the threads they own. Newest first
 * (`updatedAt` DESC), scoped server-side to the caller's resource.
 *
 * Returns a `refresh()` the chat driver calls after a turn completes
 * (a new thread appears, or its auto-generated title lands) and after a
 * clear / delete, so the list stays in sync without polling. Pass
 * `enabled: false` to skip the fetch entirely (e.g. when the sidebar is
 * hidden), in which case `threads` stays empty. A failed fetch degrades
 * to an empty list - the conversation list is a non-critical
 * enhancement layered over the always-available default thread.
 */
export const useMastraThreads = (
  agentId?: string,
  enabled = true,
): {
  threads: MastraThread[];
  loading: boolean;
  error: Error | null;
  refresh: () => void;
} => {
  const client = useMastraClient();
  const [threads, setThreads] = useState<MastraThread[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);
  // Bumped by `refresh()` to force a re-fetch without changing any of
  // the natural deps (client / agentId / enabled).
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      setThreads([]);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    client
      .threads({ agentId, signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        setThreads(res.threads);
        setError(null);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted || (e as { name?: string }).name === "AbortError")
          return;
        setError(commonUtils.toError(e));
        setThreads([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [client, agentId, enabled, nonce]);

  return { threads, loading, error, refresh };
};

/**
 * Hook state for {@link useByIdFetch}. Generic over the
 * resource's payload shape; consumers read `data` / `loading` /
 * `error` exactly as the chart and statement slots do. A 404 on
 * the server resolves as `data === undefined` with `error ===
 * null` so the slot renders nothing (matches "expired /
 * unknown id" semantics across all by-id resources).
 */
export interface ByIdFetchState<T> {
  data: T | undefined;
  loading: boolean;
  error: Error | null;
}

/**
 * Module-level by-key cache for `/<resource>/:id` fetches.
 *
 * Statements are immutable by construction (a `statement_id`
 * always materializes the same rows), and a settled chart entry
 * (`result` or `error` set) never changes either, so caching for
 * the tab's lifetime is safe. The cache solves two problems the
 * chat UI hits constantly:
 *
 *   1. Re-mount churn: streaming assistant text re-renders the
 *      markdown on every chunk, React StrictMode double-mounts
 *      effects in dev, and any parent re-render can shift slot
 *      identity. Without a cache, each remount cancels the
 *      in-flight fetch and starts another. With it, remounts hit
 *      the cache synchronously - zero network, zero spinner flash.
 *   2. Concurrent consumers: two slots pointing at the same id
 *      (e.g. user toggles a thread that already rendered the
 *      same chart in history) dedupe to a single in-flight
 *      promise instead of racing parallel fetches.
 *
 * Two-state entry shape: `pending` while a fetch is in flight,
 * `ready` once it settles (including 404 -> `data: undefined`).
 * Errors are NOT cached - the entry is deleted on rejection so
 * the next consumer retries. Per-consumer cancellation only
 * detaches that consumer from the promise; the fetch keeps
 * running for any other live consumer. Page reload clears
 * everything. Keyed by `<type>:<id>` (e.g. `chart:abc123`).
 */
type FetchCacheEntry<T> =
  | { kind: "pending"; promise: Promise<T | undefined> }
  | { kind: "ready"; data: T | undefined };

const fetchCache = new Map<string, FetchCacheEntry<unknown>>();

/**
 * Resolve `key` through the by-id cache. See {@link fetchCache}
 * for the lifecycle. `fetcher` performs the underlying single-shot
 * request ({@link MastraPluginClient.chart} /
 * {@link MastraPluginClient.statement}), resolving to `undefined` on a
 * 404. `isTerminal` lets callers opt out of caching responses that
 * aren't actually settled yet (e.g. a chart whose planner is still
 * working): only `true` answers land as `kind: "ready"`, everything
 * else is dropped so the next mount refetches.
 *
 * 404s always cache (as `data: undefined`) - unknown ids stay
 * unknown for the tab's lifetime, mirroring the slot semantics
 * ("expired / never minted -> render nothing").
 */
async function fetchByIdCached<T>(
  key: string,
  fetcher: () => Promise<T | undefined>,
  isTerminal: (data: T) => boolean,
): Promise<T | undefined> {
  const existing = fetchCache.get(key) as FetchCacheEntry<T> | undefined;
  if (existing?.kind === "ready") return existing.data;
  if (existing?.kind === "pending") return existing.promise;

  const promise = (async (): Promise<T | undefined> => {
    const data = await fetcher();
    if (data === undefined) {
      fetchCache.set(key, { kind: "ready", data: undefined });
      return undefined;
    }
    if (isTerminal(data)) {
      fetchCache.set(key, { kind: "ready", data });
    } else {
      fetchCache.delete(key);
    }
    return data;
  })().catch((err: unknown) => {
    fetchCache.delete(key);
    throw err;
  });

  fetchCache.set(key, { kind: "pending", promise } as FetchCacheEntry<unknown>);
  return promise;
}

/** Synchronous cache peek used to seed initial state on mount. */
function readFetchCache<T>(key: string | undefined): T | undefined {
  if (!key) return undefined;
  const e = fetchCache.get(key) as FetchCacheEntry<T> | undefined;
  return e?.kind === "ready" ? e.data : undefined;
}

/**
 * React hook for any resource the Mastra plugin exposes as
 * `/<resource>/:id`. Powers both the chart and statement slots
 * in the chat UI; the slot-specific hooks below are thin
 * adapters that pick the right cache `key`, `fetcher`, and
 * terminal check.
 *
 * Cached through {@link fetchByIdCached} - re-mounts (StrictMode,
 * markdown re-parses during streaming, parent re-renders) hit
 * the cache synchronously instead of re-firing the network call.
 * Per-consumer unmount only detaches that consumer from the
 * shared promise; the underlying fetch keeps running for any
 * other live consumer.
 *
 * `key`, `fetcher`, and `isTerminal` must be referentially stable
 * (memoized by the caller) so the effect doesn't refire every render.
 */
function useByIdFetch<T>(
  key: string | undefined,
  fetcher: () => Promise<T | undefined>,
  isTerminal: (data: T) => boolean,
): ByIdFetchState<T> {
  const [data, setData] = useState<T | undefined>(() => readFetchCache<T>(key));
  const [loading, setLoading] = useState(
    () => key !== undefined && readFetchCache<T>(key) === undefined,
  );
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!key) {
      setData(undefined);
      setLoading(false);
      setError(null);
      return;
    }
    const cached = readFetchCache<T>(key);
    if (cached !== undefined) {
      setData(cached);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setData(undefined);
    setError(null);
    setLoading(true);

    fetchByIdCached<T>(key, fetcher, isTerminal)
      .then((payload) => {
        if (cancelled) return;
        setData(payload);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(commonUtils.toError(e));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [key, fetcher, isTerminal]);

  return { data, loading, error };
}

/**
 * `isTerminal` for {@link useChartFetch}. A chart entry is
 * "ready to cache forever" only once the planner has either
 * landed an Echarts spec (`result`) or surfaced a failure
 * (`error`). Entries with neither field are pathologically slow
 * planners that exceeded the server's long-poll budget; leaving
 * them uncached means a re-mount can retry instead of being
 * stuck on a stale "in-flight" snapshot for the tab's lifetime.
 *
 * Module-level so the {@link useByIdFetch} effect's dep array
 * stays stable - inlining a fresh closure would refire the
 * effect on every render.
 */
const chartIsTerminal = (c: Chart): boolean =>
  c.result !== undefined || c.error !== undefined;

/**
 * `isTerminal` for {@link useStatementFetch}. A statement
 * response is always terminal - the Statement Execution API
 * returns the rows in one shot, so any 200 is cacheable.
 */
const statementIsTerminal = (_: StatementData): boolean => true;

/**
 * Fetch a chart by id from the Mastra plugin's generic
 * `/embed/chart/:id` endpoint via {@link MastraPluginClient.chart}.
 * Used by the chat UI to resolve `[chart:<chartId>]` markers the agent
 * embeds in prose.
 *
 * The chart planner runs in the background after `prepare_chart`
 * mints the id, so the server long-polls the cache until the
 * entry settles (`result` or `error` set) and returns the final
 * payload in a single response. The hook performs ONE cached
 * fetch and surfaces:
 *
 *   - `data.result` set → render the Echarts spec.
 *   - `data.error` set → surface via `data.error`.
 *   - `data` with neither field (planner exceeded the server's
 *     long-poll budget) → render nothing; this answer is NOT
 *     cached, so a re-mount will retry.
 *   - `data === undefined` (404) → unknown / expired id; render
 *     nothing.
 */
export const useChartFetch = (chartId: string | undefined): ByIdFetchState<Chart> => {
  const client = useMastraClient();
  const key = chartId ? `chart:${chartId}` : undefined;
  const fetcher = useCallback(() => client.chart(chartId as string), [client, chartId]);
  return useByIdFetch<Chart>(key, fetcher, chartIsTerminal);
};

/**
 * Fetch the rows of a Databricks statement by id from the Mastra
 * plugin's generic `/embed/data/:id` endpoint via
 * {@link MastraPluginClient.statement}. Used by the chat UI to resolve
 * `[data:<statement_id>]` markers the agent embeds in prose.
 * Server-side, the route reuses the `get_statement` tool's fetch +
 * coercion pipeline so the shape matches what the LLM saw for the same
 * statement; `data.truncated` signals the server clipped to its row
 * cap. Cached for the tab's lifetime because a `statement_id`
 * materializes the same rows forever.
 */
export const useStatementFetch = (
  statementId: string | undefined,
): ByIdFetchState<StatementData> => {
  const client = useMastraClient();
  const key = statementId ? `data:${statementId}` : undefined;
  const fetcher = useCallback(
    () => client.statement(statementId as string),
    [client, statementId],
  );
  return useByIdFetch<StatementData>(key, fetcher, statementIsTerminal);
};
