/**
 * Best-effort geolocation of a host to the cloud provider and region it
 * runs in. Resolves the host to its IP address(es) via DNS, then matches
 * those addresses against the public IP-range feeds each hyperscaler
 * publishes (AWS, Azure, GCP). Handy for placing a Databricks workspace
 * URL, but works for any host.
 *
 * The range feeds are large and change slowly, so each provider's feed
 * is cached for {@link RANGE_CACHE_TTL_MS} (24 hours) at two layers: an
 * on-disk copy under the OS temp dir (survives process restarts, shared
 * across processes) plus an in-process memoized parse. A provider whose
 * feed fails to load is skipped rather than failing the whole lookup -
 * the other providers still answer.
 *
 * Server-only: DNS resolution needs `node:dns` (via `./net.ts`), the
 * disk cache needs `node:fs` / `node:os` / `node:path`, and the feeds
 * are fetched with the global `fetch`.
 */

import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { errorMessage, fnvHash, id, memoize } from "./common.js";
import { createFetchError } from "./http.js";
import { logger } from "./log.js";
import {
  findContainingCidr,
  parseCidr,
  parseIp,
  resolveHostIps,
  type Cidr,
  type UrlLike,
} from "./net.js";

const log = logger("cloud");

/** How long a fetched provider IP-range feed is reused before refetch. */
export const RANGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** AWS publishes a single stable, unauthenticated ranges feed. */
const AWS_RANGES_URL = "https://ip-ranges.amazonaws.com/ip-ranges.json";
/** GCP publishes a single stable, unauthenticated ranges feed. */
const GCP_RANGES_URL = "https://www.gstatic.com/ipranges/cloud.json";
/**
 * Azure has no stable feed URL - the JSON download link (with a
 * rotating date stamp) lives on this human-facing download page and
 * must be scraped out. See {@link fetchAzureRanges}.
 */
const AZURE_DOWNLOAD_PAGE =
  "https://www.microsoft.com/en-us/download/details.aspx?id=56519";
