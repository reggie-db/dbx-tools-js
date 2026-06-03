/**
 * HTTP-shaped helpers shared across AppKit plugins: URL parsing and
 * path joining that gracefully handle partial inputs, plus framework
 * agnostic readers for HTTP headers and cookies that work uniformly
 * across Express, Node `IncomingMessage`, WHATWG `Request` / `Response`
 * / `Headers`, Hono, and any object that exposes a `headers` field of
 * one of those shapes.
 *
 * Public API: {@link joinUrlSegments}, {@link toURL},
 * {@link forEachHeaderValue}, {@link parseCookies}. Everything else
 * (the header guards `isHeaders` / `isWrapped` / `unwrap`, the single
 * cookie-header parser `parseCookieString`, the slash-stripper
 * `stripBoundarySlashes`) is private to this module.
 *
 * The Databricks-aware REST helper that used to live here moved to
 * `apiUtils.fetchApi` (`./api.ts`) so this module can stay
 * dependency-free and browser-safe.
 */

import type { WorkspaceClient } from "@databricks/sdk-experimental";

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/**
 * One input to {@link joinUrlSegments}: a string, a (recursively
 * nested) array of segments, or `null` / `undefined` (skipped).
 *
 * The recursive shape lets callers compose path fragments without
 * pre-flattening: `joinUrlSegments("a", ["b", ["c", "d"]])` is valid.
 *
 * The array variant uses an interface (rather than a self-referential
 * type alias) because Bun's TS parser bails on `type X = ... | X[] | ...`
 * but accepts the equivalent `interface XArr extends Array<X>`.
 */
export type URLSegmentLike = string | URLSegmentArray | null | undefined;
export interface URLSegmentArray extends ReadonlyArray<URLSegmentLike> {}

/**
 * Anything {@link toURL} knows how to coerce into a `URL`:
 *
 * - A WHATWG `URL` instance: returned as-is when no extra path is
 *   supplied; otherwise re-parsed with the path appended.
 * - A string: parsed by the `URL` constructor; `https://` is
 *   auto-prefixed when no scheme is present, so bare hostnames like
 *   `"example.com"` round-trip into a usable URL.
 * - Any object with a `url` field of the above shapes (e.g. a fetch
 *   `Request`, a Databricks `WorkspaceClient` config, etc.).
 */
export type URLLike = URL | string | { url: string };

/**
 * Anything that contains HTTP headers. Accepts:
 *
 * - A WHATWG `Headers` instance (fetch / undici / Hono `c.req.raw.headers`).
 * - A header record (`Record<string, string | string[] | undefined>`),
 *   Node / Express style.
 * - Any object with a `headers` field of one of the above. This covers
 *   Express `req`, Node `IncomingMessage`, WHATWG `Request` / `Response`,
 *   Hono `c.req.raw`, and similar shapes.
 */
export type HeaderLike = Headers | HeaderRecord | { headers: Headers | HeaderRecord };

/**
 * Single header value as exposed by Node `IncomingMessage.headers` and
 * Express `req.headers` (string for most headers, array for repeated
 * headers such as `Set-Cookie`).
 */
type HeaderValueLike = string[] | string | undefined;

/** Header bag with case-insensitive keys (Node / Express style). */
type HeaderRecord = Record<string, HeaderValueLike>;

// ────────────────────────────────────────────────────────────────
// URL helpers
// ────────────────────────────────────────────────────────────────

/**
 * Join URL path segments with `/`, with three pragmatic conveniences
 * for building URLs piecemeal:
 *
 *   1. Nullish or blank segments are dropped, so callers don't have
 *      to guard around optional path components.
 *   2. Each string segment has any leading or trailing `/` stripped
 *      before joining, so `"/api"` + `"v2/"` round-trips to `/api/v2`
 *      regardless of how the caller terminated each part.
 *   3. Array segments recurse, with their joined form inlined into
 *      the outer result.
 *
 * The result is prefixed with `/` to make it path-absolute, except
 * when any segment carries an explicit `://` scheme (e.g.
 * `"https://x.com"`), in which case the scheme is preserved verbatim.
 *
 * Returns `""` when every input was nullish or blank.
 *
 * @example
 * joinUrlSegments("a", "b");                    // "/a/b"
 * joinUrlSegments("/api/", "/v2/", "x");        // "/api/v2/x"
 * joinUrlSegments(["a", "b"], "c");             // "/a/b/c"
 * joinUrlSegments("https://ex.com", "/api/x");  // "https://ex.com/api/x"
 * joinUrlSegments(null, "", "x", undefined);    // "/x"
 * joinUrlSegments();                            // ""
 * joinUrlSegments(null);                        // ""
 */
