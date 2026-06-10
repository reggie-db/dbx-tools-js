/**
 * Top-level Lakebase auto-discovery helper.
 *
 * Most apps don't call this directly - `createApp` from
 * `@dbx-tools/appkit-config` runs it automatically when a `lakebase`
 * plugin is present. Reach for it standalone only when you want the
 * resolution without the `createApp` wrapper; call it once at process
 * startup BEFORE `createApp(...)` so the `lakebase` plugin (and anyone
 * else who reads `process.env` during `setup()`) sees a fully-populated
 * environment:
 *
 * ```ts
 * import { autopg } from "@dbx-tools/appkit-config";
 * import { createApp, lakebase, server } from "@databricks/appkit";
 *
 * await autopg();              // resolves + writes process.env
 * await createApp({ plugins: [lakebase(), server()] });
 * ```
 *
 * `autopg` is intentionally NOT an AppKit plugin. AppKit's `static phase`
 * field only orders plugin `setup()` invocation, not async completion -
 * `lakebase.setup()` calls `parsePoolConfig` synchronously after its
 * first `await` and would throw on `PGHOST` before any sibling plugin's
 * REST resolution could finish. Awaiting `autopg()` upfront sidesteps
 * the race entirely.
 *
 * Inputs flow in this priority order:
 *   1. Explicit `config.<field>` argument
 *   2. Matching env var (`LAKEBASE_PROJECT`, `LAKEBASE_BRANCH`,
 *      `LAKEBASE_ENDPOINT`, `PGHOST`, `PGDATABASE`, `PGPORT`, `PGSSLMODE`)
 *   3. Derived from the Lakebase Autoscaling REST API under
 *      `/api/2.0/postgres/` via the Databricks workspace client
 *
 * Resolved values are written back to `process.env` (only filling gaps;
 * existing values are preserved) so the downstream `lakebase` plugin
 * picks them up. Pass `{ exportEnv: false }` to keep `process.env`
 * untouched and just inspect the returned record.
 */

import { getUsernameWithApiLookup } from "@databricks/appkit";
import { logUtils } from "@dbx-tools/shared";

import { provisionCacheSchema } from "./provision.js";
import {
  applyToEnv,
  resolveConnection,
  type Resolved,
  type ResolverInputs,
} from "./resolver.js";

/** Options accepted by {@link autopg}. */
export interface AutopgOptions extends ResolverInputs {
  /**
   * When `true` (the default), resolved values are written to
   * `process.env` so the `lakebase` plugin sees them at startup.
   * Set to `false` to leave `process.env` untouched and just receive
   * the resolved record back.
   */
  exportEnv?: boolean;
  /**
   * When `true` (the default), and only when running OUTSIDE a Databricks
   * App, grant the connecting role full rights on the AppKit
   * persistent-cache schema (`appkit`) via {@link provisionCacheSchema} -
   * but only if that schema already exists (it is never created here).
   * This stops the cache from silently disabling itself (and 404-ing every
   * persistent read) on an identity that lacks privileges on the schema.
   * Requires `exportEnv` so the connection is on `process.env`. No-ops
   * inside a Databricks App regardless of this flag.
   */
  provisionCache?: boolean;
}

/**
 * Resolve Lakebase Postgres connection info from config + env (and the
 * Databricks REST API when needed), write the resolved values to
 * `process.env`, and return the fully-populated record.
 *
 * Always safe to call: when env already provides every field, it
 * returns immediately without any network traffic.
 *
 * @throws when a `project` is set (directly or via env) but the
 *   Databricks API returns no branches / endpoints / databases to
 *   choose from. The error message lists the available candidates so
 *   the caller can pin the right one via env or config.
 */
export async function autopg(opts: AutopgOptions = {}): Promise<Resolved> {
  const { exportEnv = true, provisionCache = true, ...inputs } = opts;
  const log = logUtils.logger("autopg");
  const resolved = await resolveConnection(inputs, log);
  if (!exportEnv) {
    log.info("resolved (env untouched)", redactForLog(resolved));
    return resolved;
  }
  applyToEnv(resolved);

  // Export the connecting identity as PGUSER. The AppKit persistent cache
  // builds its Lakebase pool via createLakebasePool's SYNCHRONOUS username
  // lookup (config.user / PGUSER / DATABRICKS_CLIENT_ID). Locally none are
  // set, so the pool throws and `cache.strictPersistence` silently disables
  // the cache - it never even reaches its CREATE SCHEMA migration, so every
  // persistent read 404s. `getUsernameWithApiLookup` returns PGUSER as-is
  // when already set (no API call), else falls back to `currentUser.me()`.
  const user = await getUsernameWithApiLookup({});
  if (user) process.env.PGUSER ??= user;
  log.info("env updated", { ...redactForLog(resolved), user });

  // Best-effort: grant the resolved role rights on the cache schema when it
  // already exists (CacheManager creates it later, during createApp).
  if (provisionCache) {
    await provisionCacheSchema(log, user);
  }
  return resolved;
}

/** Strip resolved record to log-safe primitive fields. */
function redactForLog(resolved: Resolved): Record<string, unknown> {
  return {
    project: resolved.project,
    branch: resolved.branch,
    endpoint: resolved.endpoint,
    database: resolved.database,
    host: resolved.host,
    port: resolved.port,
    sslMode: resolved.sslMode,
  };
}
