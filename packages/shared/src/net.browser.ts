/**
 * Browser-safe networking helpers built around {@link urlBuilder}: a
 * tolerant `URL` coercion + chainable builder that gracefully handles
 * partial inputs (bare hosts, path-only strings, `{ url }` wrappers),
 * plus a small IPv4 / IPv6 address + CIDR toolkit (parsing and
 * membership lookups). No node-only imports, so this module is the
 * canonical home for anything URL- or IP-shaped that also has to run
 * in a Vite / Webpack / esbuild client bundle.
 *
 * The server-side `./net.ts` re-exports everything here verbatim and
 * tacks on its own node-only helpers (e.g. DNS resolution), so the
 * `netUtils` namespace looks identical from both entry points.
 */

import type { NonFunctionKeys } from "./common.js";

const LOCAL_HOST_URL = new URL("http://localhost");
const URL_SCHEME_DEFAULT = "https";
const URL_SCHEME_PREFIX = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)/;
const URL_PATH_SEGMENT_TRIM = /^\/+|\/+$/g;
const URL_SCHEME_SEPARATOR = "://";

/** Total bit width of an address of each {@link IpVersion}. */
const IP_BITS: Readonly<Record<IpVersion, number>> = { 4: 32, 6: 128 };
const IPV4_OCTET = /^\d{1,3}$/;
const IPV6_HEXTET = /^[0-9a-fA-F]{1,4}$/;

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

/** IP protocol family: `4` for IPv4, `6` for IPv6. */
export type IpVersion = 4 | 6;

/**
 * A parsed IP address. `value` is the address as an unsigned integer
 * (a 32-bit range for v4, 128-bit for v6) held in a `bigint` so both
 * families share one comparison / masking path. Produce one with
 * {@link parseIp}.
 */
export interface ParsedIp {
  version: IpVersion;
  /** The address as an unsigned integer (`bigint` for uniform v4/v6 math). */
  value: bigint;
}

/**
 * A parsed CIDR block (`10.0.0.0/8`, `2001:db8::/32`). `base` is the
 * network address with all host bits cleared, so membership is a
 * single masked compare (see {@link ipInCidr}). Produce one with
 * {@link parseCidr}. Carries the normalized `cidr` string for logging
 * and to key back to caller-side metadata.
 */
export interface Cidr {
  version: IpVersion;
  /** Network address (host bits zeroed) as an unsigned `bigint`. */
  base: bigint;
  /** Prefix length in bits (the number after the `/`). */
  prefix: number;
  /** Normalized `<address>/<prefix>` string. */
  cidr: string;
}

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

// ────────────────────────────────────────────────────────────────
// IP addresses and CIDR blocks
// ────────────────────────────────────────────────────────────────

/**
 * Parse an IPv4 (`"1.2.3.4"`) or IPv6 (`"2001:db8::1"`,
 * `"::ffff:1.2.3.4"`, `"::1"`) address into a {@link ParsedIp}, or
 * `null` when the input isn't a valid literal. Never throws. Surrounding
 * whitespace, `[...]` brackets around an IPv6 literal, and an IPv6 zone
 * id (`fe80::1%eth0`) are all tolerated. The `value` is returned as a
 * `bigint` so v4 and v6 share one comparison path.
 *
 * @example
 * parseIp("10.0.0.1");        // { version: 4, value: 167772161n }
 * parseIp("2001:db8::1");     // { version: 6, value: ... }
 * parseIp("not-an-ip");       // null
 */
export function parseIp(input: string): ParsedIp | null {
  let text = input.trim();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  if (text.includes(":")) {
    // Drop an IPv6 zone id (`fe80::1%eth0`) - it isn't part of the address.
    const zone = text.indexOf("%");
    if (zone >= 0) text = text.slice(0, zone);
    const value = parseIpv6(text);
    return value === null ? null : { version: 6, value };
  }
  const value = parseIpv4(text);
  return value === null ? null : { version: 4, value };
}

/**
 * Parse a CIDR block (`"10.0.0.0/8"`, `"2001:db8::/32"`) into a
 * {@link Cidr} with host bits cleared from `base`, or `null` when the
 * input isn't a valid block (bad address, missing / out-of-range
 * prefix). Never throws.
 *
 * @example
 * parseCidr("10.0.0.0/8")?.base;   // 167772160n (10.0.0.0)
 * parseCidr("10.1.2.3/8")?.base;   // 167772160n (host bits dropped)
 * parseCidr("10.0.0.0/40");        // null (prefix > 32 for v4)
 */
export function parseCidr(input: string): Cidr | null {
  const text = input.trim();
  const slash = text.lastIndexOf("/");
  if (slash < 0) return null;
  const prefixText = text.slice(slash + 1);
  if (!IPV4_OCTET.test(prefixText)) return null;
  const ip = parseIp(text.slice(0, slash));
  if (!ip) return null;
  const prefix = Number(prefixText);
  const bits = IP_BITS[ip.version];
  if (prefix > bits) return null;
  const base = ip.value & networkMask(bits, prefix);
  return { version: ip.version, base, prefix, cidr: `${text.slice(0, slash)}/${prefix}` };
}

