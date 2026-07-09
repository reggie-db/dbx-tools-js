/**
 * Lakebase Postgres connection resolver.
 *
 * Reads the same env vars the `lakebase` plugin consumes (`PGHOST`,
 * `PGDATABASE`, `PGPORT`, `PGSSLMODE`, `LAKEBASE_ENDPOINT`) and fills in
 * whichever pieces are missing using the Lakebase Autoscaling REST API
 * under `/api/2.0/postgres/` via the Databricks workspace client.
 *
 * `LAKEBASE_ENDPOINT` (and `config.endpoint`) accept anything
 * {@link parseAddress} understands - canonical resource paths, Postgres
 * URIs, bare hostnames, or bare project ids. The resolver layers
 * whatever pieces fall out of parsing under explicit config / env
 * values, then fills the remaining gaps via the API:
 *
 *   1. Reverse-lookup: when a host is known but no resource path is,
 *      scan projects -> branches -> endpoints for a matching
 *      `status.hosts.host` and recover the owning project/branch/endpoint.
 *   2. Pick: when a project is known but child resources aren't, prefer
 *      the server-side default (`status.default`, `ENDPOINT_TYPE_READ_WRITE`,
 *      `databricks_postgres`) and fall back to "the only one" when a
 *      listing returns a single result.
 *   3. Auto-create: when no projects exist at all, create one whose
 *      id defaults to `projectUtils.name()` slugified (override
 *      with `config.autoCreate: "my-id"` or disable with
 *      `config.autoCreate: false`). The create call is idempotent - an
 *      `ALREADY_EXISTS` response from a concurrent boot is treated as
 *      success. Then poll the default endpoint until it reports
 *      `current_state` `READY` or `IDLE`.
 *
 * The {@link autoConfigureLakebase} helper then writes the resolved values back to
 * `process.env` so the downstream `lakebase` plugin picks them up.
 *
 * @see https://docs.databricks.com/api/workspace/postgres
 */

import { getWorkspaceClient } from "@databricks/appkit";
import { logUtils, projectUtils, stringUtils } from "@dbx-tools/shared";
import { setTimeout as sleep } from "node:timers/promises";

import { resolveConfigValue } from "./config-value.js";
import {
  parseAddress,
  parseResourcePath,
  type LakebaseConnectionInputs,
  type SslMode,
} from "./pgaddress.js";

const log = logUtils.logger("lakebase-resolver");
const API_BASE = "/api/2.0/postgres";
const DEFAULT_PORT = 5432;
const DEFAULT_SSL_MODE: SslMode = "require";
const DEFAULT_PG_VERSION = 17;
/** Lakebase project ids: `^[a-z][a-z0-9-]{0,61}[a-z0-9]$`. */
const PROJECT_ID_MAX_LEN = 63;
const OPERATION_TIMEOUT_MS = 5 * 60_000;
const OPERATION_POLL_MS = 2_000;
const ENDPOINT_READY_TIMEOUT_MS = 5 * 60_000;
const ENDPOINT_READY_POLL_MS = 2_000;

/**
 * User-supplied Lakebase inputs (config or env) before any API resolution.
 * Extends {@link LakebaseConnectionInputs} with resolver-only options.
 * {@link resolveLakebaseConnection} fills gaps from the Lakebase API when
 * it has enough context (typically a `project`).
 */
export interface LakebaseResolverInputs extends LakebaseConnectionInputs {
  /**
   * What to do when no project exists in the workspace at all.
   * - `undefined` (default): derive a project id from
   *   {@link projectUtils.name} (the host repo's `package.json`
   *   name) slugified to Lakebase id constraints, then create it.
   * - `string`: create a new project with this exact id.
   * - `false`: skip creation and throw with a clear error message.
   */
  autoCreate?: string | false;
}

/** Fully-resolved Lakebase Postgres connection. */
export interface LakebaseConnection extends LakebaseConnectionInputs {
  port: number;
  sslMode: SslMode;
}

/**
 * Lakebase REST list responses follow the Google AIP convention:
 * `{ <plural-resource>: T[], next_page_token?: string }`. We only read
 * the first page; for auto-config's "pick something sensible" semantics the
 * cap is fine.
 */
interface ListResponse {
  next_page_token?: string;
  projects?: Project[];
  branches?: Branch[];
  endpoints?: Endpoint[];
  databases?: Database[];
}