export function joinUrlSegments(...urlSegments: URLSegmentLike[]): string {
  const parts: string[] = [];
  for (const segment of urlSegments) {
    if (segment == null) continue;
    if (Array.isArray(segment)) {
      // Recurse, then strip the inner result's leading `/` so the
      // outer path-absolute prepend doesn't double up to `//a/b/c`.
      const inner = joinUrlSegments(...segment);
      if (inner) parts.push(stripBoundarySlashes(inner));
      continue;
    }
    // `Array.isArray` narrows away the URLSegmentArray branch but
    // leaves TS believing `segment` could still be a `string` only,
    // which it now is - the type cast is just to silence a known
    // TS limitation around recursive interface narrowing.
    const trimmed = (segment as string).trim();
    if (!trimmed) continue;
    parts.push(stripBoundarySlashes(trimmed));
  }
  const joined = parts.filter(Boolean).join("/");
  if (!joined) return "";
  return joined.includes("://") ? joined : "/" + joined;
}

/**
 * Coerce a {@link URLLike} input into a parsed `URL`, returning `null`
 * for anything that cannot be coerced (null/undefined, empty string,
 * malformed URL, an object whose `url` field doesn't parse).
 *
 * Bare hostnames are upgraded to `https://` before parsing, so callers
 * can hand in user-provided values like `"workspace.cloud.databricks.com"`
 * without an explicit scheme.
 *
 * Optional trailing `path` arguments are appended via
 * {@link joinUrlSegments}. When `input` is nullish (or just `"/"` /
 * blank) but a `path` is provided, the URL is built against
 * `http://localhost`, which is convenient for tests and for callers
 * that resolve the host later.
 *
 * @example
 * toURL("example.com");                        // URL { https://example.com/ }
 * toURL("http://example.com/path");            // URL { http://example.com/path }
 * toURL({ url: "https://api.example" });       // URL { https://api.example/ }
 * toURL("example.com", "/api", "v2", "items"); // URL { https://example.com/api/v2/items }
 * toURL("example.com", ["api", "v2"]);         // URL { https://example.com/api/v2 }
 * toURL(null, "/api/x");                       // URL { http://localhost/api/x }
 * toURL("");                                   // null
 * toURL(null);                                 // null
 */
export function toURL(
  input: URLLike | null | undefined,
  ...path: URLSegmentLike[]
): URL | null {
  if (typeof input === "string") {
    input = input.trim();
    const match = input.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/i);
    const rest = match?.[2] ?? input;
    if (!rest || rest === "/") return toURL(null, ...path);
    const scheme = match?.[1];
    if (!scheme) input = `https://${input}`;
  }
  const joinedPath = joinUrlSegments(...path);
  if (input == null) {
    if (joinedPath) return toURL("http://localhost", joinedPath);
    return null;
  }
  if (input instanceof URL) {
    if (joinedPath) return toURL(input.toString(), joinedPath);
    return input;
  }
  if (typeof input === "string") {
    const candidate = joinUrlSegments(input, joinedPath);
    if (candidate) {
      try {
        return new URL(candidate);
      } catch {
        // Fall through to `null`.
      }
    }
    return null;
  }
  return toURL(input.url, joinedPath);
}

// ────────────────────────────────────────────────────────────────
// Header helpers
// ────────────────────────────────────────────────────────────────

/**
 * Invokes `consumer` once per value for `headerName`, case-insensitive.
 *
 * - **Record input:** if the field is an array (e.g. repeated `Set-Cookie`),
 *   `consumer` runs once per array item.
 * - **`Headers` input:** uses `get(name)` (which spec-joins repeats with
 *   `, `) except for `Set-Cookie`, which uses `getSetCookie()` so each
 *   cookie is delivered separately.
 *
 * @example
 * forEachHeaderValue(req, "x-trace-id", (v) => spans.push(v));     // Express
 * forEachHeaderValue(c.req.raw, "set-cookie", (v) => log(v));      // Hono
 * forEachHeaderValue(headersInstance, "cookie", parse);            // fetch
 */
