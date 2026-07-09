/**
 * Lakebase cache-schema grant fix-up.
 *
 * AppKit's persistent cache (`CacheManager` -> `PersistentStorage`) uses a
 * schema `appkit` and a table `appkit.appkit_cache_entries`. When the
 * connecting Databricks identity lacks privileges on that schema, the
 * cache migration throws, and because AppKit is typically run with
 * `cache.strictPersistence: true`, the cache is silently switched to a
 * disabled in-memory stub - so every persistent read (chart long-poll,
 * history, etc.) misses and 404s.
 *
 * This grants the connecting role full rights on the cache schema, but
 * only when the schema ALREADY EXISTS - it never creates the schema
 * itself. Run from a LOCAL identity that owns the schema (or holds grant
 * option on it); it is skipped inside a Databricks App, where the app SP
 * cannot grant and its Postgres role does not exist until its first
 * connection.
 *
 * Must run AFTER {@link applyLakebaseToEnv} has written the resolved connection to
 * `process.env` (so `createLakebasePool` picks up host / database /
 * endpoint) and BEFORE `createApp` initializes the cache.
 */

import { createLakebasePool, getWorkspaceClient } from "@databricks/appkit";
import { commonUtils, type logUtils } from "@dbx-tools/shared";

/** AppKit persistent-cache schema (see AppKit's `PersistentStorage`). */
const CACHE_SCHEMA = "appkit";

/**
 * Quote a Postgres identifier: wrap in double quotes and double any
 * embedded quote. Needed because Lakebase role names are often emails
 * (`user@host`) that must be quoted to be valid identifiers.
 */
function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

/**
 * Idempotent grants that make the (already-existing) AppKit cache schema
 * fully usable by `role`. The `ALTER DEFAULT PRIVILEGES` lines cover the
 * cache table whenever the schema owner creates it later.
 */
function cacheGrantStatements(role: string): readonly string[] {
  const schema = quoteIdent(CACHE_SCHEMA);
  const target = quoteIdent(role);
  return [
    `GRANT USAGE, CREATE ON SCHEMA ${schema} TO ${target}`,
    `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema} TO ${target}`,
    `GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schema} TO ${target}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT ALL ON TABLES TO ${target}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT ALL ON SEQUENCES TO ${target}`,
  ];
}

/**
 * Grant `role` rights on the AppKit cache schema, but only when that
 * schema already exists.
 *
 * No-ops inside a Databricks App env, when `role` is undefined, or when
 * the schema is absent. Best-effort otherwise: any failure (e.g. the local
 * identity doesn't own the schema) is logged and swallowed so it never
 * blocks startup - a disabled cache is degraded, not fatal.
 *
 * @param role - Postgres role to grant to and connect as (the resolved
 *   workspace-client identity); skips when undefined.
 */
export async function provisionCacheSchema(
  log: logUtils.Logger,
  role: string | undefined,
): Promise<void> {
  if (commonUtils.isDatabricksAppEnv()) {
    log.debug("autopg: skip cache provisioning (inside a Databricks App)");
    return;
  }
  if (!role) {
    log.warn("autopg: skip cache provisioning (could not resolve connecting role)");
    return;
  }
  // Pass `user` explicitly: autopg resolves the connection target
  // (host/database/endpoint) but not the identity, so `createLakebasePool`'s
  // synchronous username lookup would otherwise throw. `getWorkspaceClient({})`
  // returns a fresh default-auth client - literally `new WorkspaceClient({})`,
  // but built against the SDK version AppKit's `createLakebasePool` expects
  // (importing the SDK class directly here pulls a newer, type-incompatible
  // copy).
  const pool = createLakebasePool({
    user: role,
    workspaceClient: getWorkspaceClient({}),
  });
  try {
    const found = await pool.query(
      "SELECT 1 FROM information_schema.schemata WHERE schema_name = $1",
      [CACHE_SCHEMA],
    );
    if (found.rowCount === 0) {
      log.debug("autopg: skip cache provisioning (schema absent)", {
        schema: CACHE_SCHEMA,
      });
      return;
    }
    for (const sql of cacheGrantStatements(role)) {
      await pool.query(sql);
    }
    log.info("autopg: granted cache schema", { schema: CACHE_SCHEMA, role });
  } catch (err) {
    log.warn("autopg: cache provisioning failed (continuing)", {
      schema: CACHE_SCHEMA,
      error: commonUtils.errorMessage(err),
    });
  } finally {
    await pool.end().catch(() => {});
  }
}
