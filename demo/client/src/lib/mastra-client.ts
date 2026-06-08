import { MastraClient } from "@mastra/client-js";
import { useEffect, useMemo, useState } from "react";
import type { UIMessage } from "ai";
import { usePluginClientConfig } from "@databricks/appkit-ui/react";
import {
  chartUrl,
  chatUrl,
  historyUrl,
  statementUrl,
  type MastraClearHistoryResponse,
  type MastraClientConfig,
  type MastraHistoryResponse,
  type Chart,
  type ServingEndpointSummary,
  type ServingEndpointsResponse,
  type StatementData,
} from "@dbx-tools/appkit-mastra-shared";

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
 * Hook state returned by {@link useChartFetch}. Mirrors the cache
 * lifecycle inferred from the {@link Chart}'s two
 * optional fields:
 *
 *   - `chart === undefined` while the first request is in flight
 *     or after a 404 (the slot stays empty - markers that point
 *     at expired ids resolve as nothing rather than as broken
 *     placeholders).
 *   - `chart` with neither `result` nor `error` set: planner is
 *     still working - the hook keeps polling.
 *   - `chart.result` set: planner finished. The embedded `option`
 *     is a full Echarts spec.
 *   - `chart.error` set: planner / data fetch failed; the slot
 *     can surface `chart.error` directly.
 */
export interface ChartFetchState {
  chart: Chart | undefined;
  loading: boolean;
  error: Error | null;
}

/**
 * Long-poll the Mastra plugin's `/charts/:chartId` endpoint until
 * the cache entry settles (`result` or `error` set), then stop.
 *
 * Resolution flow:
 *
 *   1. Initial fetch with a 60s long-poll budget. The server
 *      blocks until the entry settles or the budget elapses.
 *   2. If the entry comes back still-processing (neither `result`
 *      nor `error` set), the hook re-fires after a short backoff.
 *      This handles the race where the planner needs more than one
 *      server-side budget.
 *   3. Settled entries (`result` or `error` set) are terminal -
 *      the hook stops fetching.
 *   4. A 404 is also terminal - we treat the chartId as missing
 *      (TTL elapsed, never minted) and leave `chart` undefined.
 *
 * The returned `error` only surfaces unexpected network / parse
 * failures; a successful `error`-field entry is exposed via
 * `chart.error` so the UI distinguishes "we couldn't reach the
 * server" from "the server told us the chart failed".
 */
export const useChartFetch = (chartId: string | undefined): ChartFetchState => {
  const { chartsPathTemplate } = useMastraConfig();
  const [chart, setChart] = useState<Chart | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!chartId) {
      setChart(undefined);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setChart(undefined);
    setError(null);
    setLoading(true);

    const poll = async (): Promise<void> => {
      const url = chartUrl({ chartsPathTemplate }, chartId);
      while (!cancelled) {
        let res: Response;
        try {
          res = await fetch(url, {
            credentials: "include",
            signal: controller.signal,
          });
        } catch (e) {
          if (cancelled || controller.signal.aborted) return;
          setError(e instanceof Error ? e : new Error(String(e)));
          setLoading(false);
          return;
        }
        if (cancelled) return;
        if (res.status === 404) {
          setChart(undefined);
          setLoading(false);
          return;
        }
        if (!res.ok) {
          setError(new Error(`HTTP ${res.status}`));
          setLoading(false);
          return;
        }
        const payload = (await res.json()) as Chart;
        if (cancelled) return;
        setChart(payload);
        if (payload.result !== undefined || payload.error !== undefined) {
          setLoading(false);
          return;
        }
      }
    };
    void poll();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [chartId, chartsPathTemplate]);

  return { chart, loading, error };
};

/**
 * Hook state returned by {@link useStatementFetch}. Mirrors a
 * single-shot fetch (no long-polling needed - the agent only
 * embeds `[data:<id>]` markers for statements that have already
 * terminated upstream): one of `data` / `error` settles and the
 * hook stops.
 *
 *   - `data === undefined`, `loading === true`: first fetch in
 *     flight.
 *   - `data === undefined`, `loading === false`, `error === null`:
 *     404 - the statement id is unknown or no longer resolvable
 *     through the workspace; the slot should render nothing.
 *   - `data` set: rows are ready to render. `data.truncated`
 *     signals that the server clipped to its row cap.
 *   - `error` set: an unexpected network / parse failure.
 *     Distinguishes "we couldn't reach the server" from "the
 *     server told us the statement is missing".
 */
export interface StatementFetchState {
  data: StatementData | undefined;
  loading: boolean;
  error: Error | null;
}

/**
 * Fetch the rows of a Databricks statement by id from the Mastra
 * plugin's `/statements/:statementId` endpoint. Used by the chat
 * UI to resolve `[data:<statement_id>]` markers the agent
 * embeds in prose.
 *
 * Resolution flow:
 *
 *   1. Single OBO-scoped fetch via the published
 *      `statementsPathTemplate`. The server reuses the
 *      `get_statement` tool's fetch+coercion pipeline so the
 *      shape matches what the LLM saw for the same statement.
 *   2. 200 -> `data` settles; render the rows.
 *   3. 404 -> `data` stays `undefined`; the slot renders
 *      nothing (matches how unknown chartIds resolve).
 *   4. Any other failure -> `error` settles for the caller to
 *      surface or swallow.
 *
 * Cookies travel with the request so the per-session OBO token
 * scopes the workspace fetch.
 */
export const useStatementFetch = (
  statementId: string | undefined,
): StatementFetchState => {
  const { statementsPathTemplate } = useMastraConfig();
  const [data, setData] = useState<StatementData | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!statementId) {
      setData(undefined);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setData(undefined);
    setError(null);
    setLoading(true);

    const url = statementUrl({ statementsPathTemplate }, statementId);
    fetch(url, { credentials: "include", signal: controller.signal })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404) {
          setData(undefined);
          setLoading(false);
          return;
        }
        if (!res.ok) {
          setError(new Error(`HTTP ${res.status}`));
          setLoading(false);
          return;
        }
        const payload = (await res.json()) as StatementData;
        if (cancelled) return;
        setData(payload);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled || controller.signal.aborted) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [statementId, statementsPathTemplate]);

  return { data, loading, error };
};
