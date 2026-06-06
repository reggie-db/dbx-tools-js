/**
 * Browser-safe networking helpers: URL parsing and path joining that
 * gracefully handle partial inputs. No node-only imports, so this
 * module is the canonical home for anything URL-shaped that also has
 * to run in a Vite / Webpack / esbuild client bundle.
 *
 * Public API: {@link joinUrl}, {@link parseUrl}. The
 * single-leading/trailing-slash stripper `stripBoundarySlashes` is
 * private to this module.
 *
 * The server-side `./net.ts` re-exports everything here verbatim and
 * tacks on its own node-only helpers (e.g. `getRandomPort`), so the
 * `netUtils` namespace looks identical from both entry points.
 */

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/**
 * One input to {@link joinUrl}: a string, a (recursively nested)
 * array of segments, or `null` / `undefined` (skipped).
 *
 * The recursive shape lets callers compose path fragments without
 * pre-flattening: `joinUrl("a", ["b", ["c", "d"]])` is valid.
 *
 * The array variant uses an interface (rather than a self-referential
 * type alias) because Bun's TS parser bails on `type X = ... | X[] | ...`
 * but accepts the equivalent `interface XArr extends Array<X>`.
 */
export type UrlSegmentLike = string | UrlSegmentArray | null | undefined;
export interface UrlSegmentArray extends ReadonlyArray<UrlSegmentLike> {}

/**
 * Anything {@link parseUrl} knows how to coerce into a `URL`:
 *
 * - A WHATWG `URL` instance: returned as-is when no extra path is
 *   supplied; otherwise re-parsed with the path appended.
 * - A string: parsed by the `URL` constructor; `https://` is
 *   auto-prefixed when no scheme is present, so bare hostnames like
 *   `"example.com"` round-trip into a usable URL.
 * - Any object with a `url` field of the above shapes (e.g. a fetch
 *   `Request`, a Databricks `WorkspaceClient` config, etc.).
 */
export type UrlLike = URL | string | { url: string };

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
 * joinUrl("a", "b");                    // "/a/b"
 * joinUrl("/api/", "/v2/", "x");        // "/api/v2/x"
 * joinUrl(["a", "b"], "c");             // "/a/b/c"
 * joinUrl("https://ex.com", "/api/x");  // "https://ex.com/api/x"
 * joinUrl(null, "", "x", undefined);    // "/x"
 * joinUrl();                            // ""
 * joinUrl(null);                        // ""
 */
export function joinUrl(...urlSegments: UrlSegmentLike[]): string {
  const parts: string[] = [];
  for (const segment of urlSegments) {
    if (segment == null) continue;
    if (Array.isArray(segment)) {
      // Recurse, then strip the inner result's leading `/` so the
      // outer path-absolute prepend doesn't double up to `//a/b/c`.
      const inner = joinUrl(...segment);
      if (inner) parts.push(stripBoundarySlashes(inner));
      continue;
    }
    // `Array.isArray` narrows away the UrlSegmentArray branch but
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
 * Coerce a {@link UrlLike} input into a parsed `URL`, returning `null`
 * for anything that cannot be coerced (null/undefined, empty string,
 * malformed URL, an object whose `url` field doesn't parse).
 *
 * Mirrors WHATWG `URL.parse(...)` semantics: parse on success, `null`
 * on failure - never throws.
 *
 * Bare hostnames are upgraded to `https://` before parsing, so callers
 * can hand in user-provided values like `"workspace.cloud.databricks.com"`
 * without an explicit scheme.
 *
 * Optional trailing `path` arguments are appended via {@link joinUrl}.
 * When `input` is nullish (or just `"/"` / blank) but a `path` is
 * provided, the URL is built against `http://localhost`, which is
 * convenient for tests and for callers that resolve the host later.
 *
 * @example
 * parseUrl("example.com");                        // URL { https://example.com/ }
 * parseUrl("http://example.com/path");            // URL { http://example.com/path }
 * parseUrl({ url: "https://api.example" });       // URL { https://api.example/ }
 * parseUrl("example.com", "/api", "v2", "items"); // URL { https://example.com/api/v2/items }
 * parseUrl("example.com", ["api", "v2"]);         // URL { https://example.com/api/v2 }
 * parseUrl(null, "/api/x");                       // URL { http://localhost/api/x }
 * parseUrl("");                                   // null
 * parseUrl(null);                                 // null
 */
export function parseUrl(
  input: UrlLike | null | undefined,
  ...path: UrlSegmentLike[]
): URL | null {
  if (typeof input === "string") {
    input = input.trim();
    const match = input.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/i);
    const rest = match?.[2] ?? input;
    if (!rest || rest === "/") return parseUrl(null, ...path);
    const scheme = match?.[1];
    if (!scheme) input = `https://${input}`;
  }
  const joinedPath = joinUrl(...path);
  if (input == null) {
    if (joinedPath) return parseUrl("http://localhost", joinedPath);
    return null;
  }
  if (input instanceof URL) {
    if (joinedPath) return parseUrl(input.toString(), joinedPath);
    return input;
  }
  if (typeof input === "string") {
    const candidate = joinUrl(input, joinedPath);
    if (candidate) {
      try {
        return new URL(candidate);
      } catch {
        // Fall through to `null`.
      }
    }
    return null;
  }
  return parseUrl(input.url, joinedPath);
}

// ────────────────────────────────────────────────────────────────
// Private helpers
// ────────────────────────────────────────────────────────────────

/** Strip a single leading `/` and a single trailing `/`, if present. */
function stripBoundarySlashes(s: string): string {
  let out = s;
  if (out.startsWith("/")) out = out.slice(1);
  if (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}