interface Project {
  /** Full resource path: `projects/{p}`. */
  name?: string;
}

interface Endpoint {
  /** Full resource path: `projects/{p}/branches/{b}/endpoints/{e}`. */
  name?: string;
  uid?: string;
  /**
   * Server-side state. All connection info lives here - the spec block
   * only carries the desired configuration, not the runtime hostnames.
   */
  status?: {
    endpoint_type?: "ENDPOINT_TYPE_READ_WRITE" | "ENDPOINT_TYPE_READ_ONLY";
    /** Resolved hostnames; `hosts.host` is the writable primary. */
    hosts?: {
      host?: string;
      read_only_host?: string;
    };
    /** Compute state: `INITIALIZING`, `STARTING`, `READY`, `IDLE`, ... */
    current_state?: string;
  };
}

interface Branch {
  /** Full resource path: `projects/{p}/branches/{b}`. */
  name?: string;
  status?: {
    /** True for the project's default branch (e.g. `production`). */
    default?: boolean;
    current_state?: string;
  };
}

interface Database {
  /** Full resource path: `projects/{p}/branches/{b}/databases/{d}`. */
  name?: string;
  status?: {
    /**
     * Actual Postgres database name (used as `PGDATABASE`). May differ
     * from the resource id - e.g. resource `databricks-postgres`
     * surfaces as Postgres database `databricks_postgres`.
     */
    postgres_database?: string;
  };
}

/**
 * Long-running operation envelope returned by mutating REST calls.
 * `done: true` means terminal; check `error` before reading `response`.
 */
interface Operation {
  name?: string;
  done?: boolean;
  error?: unknown;
  response?: unknown;
}

/**
 * Pull resolver inputs from `process.env`, parse the address blob, and
 * layer explicit config on top with this precedence:
 *
 *   `config.<field>` > {@link resolveConfigValue} (`env`, then bundle
 *   validate JSON) > whatever {@link parseAddress} recovered from the
 *   `endpoint` / `LAKEBASE_ENDPOINT` blob.
 *
 * Set `config.endpoint` (or `LAKEBASE_ENDPOINT`) to any input
 * {@link parseAddress} understands: canonical resource paths, Postgres
 * URIs, bare hostnames, or bare project ids.
 */
export async function readLakebaseInputs(
  config?: LakebaseResolverInputs,
): Promise<LakebaseResolverInputs> {
  const rawAddress =
    config?.endpoint ?? (await resolveConfigValue("LAKEBASE_ENDPOINT"));
  const parsed = parseAddress(rawAddress);
  const portEnv = await resolveConfigValue("PGPORT");
  return {
    project:
      config?.project ??
      (await resolveConfigValue("postgres_project_id")) ??
      parsed.project,
    branch: config?.branch ?? parsed.branch,
    // Only canonical endpoint resource paths survive here; URIs and
    // bare hostnames set `host` instead and leave `endpoint` undefined
    // until the REST resolver fills it in.
    endpoint: parsed.endpoint,
    database:
      config?.database ?? (await resolveConfigValue("PGDATABASE")) ?? parsed.database,
    host: config?.host ?? (await resolveConfigValue("PGHOST")) ?? parsed.host,
    port:
      config?.port ??
      (portEnv ? Number.parseInt(portEnv, 10) : undefined) ??
      parsed.port,
    sslMode:
      config?.sslMode ??
      ((await resolveConfigValue("PGSSLMODE")) as SslMode | undefined) ??
      parsed.sslMode,
    autoCreate: config?.autoCreate,
  };
}

/**
 * Resolve a fully-populated Postgres connection record from config + env.
 *
 * Returns immediately without network traffic when env already supplies
 * `endpoint`, `host`, and `database`. Otherwise issues REST calls and
 * may auto-create a project (see module docstring).
 */
