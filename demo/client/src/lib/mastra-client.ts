import { MastraClient } from "@mastra/client-js";
import { useEffect, useMemo, useState } from "react";
import { usePluginClientConfig } from "@databricks/appkit-ui/react";
import {
  chatUrl,
  type MastraClientConfig,
  type ServingEndpointSummary,
  type ServingEndpointsResponse,
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
