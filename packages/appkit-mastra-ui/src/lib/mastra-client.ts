import { usePluginClientConfig } from "@databricks/appkit-ui/react";
import {
  chatUrl,
  embedUrl,
  historyUrl,
  type Chart,
  type MastraClearHistoryResponse,
  type MastraClientConfig,
  type MastraHistoryResponse,
  type ServingEndpointSummary,
  type ServingEndpointsResponse,
  type StatementData,
} from "@dbx-tools/appkit-mastra-shared";
import { MastraClient } from "@mastra/client-js";
import type { UIMessage } from "ai";
import { useEffect, useMemo, useState } from "react";

/** HTTP header the Mastra plugin reads for a per-request model override. */
const MODEL_OVERRIDE_HEADER = "X-Mastra-Model";

/**
 * Read the Mastra plugin's `clientConfig()` payload (mount paths,
 * default agent, registered agent list). One call per render; values
 * are cached at boot by `usePluginClientConfig`.
 */
export const useMastraConfig = (): MastraClientConfig =>
  usePluginClientConfig<MastraClientConfig>("mastra");

/**
 * Build a `MastraClient` from the published `basePath`. Pass `model`
 * to attach `X-Mastra-Model` to every outgoing request, which the
 * Mastra plugin treats as a per-request override (no agent redeploy
 * needed). A new client is returned whenever `model` changes so
 * callers can use it as a `useMemo` dep.
 */
export const useMastraClient = (model?: string): MastraClient => {
  const { basePath } = useMastraConfig();
  return useMemo(
    () =>
      new MastraClient({
        baseUrl:
          typeof window !== "undefined" ? window.location.origin : "http://localhost",
        apiPrefix: basePath,
        ...(model ? { headers: { [MODEL_OVERRIDE_HEADER]: model } } : {}),
      }),
    [basePath, model],
  );
};

/** Convenience: the `chatRoute` URL for an agent (defaults to the registered default). */
export const useChatUrl = (agentId?: string): string => {
  const config = useMastraConfig();
  return chatUrl(config, agentId);
};

/**
 * Fetch the cached Model Serving endpoint catalogue exposed by the
 * Mastra plugin at `GET ${basePath}/models`. Filters out non-LLM
 * endpoints (anything without a `llm/v1/*` task) so the dropdown
 * doesn't surface embedding / vision / agent-bricks endpoints. The
 * response itself is server-cached for 5 minutes so polling cost is
 * negligible.
 */