export async function resolveLakebaseConnection(
  config?: LakebaseResolverInputs,
): Promise<LakebaseConnection> {
  const inputs = await readLakebaseInputs(config);
  let { project, branch, endpoint, database, host } = inputs;
  const port = inputs.port ?? DEFAULT_PORT;
  const sslMode = inputs.sslMode ?? DEFAULT_SSL_MODE;

  // Resource paths may carry redundant info; harvest project/branch
  // from any canonical path that snuck in via PGDATABASE or similar.
  if (endpoint && (!project || !branch)) {
    const parsedEndpoint = parseAddress(endpoint);
    project ??= parsedEndpoint.project;
    branch ??= parsedEndpoint.branch;
  }
  if (database && (!project || !branch)) {
    const parsedDatabase = parseAddress(database);
    project ??= parsedDatabase.project;
    branch ??= parsedDatabase.branch;
    if (parsedDatabase.databaseResourceId) {
      database = parsedDatabase.databaseResourceId;
    }
  }

  // Already complete: skip every REST call.
  if (endpoint && host && database) {
    return { project, branch, endpoint, database, host, port, sslMode };
  }

  const ws = getWorkspaceClient({});

  // Host known but no resource path: scan the workspace to find which
  // endpoint owns this host so we can populate LAKEBASE_ENDPOINT.
  if (!project && host) {
    const found = await findEndpointByHost(ws, host);
    if (found) {
      project = found.project;
      branch = found.branch;
      endpoint ??= found.endpoint;
    }
  }

  // No project anywhere in config/env/address: list, pick, or create.
  if (!project) {
    project = await pickOrCreateProject(ws, config?.autoCreate, log);
  }

  if (!branch) {
    branch = await pickBranch(ws, project, log);
  }

  if (!endpoint) {
    const ep = await pickEndpoint(ws, project, branch, log);
    endpoint = ep.name;
    host ??= ep.host;
  }

  if (!host && endpoint) {
    const parsedEndpoint = parseAddress(endpoint);
    if (parsedEndpoint.project && parsedEndpoint.branch && parsedEndpoint.endpointId) {
      const ep = await waitEndpointReady(
        ws,
        parsedEndpoint.project,
        parsedEndpoint.branch,
        parsedEndpoint.endpointId,
        log,
      );
      host = ep.status?.hosts?.host;
      log.debug("autopg: resolved host from endpoint", { host });
    }
  }

  if (!database) {
    database = await pickDatabase(ws, project, branch, log);
  }

  return { project, branch, endpoint, database, host, port, sslMode };
}

/**
 * Write resolved values back to `process.env` so the `lakebase` plugin
 * (which reads env directly) picks them up during its own `setup()`.
 * Existing env values are preserved; only missing keys are filled in,
 * which keeps explicit overrides authoritative.
 */
export function applyLakebaseToEnv(resolved: LakebaseConnection): void {
  if (resolved.endpoint) process.env.LAKEBASE_ENDPOINT ??= resolved.endpoint;
  if (resolved.host) process.env.PGHOST ??= resolved.host;
  if (resolved.database) process.env.PGDATABASE ??= resolved.database;
  process.env.PGPORT ??= String(resolved.port);
  process.env.PGSSLMODE ??= resolved.sslMode;
}

type WorkspaceClient = ReturnType<typeof getWorkspaceClient>;

/** GET helper that always parses JSON and forwards through `apiClient`. */
async function getJson<T>(ws: WorkspaceClient, path: string): Promise<T> {
  const res = await ws.apiClient.request({
    path,
    method: "GET",
    headers: new Headers({ Accept: "application/json" }),
    raw: false,
  });
  return res as T;
}

/** POST helper for create / mutate calls; returns the parsed JSON body. */
async function postJson<T>(
  ws: WorkspaceClient,
  path: string,
  body: unknown,
  query?: Record<string, string>,
): Promise<T> {
  const res = await ws.apiClient.request({
    path,
    method: "POST",
    query,
    headers: new Headers({
      Accept: "application/json",
      "Content-Type": "application/json",
    }),
    raw: false,
    payload: body,
  });
  return res as T;
}

async function listProjects(ws: WorkspaceClient): Promise<Project[]> {
  const res = await getJson<ListResponse>(ws, `${API_BASE}/projects`);
  return res.projects ?? [];
}

async function listBranches(ws: WorkspaceClient, project: string): Promise<Branch[]> {
  const res = await getJson<ListResponse>(
    ws,
    `${API_BASE}/projects/${project}/branches`,
  );
  return res.branches ?? [];
}

async function listEndpoints(
  ws: WorkspaceClient,
  project: string,
  branch: string,
): Promise<Endpoint[]> {
  const res = await getJson<ListResponse>(
    ws,
    `${API_BASE}/projects/${project}/branches/${branch}/endpoints`,
  );
  return res.endpoints ?? [];
}

