/**
 * HTTP-shaped helpers shared across AppKit plugins: URL parsing that
 * gracefully handles partial inputs, plus framework-agnostic readers
 * for HTTP headers and cookies that work uniformly across Express,
 * Node `IncomingMessage`, WHATWG `Request`/`Response`/`Headers`, Hono,
 * and any object that exposes a `headers` field of one of those shapes.
 *
 * Public API: {@link toURL}, {@link forEachHeaderValue}, {@link parseCookies}.
 * The header guards (`isHeaders` / `isWrapped` / `unwrap`) and the
 * single-cookie-header parser (`parseCookieString`) are private to
 * this module by virtue of not being `export`ed.
 */

/**
 * Anything `toURL` knows how to coerce into a `URL`:
 *
 * - A WHATWG `URL` instance: returned as-is.
 * - A string: parsed by the `URL` constructor; a scheme of `https://`
 *   is auto-prefixed when none is present, so bare hostnames
 *   (`"example.com"`) round-trip into a usable URL.
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

/**
 * Coerce a {@link URLLike} input into a parsed `URL`, returning `null`
 * for anything that cannot be coerced (null/undefined, empty string,
 * malformed URL, an object whose `url` field doesn't parse).
 *
 * Bare hostnames are upgraded to `https://` before parsing, so callers
 * can hand in user-provided values like `"workspace.cloud.databricks.com"`
 * without an explicit scheme.
 *
 * @example
 * ```ts
 * toURL("example.com");                 // URL { https://example.com/ }
 * toURL("http://example.com/path");     // URL { http://example.com/path }
 * toURL({ url: "https://api.example" }); // URL { https://api.example/ }
 * toURL("");                            // null
 * toURL(null);                          // null
 * ```
 */
export function toURL(input: URLLike | null | undefined): URL | null {
  if (input == null) return null;
  if (input instanceof URL) return input;
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return null;
    // Auto-prefix `https://` when the scheme is missing so callers can
    // hand in bare hostnames without a special-case at every call site.
    const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
    try {
      return new URL(candidate);
    } catch {
      return null;
    }
  }
  return toURL(input.url);
}

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
 * ```ts
 * forEachHeaderValue(req, "x-trace-id", (v) => spans.push(v));     // Express
 * forEachHeaderValue(c.req.raw, "set-cookie", (v) => log(v));      // Hono
 * forEachHeaderValue(headersInstance, "cookie", parse);            // fetch
 * ```
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
 * ```ts
 * parseCookies("session=abc; theme=dark");
 * // { session: "abc", theme: "dark" }
 *
 * parseCookies(req);              // Express / Node
 * parseCookies(c.req.raw);        // Hono
 * parseCookies(request);          // fetch Request
 * parseCookies(request.headers);  // WHATWG Headers directly
 * ```
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