export function forEachHeaderValue(
  input: HeaderLike | null | undefined,
  headerName: string,
  consumer: (value: string) => void,
): void {
  const headers = unwrap(input);
  if (!headers) return;

  const target = headerName.toLowerCase();

  if (isHeaders(headers)) {
    // `Headers.get` joins repeated values with `, ` per spec, which
    // mangles `Set-Cookie` (cookies legitimately contain commas in
    // their `expires=` attribute). `getSetCookie` is the dedicated
    // splitter and is the only safe path for that header.
    if (target === "set-cookie") {
      for (const value of headers.getSetCookie()) consumer(value);
      return;
    }
    const value = headers.get(headerName);
    if (value !== null) consumer(value);
    return;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (value == null || key.toLowerCase() !== target) continue;
    if (Array.isArray(value)) {
      for (const item of value) consumer(item);
    } else {
      consumer(value);
    }
  }
}

/**
 * Parses `Cookie` header values into a name-to-value map (URI-decoded).
 *
 * Accepts:
 *
 * - A raw `Cookie` string (`"a=1; b=2"`).
 * - An array of such strings (e.g. multiple `Cookie` headers).
 * - Any {@link HeaderLike}: a WHATWG `Headers` instance, a header
 *   record, or a request-like object with a `headers` field.
 *
 * First occurrence of each cookie name wins; later duplicates are ignored.
 *
 * @example
 * parseCookies("session=abc; theme=dark");
 * // { session: "abc", theme: "dark" }
 *
 * parseCookies(req);              // Express / Node
 * parseCookies(c.req.raw);        // Hono
 * parseCookies(request);          // fetch Request
 * parseCookies(request.headers);  // WHATWG Headers directly
 */
export function parseCookies(
  input: HeaderLike | HeaderValueLike | null,
): Record<string, string> {
  if (input == null) return {};
  const out: Record<string, string> = {};

  if (typeof input === "string") {
    parseCookieString(input, out);
    return out;
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") parseCookieString(item, out);
    }
    return out;
  }

  forEachHeaderValue(input, "cookie", (value) => {
    parseCookieString(value, out);
  });
  return out;
}

// ────────────────────────────────────────────────────────────────
// Private helpers
// ────────────────────────────────────────────────────────────────

/**
 * Type guard for WHATWG `Headers`. Duck-types on the two methods that
 * matter to this module (`get` and `getSetCookie`) so polyfilled
 * implementations and Hono's `HonoHeaders` are accepted without
 * pulling `Headers` in as a hard dependency.
 */
function isHeaders(value: unknown): value is Headers {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Headers).get === "function" &&
    typeof (value as Headers).getSetCookie === "function"
  );
}

/**
 * `HeaderRecord` is an index signature, so `"headers" in input` cannot
 * discriminate it from the wrapped `{ headers }` shape at the type
 * level. This guard inspects the runtime value of `headers`: only
 * objects (`Headers` or a nested record) qualify as the wrapper shape,
 * never stray string/array values that happen to live under a `headers`
 * key on a header record.
 */
function isWrapped(
  input: HeaderRecord | { headers: Headers | HeaderRecord },
): input is { headers: Headers | HeaderRecord } {
  const headers = (input as { headers?: unknown }).headers;
  return headers != null && typeof headers === "object" && !Array.isArray(headers);
}

/**
 * Parse a single `Cookie`-style header string (`"a=1; b=2"`) into
 * `out`. Names without a value are skipped; first occurrence wins so
 * later duplicates are ignored. Cookie values are URI-decoded.
 */
function parseCookieString(input: string, out: Record<string, string>): void {
  for (const part of input.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue;
    const raw = part.slice(eq + 1).trim();
    out[name] = decodeURIComponent(raw);
  }
}

/** Strip a single leading `/` and a single trailing `/`, if present. */
function stripBoundarySlashes(s: string): string {
  let out = s;
  if (out.startsWith("/")) out = out.slice(1);
  if (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/**
 * Normalize a {@link HeaderLike} input down to either a `Headers`
 * instance or a header `Record`. Returns `null` for missing input so
 * callers can short-circuit without a separate nullish check.
 */
function unwrap(input: HeaderLike | null | undefined): Headers | HeaderRecord | null {
  if (input == null) return null;
  if (isHeaders(input)) return input;
  if (isWrapped(input)) return input.headers;
  return input;
}