async function listDatabases(
  ws: WorkspaceClient,
  project: string,
  branch: string,
): Promise<Database[]> {
  const res = await getJson<ListResponse>(
    ws,
    `${API_BASE}/projects/${project}/branches/${branch}/databases`,
  );
  return res.databases ?? [];
}

async function getEndpoint(
  ws: WorkspaceClient,
  project: string,
  branch: string,
  endpointId: string,
): Promise<Endpoint> {
  return getJson<Endpoint>(
    ws,
    `${API_BASE}/projects/${project}/branches/${branch}/endpoints/${endpointId}`,
  );
}

/**
 * Scan the workspace for an endpoint whose `status.hosts.host` matches
 * the provided hostname. Used to recover the owning project/branch/
 * endpoint resource path when the caller only supplied a Postgres URI.
 *
 * O(projects * branches * endpoints) - fine for typical workspaces
 * (single digits per tier); pagination is intentionally not followed
 * since this is a best-effort fallback.
 */
async function findEndpointByHost(
  ws: WorkspaceClient,
  host: string,
): Promise<{ project: string; branch: string; endpoint: string } | null> {
  const projects = await listProjects(ws);
  for (const p of projects) {
    const projectId = parseResourcePath(p.name).project;
    if (!projectId) continue;
    const branches = await listBranches(ws, projectId);
    for (const b of branches) {
      const branchId = parseResourcePath(b.name).branch;
      if (!branchId) continue;
      const endpoints = await listEndpoints(ws, projectId, branchId);
      const match = endpoints.find((e) => e.status?.hosts?.host === host);
      if (match?.name) {
        log.debug("autopg: matched endpoint by host", {
          host,
          endpoint: match.name,
        });
        return {
          project: projectId,
          branch: branchId,
          endpoint: match.name,
        };
      }
    }
  }
  log.debug("autopg: no endpoint matched host", { host });
  return null;
}

/**
 * Pick the project to use, or create one when the workspace is empty.
 *
 * Selection order:
 * 1. Exactly one project listed -> use it.
 * 2. Zero projects AND `autoCreate !== false` -> ensure a project with
 *    the resolved id exists, then return its id.
 * 3. Zero projects AND `autoCreate === false` -> throw.
 * 4. Multiple projects -> throw with the candidate list (set
 *    `config.project` or pin a project id in `LAKEBASE_ENDPOINT`).
 */
async function pickOrCreateProject(
  ws: WorkspaceClient,
  autoCreate: string | false | undefined,
  log: logUtils.Logger,
): Promise<string> {
  const projects = await listProjects(ws);
  if (projects.length === 1) {
    const id = parseResourcePath(projects[0]!.name).project;
    if (id) {
      log.debug("autopg: using only project", { project: id });
      return id;
    }
  }
  if (projects.length === 0) {
    if (autoCreate === false) {
      throw new Error(
        "autopg: no Lakebase projects found and `autoCreate: false`; create a project or set config.project / LAKEBASE_ENDPOINT",
      );
    }
    const id = autoCreate ?? (await defaultProjectId());
    return ensureProject(ws, id, log);
  }
  const candidates = projects
    .map((p) => parseResourcePath(p.name).project)
    .filter((id): id is string => Boolean(id))
    .join(", ");
  throw new Error(
    `autopg: multiple projects found; set config.project or pin a project id in LAKEBASE_ENDPOINT. Candidates: ${candidates}`,
  );
}

/**
 * Derive a Lakebase project id from the host repo's `package.json`
 * name (via {@link projectUtils.name}) slugified to satisfy the
 * Lakebase id constraint (`^[a-z][a-z0-9-]{0,61}[a-z0-9]$`).
 *
 * Throws when the slug ends up empty or starts with a digit, since the
 * server would reject it anyway - callers should pass an explicit
 * `autoCreate` id in that case.
 */
async function defaultProjectId(): Promise<string> {
  const name = await projectUtils.name();
  const slug = stringUtils.toSlugWithOptions({ maxLength: PROJECT_ID_MAX_LEN }, name);
  if (!slug || !/^[a-z]/.test(slug)) {
    throw new Error(
      `autopg: could not derive a Lakebase project id from project name '${name}'; pass autoCreate explicitly`,
    );
  }
  return slug;
}

