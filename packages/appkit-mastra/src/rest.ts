/**
 * Minimal authenticated Databricks REST helper. Pulls the workspace
 * host and a fresh bearer header off an OBO-scoped `WorkspaceClient`
 * (`client.config.getHost()` + `authenticate()`), then issues a plain
 * `fetch`. Used by modules that hit REST surfaces without a typed SDK
 * method (e.g. the MLflow assessments API and the managed-memory Beta
 * API); returns the raw `Response` so callers decide how to treat
 * status codes. Also carries the defensive `Response` body readers those
 * callers share.
 */

import type { appkitUtils } from "@dbx-tools/shared";

/** Workspace client carried on an AppKit execution context. */
type WorkspaceClient = appkitUtils.WorkspaceClientLike;

/** Request options for {@link databricksFetch}. */
export interface DatabricksFetchInit {
  method: string;
  /** JSON-serialized as the request body when present. */
  body?: unknown;
  /** Extra headers merged over the default `Content-Type: application/json`. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * Resolve the workspace host + an authenticated header set off the
 * client and issue a `fetch` against `path` (mounted on the host).
 * Runs as whatever identity the client carries - the per-request OBO
 * user when called from a request scope, the service principal
 * otherwise.
 */
export async function databricksFetch(
  client: WorkspaceClient,
  path: string,
  init: DatabricksFetchInit,
): Promise<Response> {
  const host = (await client.config.getHost()).toString();
  const headers = new Headers({ "Content-Type": "application/json", ...init.headers });
  await client.config.authenticate(headers);
  const url = new URL(path, host).toString();
  return fetch(url, {
    method: init.method,
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  });
}

/** Read a response body as text, swallowing read errors (returns `""`). */
export async function readResponseText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/** Parse a response body as JSON, returning `{}` on empty / invalid bodies. */
export async function readResponseJson(res: Response): Promise<unknown> {
  const text = await readResponseText(res);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