/**
 * Test whether `ip` falls inside `cidr`. Both arguments accept either
 * a string (parsed on the fly via {@link parseIp} / {@link parseCidr})
 * or an already-parsed value - pass parsed values in hot loops to skip
 * re-parsing. Returns `false` for unparseable input or a version
 * mismatch (an IPv4 address is never inside an IPv6 block).
 *
 * @example
 * ipInCidr("10.1.2.3", "10.0.0.0/8");   // true
 * ipInCidr("11.0.0.1", "10.0.0.0/8");   // false
 */
export function ipInCidr(ip: string | ParsedIp, cidr: string | Cidr): boolean {
  const parsedIp = typeof ip === "string" ? parseIp(ip) : ip;
  const parsedCidr = typeof cidr === "string" ? parseCidr(cidr) : cidr;
  if (!parsedIp || !parsedCidr || parsedIp.version !== parsedCidr.version) {
    return false;
  }
  const mask = networkMask(IP_BITS[parsedCidr.version], parsedCidr.prefix);
  return (parsedIp.value & mask) === parsedCidr.base;
}

/**
 * Return the first CIDR in `cidrs` that contains `ip`, or `null` when
 * none match. `cidrs` holds pre-parsed {@link Cidr} values (or any
 * object extending it), so callers can carry side metadata on each
 * entry (e.g. a region tag) and read it straight off the returned
 * match. Linear scan; parse the address once by passing a
 * {@link ParsedIp}.
 *
 * @example
 * const ranges = ["10.0.0.0/8", "192.168.0.0/16"]
 *   .map(parseCidr)
 *   .filter((c): c is Cidr => c !== null);
 * findContainingCidr("10.1.2.3", ranges)?.cidr; // "10.0.0.0/8"
 */
export function findContainingCidr<T extends Cidr>(
  ip: string | ParsedIp,
  cidrs: Iterable<T>,
): T | null {
  const parsedIp = typeof ip === "string" ? parseIp(ip) : ip;
  if (!parsedIp) return null;
  for (const cidr of cidrs) {
    if (cidr.version !== parsedIp.version) continue;
    const mask = networkMask(IP_BITS[cidr.version], cidr.prefix);
    if ((parsedIp.value & mask) === cidr.base) return cidr;
  }
  return null;
}

/**
 * Network mask for `prefix` leading bits of a `bits`-wide address as a
 * `bigint`: the top `prefix` bits set, the low host bits cleared.
 * `prefix === 0` yields `0n` (matches everything); `prefix === bits`
 * yields the all-ones mask (matches a single address).
 */
function networkMask(bits: number, prefix: number): bigint {
  const hostBits = BigInt(bits - prefix);
  const full = (1n << BigInt(bits)) - 1n;
  return full ^ ((1n << hostBits) - 1n);
}

/** Parse a dotted-quad IPv4 literal into a 32-bit value, else `null`. */
function parseIpv4(input: string): bigint | null {
  const parts = input.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!IPV4_OCTET.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

/**
 * Parse an IPv6 literal into a 128-bit value, else `null`. Handles `::`
 * zero-compression (at most once) and a trailing embedded IPv4 group
 * (`::ffff:1.2.3.4`). The zone id, if any, is expected to be stripped
 * by {@link parseIp} before this is called.
 */
function parseIpv6(input: string): bigint | null {
  const halves = input.split("::");
  if (halves.length > 2) return null;

  const head = parseHextets(halves[0]!);
  if (head === null) return null;

  if (halves.length === 2) {
    const tail = parseHextets(halves[1]!);
    if (tail === null) return null;
    // "::" must stand in for at least one all-zero hextet.
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    return hextetsToValue([...head, ...Array(missing).fill(0), ...tail]);
  }

  if (head.length !== 8) return null;
  return hextetsToValue(head);
}

/**
 * Parse one colon-separated run of IPv6 hextets, expanding a trailing
 * embedded IPv4 group into its two hextets. An empty string yields an
 * empty list (the side of a leading / trailing `::`).
 */
function parseHextets(part: string): number[] | null {
  if (part === "") return [];
  const tokens = part.split(":");
  const hextets: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.includes(".")) {
      // A dotted-quad is only legal as the final group.
      if (i !== tokens.length - 1) return null;
      const v4 = parseIpv4(token);
      if (v4 === null) return null;
      hextets.push(Number((v4 >> 16n) & 0xffffn), Number(v4 & 0xffffn));
    } else {
      if (!IPV6_HEXTET.test(token)) return null;
      hextets.push(parseInt(token, 16));
    }
  }
  return hextets;
}

/** Fold exactly 8 hextets into a single 128-bit `bigint`, else `null`. */
function hextetsToValue(hextets: number[]): bigint | null {
  if (hextets.length !== 8) return null;
  let value = 0n;
  for (const hextet of hextets) value = (value << 16n) | BigInt(hextet);
  return value;
}
