/**
 * Browser-safe networking helpers built around {@link urlBuilder}: a
 * tolerant `URL` coercion + chainable builder that gracefully handles
 * partial inputs (bare hosts, path-only strings, `{ url }` wrappers).
 * No node-only imports, so this module is the canonical home for
 * anything URL-shaped that also has to run in a Vite / Webpack /
 * esbuild client bundle.
 *
 * The server-side `./net.ts` re-exports everything here verbatim and
 * tacks on its own node-only helpers, so the `netUtils` namespace
 * looks identical from both entry points.
 */

import type { NonFunctionKeys } from "./common.js";

const LOCAL_HOST_URL = new URL("http://localhost");
const URL_SCHEME_DEFAULT = "https";
const URL_SCHEME_PREFIX = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)/;
const URL_PATH_SEGMENT_TRIM = /^\/+|\/+$/g;
const URL_SCHEME_SEPARATOR = "://";

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/**
 * Anything {@link urlBuilder} (and {@link pathMatch}) know how to coerce
 * into a URL:
 *
 * - A string: a host, a full URL, or a path / query / hash fragment.
 * - A WHATWG `URL` instance.
 * - Any object with a `url` field (e.g. a fetch `Request`, a Databricks
 *   `WorkspaceClient` config).
 */
export type UrlLike = string | URL | { url: string };

/** Settable, non-method `URL` properties - the keys {@link UrlBuilder.with} accepts. */
type UrlPropertyKey = NonFunctionKeys<UrlBuilderImpl>;

/**
 * A `URL` subclass with chainable, copy-on-write helpers. Every mutating
 * method returns a fresh builder rather than editing in place, so a base
 * builder can be safely reused. Construct one via {@link urlBuilder}.
 */
class UrlBuilderImpl extends URL {
  constructor(url: URL) {
    super(url);
  }

  /** The scheme without the trailing colon (`https`, not `https:`). */
  get scheme(): string {
    return this.protocol.slice(0, -1);
  }

  set scheme(value: string) {
    this.protocol = value + ":";
  }

  /**
   * Return a copy with a single `URL` property (`pathname`, `search`,
   * `hostname`, `scheme`, ...) set to `value`, leaving this builder
   * untouched.
   */
  with<K extends UrlPropertyKey>(key: K, value: UrlBuilderImpl[K]): UrlBuilder {
    const next = new UrlBuilderImpl(this);
    (next as any)[key] = value;
    return new UrlBuilderImpl(next);
  }

  /**
   * Return a copy with `pathSegments` appended to the current pathname.
   * Segments may be strings or string arrays; each is trimmed of
   * boundary slashes and blanks are dropped before joining with `/`.
   */
  withPathAppend(...pathSegments: (string | string[])[]): UrlBuilder {
    return this.withPathReplace(this.pathname, ...pathSegments);
  }

  /**
   * Return a copy whose pathname is `pathSegments` joined with `/`,
   * replacing any existing path. Segments may be strings or string
   * arrays; each is trimmed of boundary slashes and blanks are dropped.
   */
  withPathReplace(...pathSegments: (string | string[])[]): UrlBuilder {
    const pathnameParts: string[] = [...pathSegments].flatMap((p) =>
      Array.isArray(p) ? p : [p],
    );
    const pathname = pathnameParts
      .map((p) => p.replace(URL_PATH_SEGMENT_TRIM, ""))
      .filter(Boolean)
      .join("/");
    return this.with("pathname", "/" + pathname);
  }

  /**
   * Test whether this URL's pathname is `path` or lives beneath it,
   * matching on segment boundaries so `/api` matches `/api` and
   * `/api/cool` but not `/apicool`. A missing leading slash on `path`
   * is tolerated; query and hash are ignored (they aren't part of
   * `pathname`). Matching is exact otherwise - trailing slashes are
   * not normalized and `/` matches only the root.
   */
  pathMatches(path: string): boolean {
    const pathname = this.pathname;
    if (pathname == path) return true;
    if (!path.startsWith("/")) path = "/" + path;
    if (pathname == path) return true;
    return pathname.startsWith(path + "/");
  }
}

