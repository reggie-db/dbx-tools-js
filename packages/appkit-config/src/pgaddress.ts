/**
 * Flexible address parser for Lakebase Postgres connection inputs.
 *
 * Accepts whatever shape a user is likely to paste into
 * `LAKEBASE_ENDPOINT` (or the matching config field) and extracts
 * every recognizable piece. Whatever it can't recover is left for the
 * Lakebase resolver to discover.
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
 *   yields `project`, `branch`, and `databaseResourceId` (the UC
 *   resource leaf, not `PGDATABASE`; the resolver looks up the real
 *   Postgres name via REST).
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

/** Postgres TLS mode passed through to `pg`. */
export type SslMode = "require" | "disable" | "prefer";

/**
 * Optional Lakebase Postgres connection fields shared by parsed addresses,
 * resolver/env inputs, and resolved connections.
 */
export interface LakebaseConnectionInputs {
  /** Lakebase project id. */
  project?: string;
  /** Branch id within the project. */
  branch?: string;
  /** Canonical endpoint resource path (`projects/.../endpoints/...`). */
  endpoint?: string;
  /** Postgres database name (`PGDATABASE`). */
  database?: string;
  /** Postgres hostname (`PGHOST`). */
  host?: string;
  /** Postgres port (`PGPORT`). */
  port?: number;
  /** Postgres TLS mode (`PGSSLMODE`). */
  sslMode?: SslMode;
}

/** Pieces recovered from parsing a single address or resource-path input. */
export interface ParsedAddress extends LakebaseConnectionInputs {
  /** Endpoint leaf id (last segment of an endpoint resource path). */
  endpointId?: string;
  /**
   * Database resource id leaf from a `.../databases/{id}` path. Not the
   * Postgres database name.
   */
  databaseResourceId?: string;
  /** Postgres user (URI-decoded if encoded). */
  user?: string;
}

const URL_SCHEME_RE = /^(postgres|postgresql):\/\//i;
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
  if (s.startsWith("projects/")) return parseResourcePathSegments(s);
  // Resource ids never contain dots; a dotted input must be a hostname.
  if (HOSTNAME_HINT_RE.test(s) && s.includes(".")) return { host: s };
  if (PROJECT_ID_RE.test(s)) return { project: s };
  return {};
}

/**
 * Parse a Lakebase `projects/...` resource path. Returns `{}` when the
 * input is not a resource path (so bare branch ids are not mistaken for
 * project ids).
 */
export function parseResourcePath(input: string | undefined | null): ParsedAddress {
  if (!input) return {};
  const s = input.trim();
  if (!s.startsWith("projects/")) return {};
  return parseResourcePathSegments(s);
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
      result.user = url.username;
    }
  }
  const db = url.pathname.replace(/^\//, "");
  if (db) result.database = decodeURIComponent(db);
  const sslmodeRaw = url.searchParams.get("sslmode") ?? url.searchParams.get("sslMode");
  const sslmode = sslmodeRaw?.toLowerCase();
  if (sslmode === "require" || sslmode === "disable" || sslmode === "prefer") {
    result.sslMode = sslmode;
  }
  return result;
}

function parseResourcePathSegments(s: string): ParsedAddress {
  const parts = s.split("/");
  if (parts[0] !== "projects" || parts.length < 2) {
    return {};
  }

  const project = parts[1];
  if (!project) {
    return {};
  }

  if (parts.length === 2) {
    return { project };
  }

  if (parts.length === 4 && parts[2] === "branches" && parts[3]) {
    return { project, branch: parts[3] };
  }

  if (
    parts.length === 6 &&
    parts[2] === "branches" &&
    parts[4] === "endpoints" &&
    parts[3] &&
    parts[5]
  ) {
    return {
      project,
      branch: parts[3],
      endpointId: parts[5],
      endpoint: s,
    };
  }

  if (
    parts.length === 6 &&
    parts[2] === "branches" &&
    parts[4] === "databases" &&
    parts[3] &&
    parts[5]
  ) {
    return {
      project,
      branch: parts[3],
      databaseResourceId: parts[5],
    };
  }

  return {};
}
