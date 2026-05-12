import type { Pool } from "pg";
import {
  PGVector,
  VectorStoreFactory,
  type VectorStore,
  type VectorStoreConfig,
} from "mem0ai/oss";

// Lakebase-aware mem0 pgvector store. Replaces the bundled `PGVector`'s
// constructor-time `pg.Client` with a `pg.Pool` from the lakebase plugin,
// which gives us OAuth token refresh on every new connection (the bundled
// store opens one long-lived Client and never re-authenticates). Also skips
// the bundled `_doInitialize` "connect to `postgres` db -> CREATE DATABASE"
// path which fails on Lakebase (the role can't connect to a database named
// literally `postgres` and lacks CREATEDB).
//
// We subclass instead of forking so that future mem0 patches to the
// underlying query methods (search/insert/update/delete/list/get) flow
// through unchanged - those all just call `this.client.query(...)`, and
// `pg.Pool.query` is shape-compatible with `pg.Client.query`.

/**
 * Config key that triggers the Lakebase-backed override. Set on the
 * mem0 vectorStore config: `{ provider: "pgvector", config: { connectionPool: pool, ... } }`.
 * The factory patch installed by {@link installPgVectorPoolPatch} checks
 * for this key before substituting our subclass; configs without it fall
 * through to the original `VectorStoreFactory.create`.
 */
export const CONNECTION_POOL_KEY = "connectionPool" as const;

/** Shape of the mem0 pgvector config that opts into the Lakebase path. */
export interface LakebasePGVectorConfig extends VectorStoreConfig {
  /** Reuse this pool (which carries OAuth-refreshing credentials). */
  [CONNECTION_POOL_KEY]: Pool;
  collectionName?: string;
  embeddingModelDims?: number;
  diskann?: boolean;
  hnsw?: boolean;
}

// Internal view of the bundled PGVector's private fields. mem0 declares
// them `private` in d.ts but they're regular own-properties at runtime.
interface _PGVectorInternals {
  client: { query: Pool["query"]; end: Pool["end"] };
  collectionName: string;
  useDiskann: boolean;
  useHnsw: boolean;
  dbName: string;
  config: { embeddingModelDims?: number };
  _initPromise?: Promise<void>;
}

/**
 * Subclass of mem0's `PGVector` that drives queries through a `pg.Pool`
 * instead of the bundled long-lived `pg.Client`. The lakebase plugin's
 * pool calls its password resolver on every new physical connection, so
 * OAuth token refresh works for the lifetime of the host process.
 *
 * Construction-time caveats and how this class navigates them:
 *
 * - The parent constructor synchronously builds a throwaway `pg.Client`
 *   (we never let it connect) and kicks `this.initialize().catch(...)`.
 *   We override `initialize()` to short-circuit so the parent's
 *   `_doInitialize` (which does `CREATE DATABASE` on a db the role can't
 *   reach) never runs.
 * - JS class construction order means the parent's constructor body
 *   runs before our subclass field initializers. We carry no instance
 *   state into `initialize()` - it just sticky-sets `_initPromise` to
 *   a resolved promise on first invocation, then our subclass body (after
 *   `super(...)` returns) re-points `_initPromise` at the real
 *   pool-driven init and swaps `client` for the pool.
 */
export class LakebasePGVector extends PGVector {
  constructor(config: LakebasePGVectorConfig) {
    // Pass dummy connection params: the parent constructor will build a
    // pg.Client with these values but our overridden `initialize()` keeps
    // it from ever being `.connect()`'d. The Client object is created
    // and immediately orphaned (GC'd once we swap `this.client` below).
    super({
      user: "_unused_lakebase_override",
      password: "_unused_lakebase_override",
      host: "_unused_lakebase_override",
      port: 0,
      embeddingModelDims: config.embeddingModelDims ?? 1536,
      collectionName: config.collectionName,
      // Force the bundled `dbName` validator to accept a sentinel - we never
      // actually use it because our init bypasses the database-switching
      // dance in `_doInitialize`.
      dbname: "lakebase_override",
      diskann: config.diskann ?? false,
      hnsw: config.hnsw ?? false,
    });

    const pool = config[CONNECTION_POOL_KEY];
    const internals = this as unknown as _PGVectorInternals;
    // Replace the bundled long-lived Client with the lakebase Pool. Every
    // subsequent `this.client.query(...)` (search/insert/update/delete/
    // list/get/keywordSearch) gets a freshly-authenticated connection
    // from the pool, which re-invokes lakebase's password resolver.
    internals.client = pool;
    // Re-point `_initPromise` at a real pool-driven setup. The parent's
    // sticky no-op `initialize()` already set this to `Promise.resolve()`;
    // overwriting it here is safe because no Memory code path has had a
    // chance to `await` it yet (the parent's constructor finished and our
    // subclass body is running synchronously).
    internals._initPromise = this._initOnPool(pool);
  }