/** Regex that plucks the current `ServiceTags_Public_<date>.json` link off the Azure page. */
const AZURE_JSON_LINK =
  /https:\/\/download\.microsoft\.com\/download\/[^"']*ServiceTags_Public_\d+\.json/;

/** Cloud hyperscaler a host resolves into. */
export enum CloudProvider {
  Aws = "aws",
  Azure = "azure",
  Gcp = "gcp",
}

/**
 * Where a host lives: the {@link CloudProvider}, the provider-native
 * `region` string (whatever the provider's feed calls it, e.g.
 * `"us-east-1"` on AWS, `"eastus2"` on Azure, `"us-east1"` on GCP), the
 * resolved `ip` that matched, and the `cidr` block it fell in.
 */
export interface CloudLocation {
  provider: CloudProvider;
  region: string;
  ip: string;
  cidr: string;
}

/** A parsed CIDR block tagged with the region it belongs to. */
interface RegionCidr extends Cidr {
  region: string;
}

/** One provider's parsed, region-tagged range table. */
interface ProviderRanges {
  provider: CloudProvider;
  ranges: RegionCidr[];
}

/**
 * Resolve `input`'s host to a {@link CloudLocation}, or `null` when the
 * host can't be resolved or none of its IPs match a known cloud range.
 * `input` is any {@link UrlLike} - a URL, a bare host, or a `{ url }`
 * wrapper.
 *
 * The provider range feeds are cached for {@link RANGE_CACHE_TTL_MS}, so
 * only the first call in a 24-hour window pays the fetch cost; the DNS
 * lookup happens on every call.
 *
 * @example
 * await resolveCloudLocation("https://adb-1234567890.7.azuredatabricks.net");
 * // { provider: CloudProvider.Azure,
 * //   region: "eastus2", ip: "...", cidr: "..." }
 *
 * await resolveCloudLocation("dbc-abc123.cloud.databricks.com");
 * // { provider: CloudProvider.Aws,
 * //   region: "us-west-2", ip: "...", cidr: "..." }
 */
export async function resolveCloudLocation(
  input: UrlLike,
): Promise<CloudLocation | null> {
  const ips = await resolveHostIps(input);
  if (ips.length === 0) {
    log.debug("no ips resolved", { input: String(input) });
    return null;
  }
  const providers = await loadProviderRanges();
  for (const ip of ips) {
    const parsed = parseIp(ip);
    if (!parsed) continue;
    for (const { provider, ranges } of providers) {
      const match = findContainingCidr(parsed, ranges);
      if (match) {
        return { provider, region: match.region, ip, cidr: match.cidr };
      }
    }
  }
  log.debug("no cloud range matched", { ips });
  return null;
}

/**
 * Load every provider's region-tagged range table, each cached for
 * {@link RANGE_CACHE_TTL_MS}. Providers are loaded in parallel and a
 * feed that fails to fetch or parse is dropped (logged, not thrown) so
 * a single flaky feed never sinks the whole lookup. Exposed for callers
 * that want to match many IPs against one cached snapshot without a DNS
 * step per address.
 */
export async function loadProviderRanges(): Promise<ProviderRanges[]> {
  const settled = await Promise.allSettled([
    loadAwsRanges(),
    loadAzureRanges(),
    loadGcpRanges(),
  ]);
  const out: ProviderRanges[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") out.push(result.value);
    else log.warn("provider range load failed", { error: errorMessage(result.reason) });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────
// Per-provider cached loaders
// ────────────────────────────────────────────────────────────────

const loadAwsRanges = memoize(fetchAwsRanges, { ttlMs: RANGE_CACHE_TTL_MS });
const loadAzureRanges = memoize(fetchAzureRanges, { ttlMs: RANGE_CACHE_TTL_MS });
const loadGcpRanges = memoize(fetchGcpRanges, { ttlMs: RANGE_CACHE_TTL_MS });

// ────────────────────────────────────────────────────────────────
// Provider feed fetch + parse
// ────────────────────────────────────────────────────────────────

interface AwsFeed {
  prefixes?: { ip_prefix?: string; region?: string }[];
  ipv6_prefixes?: { ipv6_prefix?: string; region?: string }[];
}

/**
 * AWS `ip-ranges.json`: a flat list of IPv4 (`prefixes`) and IPv6
 * (`ipv6_prefixes`) blocks, each already tagged with a `region` such
 * as `"us-east-1"` (or `"GLOBAL"` for edge ranges).
 */
async function fetchAwsRanges(): Promise<ProviderRanges> {
  const feed = await fetchJson<AwsFeed>(AWS_RANGES_URL);
  const ranges: RegionCidr[] = [];
  for (const entry of feed.prefixes ?? []) {
    addRange(ranges, entry.ip_prefix, entry.region);
  }
  for (const entry of feed.ipv6_prefixes ?? []) {
    addRange(ranges, entry.ipv6_prefix, entry.region);
  }
  log.debug("loaded aws ranges", { count: ranges.length });
  return { provider: CloudProvider.Aws, ranges };
}

interface GcpFeed {
  prefixes?: { ipv4Prefix?: string; ipv6Prefix?: string; scope?: string }[];
}

/**
 * GCP `cloud.json`: a list of blocks each carrying an `ipv4Prefix` or
 * `ipv6Prefix` and a `scope` that is the region (`"us-east1"`) or
 * `"global"` for non-regional ranges.
 */
async function fetchGcpRanges(): Promise<ProviderRanges> {
  const feed = await fetchJson<GcpFeed>(GCP_RANGES_URL);
  const ranges: RegionCidr[] = [];
  for (const entry of feed.prefixes ?? []) {
    addRange(ranges, entry.ipv4Prefix ?? entry.ipv6Prefix, entry.scope);
  }
  log.debug("loaded gcp ranges", { count: ranges.length });
  return { provider: CloudProvider.Gcp, ranges };
}

interface AzureFeed {
  values?: {
    name?: string;
    properties?: { region?: string; addressPrefixes?: string[] };
  }[];
}

/**
 * Azure service tags: Microsoft ships no stable feed URL, so scrape the
 * current `ServiceTags_Public_<date>.json` link off the download page
 * and fetch it. Only the regional `AzureCloud.<region>` aggregates
 * (which have a non-empty `region`) are kept; the cloud-wide
 * `AzureCloud` tag and per-service tags are ignored so an address maps
 * cleanly to one region.
 */
async function fetchAzureRanges(): Promise<ProviderRanges> {
  const page = await fetchText(AZURE_DOWNLOAD_PAGE);
  const jsonUrl = page.match(AZURE_JSON_LINK)?.[0];
  if (!jsonUrl) {
    throw new Error("could not find ServiceTags JSON link on Azure download page");
  }
  const feed = await fetchJson<AzureFeed>(jsonUrl);
  const ranges: RegionCidr[] = [];
  for (const value of feed.values ?? []) {
    const region = value.properties?.region;
    if (!region || !value.name?.startsWith("AzureCloud.")) continue;
    for (const prefix of value.properties?.addressPrefixes ?? []) {
      addRange(ranges, prefix, region);
    }
  }
  log.debug("loaded azure ranges", { count: ranges.length });
  return { provider: CloudProvider.Azure, ranges };
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

/** Parse `cidr` and, when valid and `region` is set, push a tagged range. */
function addRange(ranges: RegionCidr[], cidr?: string, region?: string): void {
  if (!cidr || !region) return;
  const parsed = parseCidr(cidr);
  if (parsed) ranges.push({ ...parsed, region });
}

async function fetchJson<T>(url: string): Promise<T> {
  const text = await fetchText(url);
  return JSON.parse(text) as T;
}

/**
 * Fetch `url` as text with a 24h on-disk cache under the OS temp dir
 * (keyed by an FNV hash of the URL). A fresh cache file is returned
 * directly; a miss/expiry fetches, writes to a unique temp file, and
 * atomically renames it into place so concurrent callers never observe
 * a half-written cache entry.
 */
async function fetchText(url: string): Promise<string> {
  const cacheDir = join(tmpdir(), "dbx-tools", "shared", "cloud");
  const cacheDirCreated = await mkdir(cacheDir, { recursive: true });
  const cachePath = join(cacheDir, `fetch-${fnvHash(url)}.txt`);
  const createdAt = cacheDirCreated ? undefined : await getCreated(cachePath);
  if (createdAt) {
    const expiresAt = new Date(createdAt.getTime() + RANGE_CACHE_TTL_MS);
    if (expiresAt > new Date()) {
      log.debug("cached fetch hit", { url, cachePath });
      return await readFile(cachePath, "utf8");
    }
  }
  let tempPath: string | null = join(cacheDir, `${id()}.txt`);
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw await createFetchError(response, url);
    }
    const responseText = await response.text();
    await mkdir(dirname(tempPath), { recursive: true });
    await writeFile(tempPath, responseText);

    await rename(tempPath, cachePath);
    log.debug("cached fetch load", { url, cachePath });
    tempPath = null;
    return responseText;
  } finally {
    if (tempPath) {
      await unlink(tempPath);
    }
  }
}

/** Birth time of `path`, or `undefined` when it doesn't exist yet. */
async function getCreated(path: string): Promise<Date | undefined> {
  try {
    return (await stat(path)).birthtime;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}
