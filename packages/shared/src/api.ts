import type { CancellationToken, WorkspaceClient } from "@databricks/sdk-experimental";
import { Context } from "@databricks/sdk-experimental";
import { CacheManager, getExecutionContext } from "@databricks/appkit";

// Direct imports (not via the barrel). The package's NodeNext
// module resolution wants explicit `.js` extensions on relative
// imports, and reaching for `commonUtils` / `netUtils` through
// `../index.client` confused the `noEmit` typecheck with a
// missing-extension error. Direct sibling imports stay typed and
// don't risk a future cycle.
import { fnvHash, tieAbortSignal } from "./common.js";
import { joinUrl, parseUrl } from "./net.browser.js";

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const API_PREFIX = "/api/2.0";
type GetOrExecuteParams = Parameters<CacheManager["getOrExecute"]>;
type ApiRequestInit = RequestInit & {
  cache?: {
    key?: GetOrExecuteParams[0];
    userKey?: GetOrExecuteParams[2];
    options: GetOrExecuteParams[3];
  };
  workspaceClient?: WorkspaceClient;
};

/**
 * Build the absolute `URL` for a Databricks workspace REST endpoint
 * without issuing a request. Mirrors {@link fetchApi}'s path handling
 * (single string or array of segments, leading `/api/2.0` stripped)
 * so callers can construct request URLs that match what `fetchApi`
 * would have used. Resolves the host from the supplied
 * `WorkspaceClient` or, when omitted, from the active
 * `getExecutionContext().client`.
 */
export async function apiUrl(
  path: string[] | string,
  workspaceClient?: WorkspaceClient,
): Promise<URL> {
  let joinedPath = joinUrl(path);
  if (joinedPath === API_PREFIX || joinedPath.startsWith(API_PREFIX + "/")) {
    joinedPath = joinedPath.slice(API_PREFIX.length);
  }
  if (!joinedPath) {
    throw new Error(`Invalid path: ${path}`);
  }
  const client = workspaceClient ?? getExecutionContext().client;
  const config = client.config;
  const host = await config.getHost();
  const url = parseUrl(host, API_PREFIX, joinedPath)!;
  return url;
}

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
 * `cache` is an optional handle to `CacheManager.getOrExecute`: pass
 * `{ options: { ttl: 300 } }` for a per-user, time-boxed cache; the
 * `userId` from the active execution context becomes part of the
 * cache key by default.
 *
 * `workspaceClient` is optional; when omitted the request uses the
 * caller's `getExecutionContext().client` (i.e. the per-request
 * OBO client). Pass an explicit client for service-account work
 * outside a request.
 *
 * @example
 * await fetchApi("/serving-endpoints");
 *
 * await fetchApi(["/serving-endpoints", endpointName, "invocations"], {
 *   body: JSON.stringify({ inputs: [...] }),
 *   headers: { "Content-Type": "application/json" },
 * });
 *
 * await fetchApi("/serving-endpoints", undefined,
 *   { options: { ttl: 300 } }
 * );
 */
export async function fetchApi<T>(
  target: URL | string[] | string,
  init?: ApiRequestInit,
): Promise<T> {
  const client = init?.workspaceClient ?? getExecutionContext().client;
  const config = client.config;
  const url = target instanceof URL ? target : await apiUrl(target, client);
  if (init?.cache) {
    const { cache, ...executeInit } = init;
    const executionContext = getExecutionContext();
    const userId =
      "userId" in executionContext
        ? executionContext.userId
        : executionContext.serviceUserId;
    const cacheInstance = await CacheManager.getInstance();

    return cacheInstance.getOrExecute(
      cache.key ?? ["fetchApi", userId],
      async () => {
        return fetchApi(url, { ...executeInit, workspaceClient: client });
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

export type ContextLike = Context | AbortSignal;

/** Wrap a `Context` (returned as-is) or `AbortSignal` (adapted) as an SDK `Context`. */
export function toContext(input: ContextLike): Context;
/**
 * Derive an SDK `Context` from `controller.signal`, optionally tying
 * `input` into the controller so the controller becomes the single
 * cancellation source for downstream SDK calls:
 *
 *   - `AbortSignal`: aborting it propagates into `controller` (and from
 *     there into every SDK call you pass the returned context to).
 *   - `Context`: its `cancellationToken` is tied into `controller`, and
 *     its other fields (`logger`, `opName`, `rootClassName`,
 *     `rootFnName`, `opId`) are preserved in the returned `Context`.
 *     The returned context's `cancellationToken` is replaced with one
 *     backed by `controller.signal`.
 *
 * The tie is one-way (parent -> child): aborting `controller`
 * directly does NOT cancel `input`. So a request-level cancel (your
 * loop's `try/finally { controller.abort() }`) won't tear down a
 * caller-supplied AbortSignal it didn't own.
 */
export function toContext(controller: AbortController, input?: ContextLike): Context;
export function toContext(
  source: AbortController | ContextLike,
  input?: ContextLike,
): Context {
  if (!(source instanceof AbortController)) {
    if (source instanceof Context) return source;
    return new Context({ cancellationToken: signalToCancellationToken(source) });
  }
  if (input instanceof AbortSignal) {
    tieAbortSignal(source, input);
  } else if (input instanceof Context) {
    const token = input.cancellationToken;
    if (token) tieCancellationToken(source, token);
    const merged = input.copy();
    merged.setItems({ cancellationToken: signalToCancellationToken(source.signal) });
    return merged;
  }
  return new Context({ cancellationToken: signalToCancellationToken(source.signal) });
}

/**
 * Adapt a WHATWG `AbortSignal` to the Databricks SDK's
 * `CancellationToken` interface. The SDK's `api-client.ts`
 * internally creates an `AbortController` and wires
 * `cancellationToken.onCancellationRequested` to it, so this
 * adapter is the one-line bridge from "platform-standard
 * cancellation" to "the SDK aborts the fetch on your behalf".
 *
 * Kept private for now: the genie package is the only consumer in
 * the workspace. Lift to `@dbx-tools/shared` (`apiUtils`) the
 * moment a second package needs SDK-call cancellation.
 */
function signalToCancellationToken(signal: AbortSignal): CancellationToken {
  return {
    get isCancellationRequested() {
      return signal.aborted;
    },
    onCancellationRequested(cb) {
      if (signal.aborted) {
        cb(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => cb(signal.reason), { once: true });
    },
  };
}

/**
 * Tie the SDK's `CancellationToken` interface back into an
 * `AbortController`. Mirrors {@link tieAbortSignal} but for the
 * SDK's cancellation shape, used when a caller hands us a
 * pre-built `Context` whose token we want to fold into our own
 * controller.
 */
function tieCancellationToken(
  controller: AbortController,
  token: CancellationToken,
): void {
  if (token.isCancellationRequested) {
    controller.abort();
    return;
  }
  token.onCancellationRequested((reason) => controller.abort(reason));
}
