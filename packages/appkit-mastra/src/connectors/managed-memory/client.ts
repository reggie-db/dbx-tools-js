/**
 * Thin REST client over the Databricks Unity Catalog Managed Agent
 * Memory API (Beta). There is no TS SDK for memory-stores yet, so this
 * mirrors the auth pattern `model.ts` uses for raw serving calls: pull
 * the workspace host and a fresh bearer header off the OBO-scoped
 * `WorkspaceClient` (`client.config.getHost()` + `authenticate()`), then
 * issue a plain `fetch`. All calls run as whatever identity the caller's
 * client carries - the per-request OBO user for tools / recall, the
 * service principal for setup-time probes.
 *
 * Responses are parsed defensively: the Beta wire shape may still drift,
 * so the search parser tolerates missing / renamed entry fields and the
 * store probe maps a 404 to `null` rather than throwing.
 */

import type { appkitUtils } from "@dbx-tools/shared";

import type { MemoryEntry } from "./types.js";

/** Base path for the Unity Catalog memory-stores REST surface. */
const MEMORY_STORES_PATH = "/api/2.1/unity-catalog/memory-stores";

/** Workspace client carried on an AppKit execution context. */
type WorkspaceClient = appkitUtils.WorkspaceClientLike;

/** Parsed three-level Unity Catalog name. */
interface StoreName {
  catalog: string;
  schema: string;
  name: string;
}

/**
 * Error thrown for a non-2xx memory-store response. Carries the HTTP
 * status so callers can distinguish "feature unavailable / store
 * missing" (probe falls back) from genuine failures.
 */
export class ManagedMemoryError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    body: string,
  ) {
    super(`managed-memory: ${status} ${statusText}${body ? ` - ${body}` : ""}`);
    this.name = "ManagedMemoryError";
  }
}

/**
 * Split a three-level `catalog.schema.name` into its parts. Throws when
 * the input isn't exactly three dot-separated, non-empty segments so a
 * misconfigured `MEMORY_STORE` fails loudly at setup rather than
 * silently hitting a malformed URL.
 */
export function parseStoreName(fullName: string): StoreName {
  const parts = fullName.split(".");
  if (parts.length !== 3 || parts.some((p) => p.trim() === "")) {
    throw new Error(
      `managed-memory: store name must be three-level "catalog.schema.name", got "${fullName}"`,
    );
  }
  const [catalog, schema, name] = parts as [string, string, string];
  return { catalog, schema, name };
}

/**
 * Resolve the workspace host and an authenticated header set off the
 * client, then issue a `fetch`. Returns the raw `Response` so callers
 * decide how to handle status codes (the store probe wants the 404, the
 * mutating calls want a throw).
 */
async function rawFetch(
  client: WorkspaceClient,
  path: string,
  init: { method: string; body?: unknown; signal?: AbortSignal },
): Promise<Response> {
  const host = (await client.config.getHost()).toString();
  const headers = new Headers({ "Content-Type": "application/json" });
  await client.config.authenticate(headers);
  const url = new URL(path, host).toString();
  return fetch(url, {
    method: init.method,
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  });
}

/**
 * Issue a request and parse the JSON body, throwing
 * {@link ManagedMemoryError} on any non-2xx status. Used by the calls
 * where anything but success is a real error (create / write / search).
 */
async function requestJson(
  client: WorkspaceClient,
  path: string,
  init: { method: string; body?: unknown; signal?: AbortSignal },
): Promise<unknown> {
  const res = await rawFetch(client, path, init);
  if (!res.ok) {
    throw new ManagedMemoryError(res.status, res.statusText, await safeText(res));
  }
  return safeJson(res);
}

/**
 * Fetch a store by full name. Returns the raw store payload when it
 * exists, or `null` on 404 so callers can treat "missing" as a normal
 * condition (the capability probe and `ensureStore` both rely on this).
 * Any other non-2xx status throws.
 */