  /**
   * Sticky no-op. The parent's constructor calls `this.initialize()`
   * synchronously - virtual dispatch means OUR override runs. Setting
   * `_initPromise` to a resolved promise short-circuits the parent's
   * `_doInitialize` which tries to `CREATE DATABASE` on Lakebase. The
   * subclass constructor body then overwrites `_initPromise` with the
   * real pool-driven init (see `_initOnPool`).
   */
  override async initialize(): Promise<void> {
    const internals = this as unknown as _PGVectorInternals;
    if (!internals._initPromise) {
      internals._initPromise = Promise.resolve();
    }
    return internals._initPromise;
  }

  private async _initOnPool(pool: Pool): Promise<void> {
    const internals = this as unknown as _PGVectorInternals;
    const collection = internals.collectionName;
    const dims = Math.floor(internals.config.embeddingModelDims ?? 1536);

    // pgvector extension. Lakebase Postgres ships with the extension
    // available but it has to be enabled per-database. Idempotent.
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");

    // mem0's bookkeeping table. Holds a single self-generated user id
    // that the Memory class uses for telemetry / migrations. Schema
    // copied verbatim from mem0's bundled PGVector so existing rows
    // stay compatible.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS memory_migrations (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE
      )
    `);

    // The collection table. mem0's bundled PGVector uses identifier
    // interpolation here (no escapeIdentifier) so we have to match its
    // behavior to stay compatible with the hot-path queries that do the
    // same thing. `collection` comes from the plugin config (or the
    // default `memories`), never from user input.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${collection} (
        id UUID PRIMARY KEY,
        vector vector(${dims}),
        payload JSONB
      )
    `);

    if (internals.useDiskann && dims < 2000) {
      try {
        const result = await pool.query(
          "SELECT 1 FROM pg_extension WHERE extname = 'vectorscale'",
        );
        if (result.rows.length > 0) {
          await pool.query(`
            CREATE INDEX IF NOT EXISTS ${collection}_diskann_idx
            ON ${collection}
            USING diskann (vector)
          `);
        }
      } catch (error) {
        console.warn("DiskANN index creation failed:", error);
      }
    } else if (internals.useHnsw) {
      try {
        await pool.query(`
          CREATE INDEX IF NOT EXISTS ${collection}_hnsw_idx
          ON ${collection}
          USING hnsw (vector vector_cosine_ops)
        `);
      } catch (error) {
        console.warn("HNSW index creation failed:", error);
      }
    }
  }

  /**
   * No-op: the pool is owned by the lakebase plugin and ending it would
   * close every Lakebase connection across the whole app. Memory.reset()
   * eventually calls back here; ignore.
   */
  override async close(): Promise<void> {
    // intentionally empty
  }
}

// Module-level latch so the factory monkey-patch is idempotent across
// plugin restarts (hot reload, multiple `installPgVectorPoolPatch()` calls
// from tests, etc.).
let _patched = false;

/**
 * Monkey-patch `VectorStoreFactory.create` to substitute
 * {@link LakebasePGVector} for the bundled `PGVector` whenever the
 * provided config carries a {@link CONNECTION_POOL_KEY} field. Configs
 * without the marker fall through to the original factory unchanged,
 * so non-Lakebase mem0 deployments in the same process keep working.
 *
 * Safe to call multiple times - subsequent invocations are no-ops.
 */
export function installPgVectorPoolPatch(): void {
  if (_patched) return;
  _patched = true;

  type FactoryCreate = (provider: string, config: VectorStoreConfig) => VectorStore;
  const factory = VectorStoreFactory as unknown as {
    create: FactoryCreate;
  };
  const originalCreate = factory.create.bind(VectorStoreFactory);

  factory.create = (provider: string, config: VectorStoreConfig): VectorStore => {
    if (
      provider.toLowerCase() === "pgvector" &&
      (config as Partial<LakebasePGVectorConfig>)[CONNECTION_POOL_KEY]
    ) {
      return new LakebasePGVector(config as LakebasePGVectorConfig);
    }
    return originalCreate(provider, config);
  };
}