/** Public type for the {@link urlBuilder} return value. */
export type UrlBuilder = UrlBuilderImpl;

/** With no argument, resolves to the base origin (never `null`). */
export function urlBuilder(): UrlBuilder;

/**
 * Coerce a {@link UrlLike} into a chainable {@link UrlBuilder}, or `null`
 * when the input cannot be parsed into a URL. Never throws.
 *
 * - A `URL` instance or `{ url }` wrapper is adopted as-is.
 * - A bare hostname (`"example.com"`) is upgraded to `https://`; an
 *   explicit scheme is preserved.
 * - A path / query / hash fragment (`"/api"`, `"?q=1"`, `"#x"`) is
 *   resolved against {@link defaultUrl} (the browser origin, else
 *   `http://localhost`).
 * - An empty / blank string or omitted input resolves to the base
 *   origin.
 *
 * @example
 * urlBuilder("example.com");          // https://example.com/
 * urlBuilder("http://x/path");        // http://x/path
 * urlBuilder("/api/v2");              // http://localhost/api/v2
 * urlBuilder({ url: "http://y" });    // http://y/
 * urlBuilder();                       // http://localhost/
 */
export function urlBuilder(input?: UrlLike): UrlBuilder | null;

export function urlBuilder(input?: UrlLike): UrlBuilder | null {
  if (input instanceof URL) {
    return new UrlBuilderImpl(input);
  }
  if (input !== null && typeof input === "object" && "url" in input) {
    input = input.url;
  }
  if (typeof input === "string") {
    input = input.trim();
  }
  if (input) {
    if (input.startsWith("/") || input.startsWith("?") || input.startsWith("#")) {
      const joinedUrl = defaultUrl().toString().slice(0, -1) + input;
      return urlBuilder(joinedUrl);
    } else if (input.startsWith(URL_SCHEME_SEPARATOR)) {
      input = `${URL_SCHEME_DEFAULT}${input}`;
    } else {
      const match = input.match(URL_SCHEME_PREFIX);
      const schemePrefix = match?.[1];
      if (schemePrefix) {
        const rest = input.slice(schemePrefix.length);
        input = `${schemePrefix}${rest || defaultUrl().hostname}`;
      } else {
        input = `${URL_SCHEME_DEFAULT}://${input}`;
      }
    }
  } else {
    return urlBuilder(defaultUrl());
  }
  const url = parseUrl(input);
  return url ? urlBuilder(url) : null;
}

/**
 * Convenience wrapper over {@link UrlBuilder.pathMatches}: coerce
 * `input` via {@link urlBuilder} and test its pathname against `path`.
 * Returns `false` for input that can't be parsed into a URL.
 *
 * @example
 * pathMatch("/api/cool?q=1", "/api");      // true
 * pathMatch("/apicool", "/api");           // false
 * pathMatch("https://host/api", "/api");   // true
 * pathMatch(request, "/api/v2");           // fetch Request
 */
export function pathMatch(input: UrlLike, path: string): boolean {
  const urlb = urlBuilder(input);
  if (!urlb) return false;
  return urlb.pathMatches(path);
}

/**
 * Base origin for resolving path-only inputs. In a browser this is the
 * current page's origin (`window.location.origin`), so `urlBuilder("/api")`
 * reflects where the app is actually served from; on the server / in
 * tests (no `window`, or an opaque `"null"` origin) it falls back to
 * `http://localhost`.
 */
function defaultUrl(): URL {
  // Reach `window` via `globalThis` so this compiles without the DOM
  // lib (it's `undefined` on the server / in workers without one).
  const origin = (globalThis as { window?: { location?: { origin?: string } } }).window
    ?.location?.origin;
  if (origin && origin !== "null") {
    const originUrl = parseUrl(origin);
    if (originUrl) {
      return originUrl;
    }
  }
  return new URL(LOCAL_HOST_URL);
}

function parseUrl(input: string): URL | null {
  if (input && input.includes(URL_SCHEME_SEPARATOR)) {
    try {
      return new URL(input);
    } catch {}
  }
  return null;
}
