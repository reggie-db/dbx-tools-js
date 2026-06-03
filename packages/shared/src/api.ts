import type { WorkspaceClient } from "@databricks/sdk-experimental";
import { CacheManager, getExecutionContext } from "@databricks/appkit";

// Direct imports (not via the barrel). The package's NodeNext
// module resolution wants explicit `.js` extensions on relative
// imports, and reaching for `commonUtils` / `httpUtils` through
// `../index.client` confused the `noEmit` typecheck with a
// missing-extension error. Direct sibling imports stay typed and
// don't risk a future cycle.
import { fnvHash } from "./common.js";
import { joinUrlSegments, toURL } from "./http.js";

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const API_PREFIX = "/api/2.0";
type GetOrExecuteParams = Parameters<CacheManager["getOrExecute"]>;

/**
 * Issue an authenticated request against a Databricks workspace REST
 * endpoint, resolving the host from the supplied `WorkspaceClient`
 * and stamping the OAuth/PAT auth header in for you. The response
 * body is returned parsed as JSON.
 *
 * `path` may be a single string or an array of segments. A leading
 * `/api/2.0` is auto-stripped so callers can pass either style
 * (`"/api/2.0/serving-endpoints"` or `"/serving-endpoints"`) without
 * doubling it in the final URL.
 *
 * `init` is an optional WHATWG `RequestInit`. Useful fields:
 *
 *   - `body`: request payload. Strings / `Buffer` / `FormData` /
 *     `URLSearchParams` pass through; for JSON, stringify the object
 *     yourself and set `headers["Content-Type"] = "application/json"`.
 *   - `headers`: extra request headers, merged in **before** the auth
 *     header is applied so the workspace's `Authorization` always
 *     wins on conflict.
 *   - `method`: HTTP verb. If omitted, defaults to `POST` when
 *     `init.body` is present and `GET` otherwise.
 *
 * @example
 * await fetchApi(ws, "/serving-endpoints");
 *
 * await fetchApi(ws, ["/serving-endpoints", endpointName, "invocations"], {
 *   body: JSON.stringify({ inputs: [...] }),
 *   headers: { "Content-Type": "application/json" },
 * });
 */
export async function fetchApi<T>(
  target: URL | string[] | string,
  init?: RequestInit,
  cache?: {
    key?: GetOrExecuteParams[0];
    userKey?: GetOrExecuteParams[2];
    options: GetOrExecuteParams[3];
  },
  workspaceClient?: WorkspaceClient,
): Promise<T> {
  const client = workspaceClient ?? getExecutionContext().client;
  const config = client.config;
  const url = target instanceof URL ? target : await apiUrl(target, client);
  if (cache) {
    const executionContext = getExecutionContext();
    const userId =
      "userId" in executionContext
        ? executionContext.userId
        : executionContext.serviceUserId;
    const cacheInstance = await CacheManager.getInstance();
    return cacheInstance.getOrExecute(
      cache.key ?? ["fetchApi", userId],
      async () => {
        return fetchApi(url, init, undefined, workspaceClient);
      },
      cache.userKey ?? fnvHash(url.toString()),
      cache.options,
    );
  }
  const headers = new Headers(init?.headers);
  await config.authenticate(headers);
  const method = init?.method?.toUpperCase() ?? (init?.body ? "POST" : "GET");
  const response = await fetch(url.toString(), {
    ...init,
    method,
    headers,
  });
  return response.json() as Promise<T>;
}

export async function apiUrl(
  path: string[] | string,
  workspaceClient?: WorkspaceClient,
): Promise<URL> {
  let joinedPath = joinUrlSegments(path);
  if (joinedPath === API_PREFIX || joinedPath.startsWith(API_PREFIX + "/")) {
    joinedPath = joinedPath.slice(API_PREFIX.length);
  }
  if (!joinedPath) {
    throw new Error(`Invalid path: ${path}`);
  }
  const client = workspaceClient ?? getExecutionContext().client;
  const config = client.config;
  const host = await config.getHost();
  const url = toURL(host, API_PREFIX, joinedPath)!;
  return url;
}
