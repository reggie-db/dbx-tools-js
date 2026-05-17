/**
 * Flexible address parser for Lakebase Postgres connection inputs.
 *
 * Accepts whatever shape a user is likely to paste into
 * `LAKEBASE_ENDPOINT` (or the matching config field) and extracts
 * every recognizable piece. Whatever it can't recover is left for the
 * REST resolver to discover.
 *
 * Recognized formats:
 *
 * - **Postgres URI** -
 *   `postgresql://user@host:port/db?sslmode=require` (also `postgres://`).
 *   Yields `user`, `host`, `port`, `database`, `sslMode`.
 *
 * - **Canonical endpoint resource path** -
 *   `projects/{p}/branches/{b}/endpoints/{e}` -
 *   yields `project`, `branch`, `endpointId`, and the original string as
 *   `endpoint` (already in lakebase's expected form).
 *
 * - **Database resource path** -
 *   `projects/{p}/branches/{b}/databases/{d}` -
 *   yields `project`, `branch`. The database leaf isn't surfaced because
 *   it's a resource id, not the Postgres database name; the resolver
 *   will look up the real `status.postgres_database` value via REST.
 *
 * - **Branch resource path** -
 *   `projects/{p}/branches/{b}` - yields `project`, `branch`.
 *
 * - **Project resource path** -
 *   `projects/{p}` - yields `project`.
 *
 * - **Bare hostname** -
 *   `ep-steep-forest-e199v43w.database.eastus2.azuredatabricks.net` -
 *   yields `host` only; the resolver reverse-looks up the owning
 *   endpoint to recover the resource path.
 *
 * - **Bare project id** -
 *   `dbx-tools-demo` (1-63 chars, lowercase letters/digits/hyphens) -
 *   yields `project`.
 *
 * Returns an empty object for inputs it doesn't recognize.
 */

import type { SslMode } from "./resolver.js";

export interface ParsedAddress {
  /** Lakebase project id. */
  project?: string;
  /** Branch id within the project. */
  branch?: string;
  /** Endpoint leaf id (last segment of an endpoint resource path). */
  endpointId?: string;
  /** Canonical endpoint resource path; only set for matching inputs. */
  endpoint?: string;
  /** Postgres database name (PGDATABASE) when parsed from a URI path. */
  database?: string;
  /** Postgres hostname. */
  host?: string;
  /** Postgres port. */
  port?: number;
  /** Postgres user (URI-decoded if encoded). */
  user?: string;
  /** Postgres TLS mode. */
  sslMode?: SslMode;
}

const URL_SCHEME_RE = /^(postgres|postgresql):\/\//i;
const RESOURCE_ENDPOINT_RE =
  /^projects\/([^/]+)\/branches\/([^/]+)\/endpoints\/([^/]+)$/;
const RESOURCE_DATABASE_RE =
  /^projects\/([^/]+)\/branches\/([^/]+)\/databases\/([^/]+)$/;
const RESOURCE_BRANCH_RE = /^projects\/([^/]+)\/branches\/([^/]+)$/;
const RESOURCE_PROJECT_RE = /^projects\/([^/]+)$/;
const PROJECT_ID_RE = /^[a-z][a-z0-9-]{0,61}[a-z0-9]$|^[a-z]$/;
const HOSTNAME_HINT_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/i;

/**
 * Parse a Lakebase connection input into whatever pieces it carries.
 * See module docstring for the supported formats. Returns `{}` for
 * `undefined`, empty strings, and unrecognized inputs.
 */
export function parseAddress(input: string | undefined | null): ParsedAddress {
  if (!input) return {};
  const s = input.trim();
  if (!s) return {};

  if (URL_SCHEME_RE.test(s)) return parseUri(s);
  if (s.startsWith("projects/")) return parseResourcePath(s);
  // Resource ids never contain dots; a dotted input must be a hostname.
  if (HOSTNAME_HINT_RE.test(s) && s.includes(".")) return { host: s };
  if (PROJECT_ID_RE.test(s)) return { project: s };
  return {};
}

function parseUri(s: string): ParsedAddress {
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return {};
  }
  const result: ParsedAddress = {};
  if (url.hostname) result.host = url.hostname;
  if (url.port) {
    const port = Number.parseInt(url.port, 10);
    if (!Number.isNaN(port)) result.port = port;
  }
  if (url.username) {
    try {
      result.user = decodeURIComponent(url.username);
    } catch {
      // Malformed percent-escape; keep the raw form.
      result.user = url.username;
    }
  }
  const db = url.pathname.replace(/^\//, "");
  if (db) result.database = decodeURIComponent(db);
  // Postgres clients accept `sslmode`; URL params are case-sensitive but
  // we tolerate either since users paste both.
  const sslmodeRaw = url.searchParams.get("sslmode") ?? url.searchParams.get("sslMode");
  const sslmode = sslmodeRaw?.toLowerCase();
  if (sslmode === "require" || sslmode === "disable" || sslmode === "prefer") {
    result.sslMode = sslmode;
  }
  return result;
}

function parseResourcePath(s: string): ParsedAddress {
  const ep = RESOURCE_ENDPOINT_RE.exec(s);
  if (ep) {
    return {
      project: ep[1],
      branch: ep[2],
      endpointId: ep[3],
      endpoint: s,
    };
  }
  // databases/{d} is a resource id (often kebab-case), not the actual
  // Postgres database name. Surface project + branch only; the resolver
  // will fetch the real `postgres_database` value.
  const db = RESOURCE_DATABASE_RE.exec(s);
  if (db) return { project: db[1], branch: db[2] };
  const br = RESOURCE_BRANCH_RE.exec(s);
  if (br) return { project: br[1], branch: br[2] };
  const pr = RESOURCE_PROJECT_RE.exec(s);
  if (pr) return { project: pr[1] };
  return {};
}