export async function getStore(
  client: WorkspaceClient,
  fullName: string,
  signal?: AbortSignal,
): Promise<unknown | null> {
  const res = await rawFetch(client, `${MEMORY_STORES_PATH}/${fullName}`, {
    method: "GET",
    ...(signal ? { signal } : {}),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new ManagedMemoryError(res.status, res.statusText, await safeText(res));
  }
  return safeJson(res);
}

/**
 * Probe for the store and create it when missing. Returns `true` when
 * the store exists (found or created). The create body splits the
 * three-level name into the catalog / schema / name fields the API
 * expects. A `getStore` 404 followed by a successful create is the
 * common first-run path.
 */
export async function ensureStore(
  client: WorkspaceClient,
  fullName: string,
  description: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const existing = await getStore(client, fullName, signal);
  if (existing !== null) return true;
  const { catalog, schema, name } = parseStoreName(fullName);
  await requestJson(client, MEMORY_STORES_PATH, {
    method: "POST",
    body: {
      name,
      catalog_name: catalog,
      schema_name: schema,
      description,
    },
    ...(signal ? { signal } : {}),
  });
  return true;
}

/**
 * Write (upsert) an entry into the store under `scope`. Scope is the
 * OBO user id resolved in trusted code; it travels as a query parameter
 * so the API isolates one user's memories from another's.
 */
export async function writeEntry(
  client: WorkspaceClient,
  fullName: string,
  scope: string,
  entry: { path: string; contents: string; description?: string },
  signal?: AbortSignal,
): Promise<void> {
  const path = `${MEMORY_STORES_PATH}/${fullName}/entries?scope=${encodeURIComponent(scope)}`;
  await requestJson(client, path, {
    method: "POST",
    body: {
      path: entry.path,
      contents: entry.contents,
      ...(entry.description ? { description: entry.description } : {}),
    },
    ...(signal ? { signal } : {}),
  });
}

/**
 * Semantic search over a user's entries within `scope`. Returns up to
 * `topK` entries, parsed defensively so a renamed / missing Beta field
 * degrades to an empty list rather than crashing the turn.
 */
export async function search(
  client: WorkspaceClient,
  fullName: string,
  scope: string,
  query: string,
  topK: number,
  signal?: AbortSignal,
): Promise<MemoryEntry[]> {
  const path = `${MEMORY_STORES_PATH}/${fullName}/entries:search?scope=${encodeURIComponent(scope)}`;
  const body = await requestJson(client, path, {
    method: "POST",
    body: { query, top_k: topK },
    ...(signal ? { signal } : {}),
  });
  return parseEntries(body).slice(0, topK);
}

/**
 * Defensively pull a `MemoryEntry[]` out of a search response. Accepts
 * the documented `{ entries: [...] }` envelope plus a bare array, and
 * tolerates snake_case / camelCase field drift. Entries without any
 * textual content are dropped.
 */
function parseEntries(body: unknown): MemoryEntry[] {
  const list = Array.isArray(body)
    ? body
    : Array.isArray((body as { entries?: unknown })?.entries)
      ? (body as { entries: unknown[] }).entries
      : Array.isArray((body as { results?: unknown })?.results)
        ? (body as { results: unknown[] }).results
        : [];
  const out: MemoryEntry[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    const contents = firstString(obj["contents"], obj["content"], obj["text"]);
    if (!contents) continue;
    const path = firstString(obj["path"]);
    const description = firstString(obj["description"], obj["summary"]);
    const score =
      typeof obj["score"] === "number" ? (obj["score"] as number) : undefined;
    out.push({
      contents,
      ...(path ? { path } : {}),
      ...(description ? { description } : {}),
      ...(score !== undefined ? { score } : {}),
    });
  }
  return out;
}

/** Return the first argument that is a non-empty string, else undefined. */
function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return undefined;
}

/** Parse a response body as JSON, returning `{}` on empty / invalid bodies. */
async function safeJson(res: Response): Promise<unknown> {
  const text = await safeText(res);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** Read a response body as text, swallowing read errors. */
async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