/**
 * Ensure a Lakebase project with `projectId` exists. Creates it and
 * waits for the create operation to complete. An `ALREADY_EXISTS`
 * response is treated as success - someone else (a concurrent boot,
 * a sibling process) won the race and the project we wanted is now
 * sitting there ready for downstream pickers.
 *
 * Project creation typically provisions a default `production` branch
 * alongside; downstream pickers handle the rest.
 */
async function ensureProject(
  ws: WorkspaceClient,
  projectId: string,
  log: logUtils.Logger,
): Promise<string> {
  log.warn("autopg: no projects found; creating", { project: projectId });
  try {
    const op = await postJson<Operation>(
      ws,
      `${API_BASE}/projects`,
      { spec: { pg_version: DEFAULT_PG_VERSION } },
      { project_id: projectId },
    );
    await waitForOperation(ws, op, log);
    log.info("autopg: created project", { project: projectId });
  } catch (err) {
    if (!isAlreadyExistsError(err)) throw err;
    log.info("autopg: project already exists (race); proceeding", {
      project: projectId,
    });
  }
  return projectId;
}

/**
 * Recognize the Databricks SDK's `ALREADY_EXISTS` failure modes so a
 * lost race during `ensureProject` becomes a no-op instead of an error.
 *
 * The SDK throws `ApiError { errorCode, statusCode }` for structured
 * server errors and `HttpError { code }` for transport-layer 4xx/5xx.
 * Both surface a human message that often carries "already exists" so
 * we use that as a final fallback for forward compatibility.
 */
function isAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as {
    statusCode?: number;
    code?: number;
    errorCode?: string;
    message?: string;
  };
  if (e.statusCode === 409 || e.code === 409) return true;
  if (e.errorCode && /already.?exists/i.test(e.errorCode)) return true;
  if (e.message && /already.?exists/i.test(e.message)) return true;
  return false;
}

/**
 * Poll a Lakebase long-running operation until `done: true`. Returns
 * the final operation envelope (which may carry `response` or `error`).
 *
 * Throws when:
 *   - the response carries an `error` field;
 *   - `op.name` is missing (nothing to poll);
 *   - the timeout elapses before `done: true`.
 */
async function waitForOperation(
  ws: WorkspaceClient,
  op: Operation,
  log: logUtils.Logger,
): Promise<Operation> {
  if (op.done) {
    if (op.error) {
      throw new Error(`autopg: operation failed: ${JSON.stringify(op.error)}`);
    }
    return op;
  }
  const opName = op.name;
  if (!opName) {
    throw new Error("autopg: operation response has no name to poll");
  }
  const start = Date.now();
  while (Date.now() - start < OPERATION_TIMEOUT_MS) {
    await sleep(OPERATION_POLL_MS);
    const current = await getJson<Operation>(ws, `${API_BASE}/${opName}`);
    log.debug("autopg: operation status", { op: opName, done: current.done });
    if (current.done) {
      if (current.error) {
        throw new Error(
          `autopg: operation '${opName}' failed: ${JSON.stringify(current.error)}`,
        );
      }
      return current;
    }
  }
  throw new Error(
    `autopg: operation '${opName}' did not complete within ${OPERATION_TIMEOUT_MS}ms`,
  );
}

/**
 * Poll `getEndpoint` until the compute reports a usable
 * `status.current_state`. `READY` and `IDLE` are both acceptable -
 * `IDLE` just means the compute has scaled to zero but a connection
 * will wake it. Returns the final endpoint payload (with `hosts.host`).
 */
async function waitEndpointReady(
  ws: WorkspaceClient,
  project: string,
  branch: string,
  endpointId: string,
  log: logUtils.Logger,
): Promise<Endpoint> {
  const start = Date.now();
  let last: Endpoint | null = null;
  while (Date.now() - start < ENDPOINT_READY_TIMEOUT_MS) {
    last = await getEndpoint(ws, project, branch, endpointId);
    const state = last.status?.current_state;
    if (state === "READY" || state === "IDLE") return last;
    if (last.status?.hosts?.host && state !== "INITIALIZING") {
      // Compute is in some other state (STARTING, etc.) but hostname is
      // already published - good enough to connect; lakebase's OAuth
      // token request will wake it.
      return last;
    }
    log.debug("autopg: waiting for endpoint", { endpointId, state });
    await sleep(ENDPOINT_READY_POLL_MS);
  }
  throw new Error(
    `autopg: endpoint '${endpointId}' under projects/${project}/branches/${branch} did not become ready within ${ENDPOINT_READY_TIMEOUT_MS}ms (last state: ${last?.status?.current_state ?? "unknown"})`,
  );
}