export const useMastraModels = (): {
  models: ServingEndpointSummary[];
  loading: boolean;
  error: Error | null;
} => {
  const { modelsPath } = useMastraConfig();
  const [models, setModels] = useState<ServingEndpointSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(modelsPath, { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as ServingEndpointsResponse;
      })
      .then((payload) => {
        if (cancelled) return;
        // Filter to chat-capable endpoints; if the server didn't tag
        // tasks at all, just pass everything through so we don't show
        // an empty list.
        const llms = payload.endpoints.filter(
          (e) => !e.task || e.task.startsWith("llm/v1/"),
        );
        setModels(llms.length > 0 ? llms : payload.endpoints);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [modelsPath]);

  return { models, loading, error };
};

/**
 * Page of UI-formatted history messages plus the metadata needed to
 * drive infinite-scroll-up. `uiMessages` is widened to `UIMessage[]`
 * (from the `ai` package) since the server sends back exactly the
 * payload `toAISdkV5Messages` produces; the dependency-free shared
 * types use a structural shape instead of importing `ai`.
 */
export interface MastraHistoryPage {
  uiMessages: UIMessage[];
  page: number;
  perPage: number;
  total: number;
  hasMore: boolean;
}

/**
 * Fetch one page of thread history from the Mastra plugin's
 * `/history` endpoint. Cookies travel with the request so the server
 * can resolve the session-scoped `threadId`. Returns a typed page
 * the UI can prepend (oldest -> newest) to its live transcript.
 */
export const fetchMastraHistory = async (
  config: Pick<MastraClientConfig, "historyPath" | "defaultAgent">,
  options: {
    agentId?: string;
    page?: number;
    perPage?: number;
    signal?: AbortSignal;
  } = {},
): Promise<MastraHistoryPage> => {
  const url = historyUrl(config, {
    ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
    ...(options.page !== undefined ? { page: options.page } : {}),
    ...(options.perPage !== undefined ? { perPage: options.perPage } : {}),
  });
  const init: RequestInit = { credentials: "include" };
  if (options.signal) init.signal = options.signal;
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = (await res.json()) as MastraHistoryResponse;
  return {
    uiMessages: payload.uiMessages as unknown as UIMessage[],
    page: payload.page,
    perPage: payload.perPage,
    total: payload.total,
    hasMore: payload.hasMore,
  };
};

/**
 * Wipe the caller's thread history on the Mastra plugin. Hits
 * `DELETE` on the same `/history` endpoint `fetchMastraHistory`
 * reads from, so the session cookie (and therefore the thread id)
 * is preserved - only the messages go away. Idempotent: a fresh
 * thread reports `cleared: 0` without erroring.
 */
export const clearMastraHistory = async (
  config: Pick<MastraClientConfig, "historyPath" | "defaultAgent">,
  options: { agentId?: string; signal?: AbortSignal } = {},
): Promise<MastraClearHistoryResponse> => {
  const url = historyUrl(config, {
    ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
  });
  const init: RequestInit = { method: "DELETE", credentials: "include" };
  if (options.signal) init.signal = options.signal;
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as MastraClearHistoryResponse;
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
 * Module-level by-URL cache for `/<resource>/:id` fetches.
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
 *      in-flight `fetch()` and starts another. With it,
 *      remounts hit the cache synchronously - zero network,
 *      zero spinner flash.
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
 * everything.
 */
type FetchCacheEntry<T> =
  | { kind: "pending"; promise: Promise<T | undefined> }
  | { kind: "ready"; data: T | undefined };

const fetchCache = new Map<string, FetchCacheEntry<unknown>>();

/**
 * Resolve `url` through the by-id cache. See {@link fetchCache}
 * for the lifecycle. `isTerminal` lets callers opt out of
 * caching responses that aren't actually settled yet (e.g. a
 * chart whose planner is still working): only `true` answers
 * land as `kind: "ready"`, everything else is dropped so the
 * next mount refetches.
 *
 * 404s always cache (as `data: undefined`) - unknown ids stay
 * unknown for the tab's lifetime, mirroring the slot semantics
 * ("expired / never minted -> render nothing").
 */
async function fetchByIdCached<T>(
  url: string,
  isTerminal: (data: T) => boolean,
): Promise<T | undefined> {
  const existing = fetchCache.get(url) as FetchCacheEntry<T> | undefined;
  if (existing?.kind === "ready") return existing.data;
  if (existing?.kind === "pending") return existing.promise;

  const promise = (async (): Promise<T | undefined> => {
    const res = await fetch(url, { credentials: "include" });
    if (res.status === 404) {
      fetchCache.set(url, { kind: "ready", data: undefined });
      return undefined;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as T;
    if (isTerminal(data)) {
      fetchCache.set(url, { kind: "ready", data });
    } else {
      fetchCache.delete(url);
    }
    return data;
  })().catch((err: unknown) => {
    fetchCache.delete(url);
    throw err;
  });

  fetchCache.set(url, { kind: "pending", promise } as FetchCacheEntry<unknown>);
  return promise;
}

/** Synchronous cache peek used to seed initial state on mount. */
function readFetchCache<T>(url: string | undefined): T | undefined {
  if (!url) return undefined;
  const e = fetchCache.get(url) as FetchCacheEntry<T> | undefined;
  return e?.kind === "ready" ? e.data : undefined;
}

/**
 * React hook for any resource the Mastra plugin exposes as
 * `/<resource>/:id`. Powers both the chart and statement slots
 * in the chat UI; the slot-specific hooks below are thin
 * adapters that pick the right path template and terminal check.
 *
 * Cached through {@link fetchByIdCached} - re-mounts (StrictMode,
 * markdown re-parses during streaming, parent re-renders) hit
 * the cache synchronously instead of re-firing the network call.
 * Per-consumer unmount only detaches that consumer from the
 * shared promise; the underlying fetch keeps running for any
 * other live consumer.
 */
function useByIdFetch<T>(
  id: string | undefined,
  url: string | undefined,
  isTerminal: (data: T) => boolean,
): ByIdFetchState<T> {
  const [data, setData] = useState<T | undefined>(() => readFetchCache<T>(url));
  const [loading, setLoading] = useState(
    () => id !== undefined && url !== undefined && readFetchCache<T>(url) === undefined,
  );
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!id || !url) {
      setData(undefined);
      setLoading(false);
      setError(null);
      return;
    }
    const cached = readFetchCache<T>(url);
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

    fetchByIdCached<T>(url, isTerminal)
      .then((payload) => {
        if (cancelled) return;
        setData(payload);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [id, url, isTerminal]);

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
 * `/embed/chart/:id` endpoint. Used by the chat UI to resolve
 * `[chart:<chartId>]` markers the agent embeds in prose.
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
  const { embedPathTemplate } = useMastraConfig();
  const url = useMemo(
    () => (chartId ? embedUrl({ embedPathTemplate }, "chart", chartId) : undefined),
    [chartId, embedPathTemplate],
  );
  return useByIdFetch<Chart>(chartId, url, chartIsTerminal);
};

/**
 * Fetch the rows of a Databricks statement by id from the Mastra
 * plugin's generic `/embed/data/:id` endpoint. Used by the chat
 * UI to resolve `[data:<statement_id>]` markers the agent embeds
 * in prose. Server-side, the route reuses the `get_statement`
 * tool's fetch + coercion pipeline so the shape matches what the
 * LLM saw for the same statement; `data.truncated` signals the
 * server clipped to its row cap. Cached for the tab's lifetime
 * because a `statement_id` materializes the same rows forever.
 */
export const useStatementFetch = (
  statementId: string | undefined,
): ByIdFetchState<StatementData> => {
  const { embedPathTemplate } = useMastraConfig();
  const url = useMemo(
    () =>
      statementId ? embedUrl({ embedPathTemplate }, "data", statementId) : undefined,
    [statementId, embedPathTemplate],
  );
  return useByIdFetch<StatementData>(statementId, url, statementIsTerminal);
};