/**
 * Pick the default branch for a project. Prefers the branch flagged
 * `status.default: true` (server-side default, typically `production`
 * unless the project owner changed it). Falls back to the only branch
 * when there's exactly one. Otherwise throws with the candidate list.
 */
async function pickBranch(
  ws: WorkspaceClient,
  project: string,
  log: logUtils.Logger,
): Promise<string> {
  const branches = await listBranches(ws, project);
  if (branches.length === 0) {
    throw new Error(
      `autopg: project '${project}' has no branches; cannot resolve a default`,
    );
  }
  const flagged = branches.find((b) => b.status?.default === true);
  const choice =
    parseResourcePath(flagged?.name).branch ??
    (branches.length === 1 ? parseResourcePath(branches[0]!.name).branch : undefined);
  if (!choice) {
    const candidates = branches
      .map((b) => parseResourcePath(b.name).branch)
      .filter((id): id is string => Boolean(id))
      .join(", ");
    throw new Error(
      `autopg: project '${project}' has multiple branches and none marked default; set config.branch or include the branch in LAKEBASE_ENDPOINT. Candidates: ${candidates}`,
    );
  }
  log.debug("autopg: resolved branch", { project, branch: choice });
  return choice;
}

/**
 * Pick the primary endpoint for a (project, branch). Prefers
 * `status.endpoint_type === ENDPOINT_TYPE_READ_WRITE`; falls back to
 * the only endpoint when there's exactly one. Returns `{ name, host }`
 * so the caller can populate both `LAKEBASE_ENDPOINT` and `PGHOST`
 * from a single call.
 */
async function pickEndpoint(
  ws: WorkspaceClient,
  project: string,
  branch: string,
  log: logUtils.Logger,
): Promise<{ name: string; host?: string }> {
  const endpoints = await listEndpoints(ws, project, branch);
  if (endpoints.length === 0) {
    throw new Error(
      `autopg: branch 'projects/${project}/branches/${branch}' has no endpoints; cannot resolve LAKEBASE_ENDPOINT`,
    );
  }
  const primary =
    endpoints.find((e) => e.status?.endpoint_type === "ENDPOINT_TYPE_READ_WRITE") ??
    (endpoints.length === 1 ? endpoints[0] : undefined);
  if (!primary?.name) {
    const names = endpoints.map((e) => e.name).filter(Boolean);
    throw new Error(
      `autopg: branch has no primary READ_WRITE endpoint; set LAKEBASE_ENDPOINT or config.endpoint. Candidates: ${names.join(", ")}`,
    );
  }
  const host = primary.status?.hosts?.host;
  log.debug("autopg: resolved endpoint", { endpoint: primary.name, host });
  return { name: primary.name, host };
}

/**
 * Pick the default postgres database for a (project, branch). The
 * Postgres database NAME (`status.postgres_database`) is what
 * `PGDATABASE` needs - this differs from the resource id, which can
 * use a different separator (e.g. resource `databricks-postgres`
 * surfaces as database `databricks_postgres`). Prefers
 * `databricks_postgres` (the Lakebase default), otherwise the only
 * database.
 */
async function pickDatabase(
  ws: WorkspaceClient,
  project: string,
  branch: string,
  log: logUtils.Logger,
): Promise<string> {
  const databases = await listDatabases(ws, project, branch);
  if (databases.length === 0) {
    throw new Error(
      `autopg: branch 'projects/${project}/branches/${branch}' has no databases; cannot resolve PGDATABASE`,
    );
  }
  const names = databases
    .map((d) => d.status?.postgres_database)
    .filter((n): n is string => Boolean(n));
  const choice =
    names.find((n) => n === "databricks_postgres") ??
    (names.length === 1 ? names[0] : undefined);
  if (!choice) {
    throw new Error(
      `autopg: multiple databases and no 'databricks_postgres'; set PGDATABASE or config.database. Candidates: ${names.join(", ")}`,
    );
  }
  log.debug("autopg: resolved database", { database: choice });
  return choice;
}
