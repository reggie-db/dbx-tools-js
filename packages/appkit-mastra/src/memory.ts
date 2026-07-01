/**
 * Lakebase-backed Mastra memory wiring.
 *
 * Provides a {@link MemoryBuilder} that mints one `Memory` per agent
 * with two independent knobs:
 *
 * - **Storage** (threads / messages via `PostgresStore`): defaults to
 *   **per-agent** namespacing via `schemaName: "mastra_<agentId>"` so
 *   conversation history stays isolated between agents in the same
 *   database. `PostgresStore` auto-creates the schema with
 *   `CREATE SCHEMA IF NOT EXISTS` on init.
 * - **Memory** (semantic recall via `PgVector`): defaults to a single
 *   **shared** instance across every agent. Cross-agent recall on one
 *   index is almost always what users want; opt into per-agent recall
 *   by passing a {@link MastraMemoryConfigOverride} on the agent.
 *
 * Additionally, {@link MemoryBuilder.instanceStorage} returns a
 * **Mastra-instance-level** `PostgresStore` (schema `mastra_instance`)
 * used for workflow snapshots - the persistence layer
 * `agent.resumeStream()` reads from when waking a suspended
 * `requireApproval` tool call. Per-agent stores are not enough for
 * this: workflow runs are scoped to the Mastra instance, not an
 * individual agent's `Memory`.
 *
 * Plugin-level `config.storage` / `config.memory` act as the baseline
 * (auto-defaulted to `true` in `plugin.ts` when the `lakebase` plugin
 * is registered); per-agent settings cascade on top of that.
 */

import { getUsernameWithApiLookup } from "@databricks/appkit";
import { logUtils } from "@dbx-tools/shared";
import { fastembed } from "@mastra/fastembed";
import { Memory } from "@mastra/memory";
import { PgVector, PostgresStore } from "@mastra/pg";
import { randomUUID } from "node:crypto";
import { Pool, type PoolConfig } from "pg";

import type { MastraAgentDefinition, MastraMemoryConfigOverride } from "./agents.js";
import type { MastraPluginConfig } from "./config.js";
import { summaryModel, TITLE_INSTRUCTIONS } from "./summarize.js";

const log = logUtils.logger("mastra/memory");

/**
 * Build a dedicated **service-principal** Lakebase pool for Mastra
 * memory from the lakebase plugin's resolved SP pg config.
 *
 * The plugin's `exports().pool` is a `RoutingPool` that switches to
 * the per-user (OBO) pool whenever a query runs inside an `asUser`
 * scope - exactly the context the mastra plugin establishes around
 * every chat turn. Memory (threads / messages + semantic recall) must
 * instead always act as the app service principal: it owns the
 * auto-created `mastra_*` schemas (a per-user role usually can't
 * `CREATE SCHEMA`) and is shared across users, so it cannot inherit a
 * request's OBO identity.
 *
 * `pgConfig` must be the plugin's `exports().getPgConfig()` evaluated
 * **outside** any `asUser` scope (i.e. during setup), so it carries
 * the SP connection target, OAuth token-refresh `password` callback,
 * and any `lakebase({ pool })` tuning overrides - all of which this
 * pool inherits. See the call site in `plugin.ts`.
 */
export async function createServicePrincipalPool(pgConfig: PoolConfig): Promise<Pool> {
  // `getPgConfig()` resolves the SP username synchronously from
  // `PGUSER` / `DATABRICKS_CLIENT_ID`; fall back to the async API
  // lookup (e.g. local dev authenticating via PAT) so the pool always
  // has an identity to connect with.
  const user = pgConfig.user ?? (await getUsernameWithApiLookup());
  return new Pool({ ...pgConfig, user });
}

/** Effective per-knob setting after the plugin/agent cascade. */
type StorageSetting = MastraAgentDefinition["storage"];
type MemorySetting = MastraAgentDefinition["memory"];

/**
 * True when any plugin-level or per-agent setting could need the
 * Lakebase pool. Used by `plugin.ts` to gate creation of the
 * service-principal pool and the {@link MemoryBuilder} that consumes
 * it; when false neither is built.
 */
export function needsLakebase(config: MastraPluginConfig): boolean {
  if (settingNeedsSharedPool(config.storage)) return true;
  if (settingNeedsSharedPool(config.memory)) return true;
  const defs = collectAgentDefinitions(config);
  return defs.some(
    (d) => settingNeedsSharedPool(d.storage) || settingNeedsSharedPool(d.memory),
  );
}

/** Options controlling how {@link MemoryBuilder} resolves each agent's memory. */
export interface MemoryBuilderOptions {
  /**
   * Skip building / attaching `PgVector` (and its `semanticRecall`)
   * for every agent. Set when Databricks Managed Memory is the active
   * long-term backend - it fills the semantic-recall role instead, via
   * the recall input processor and memory tools. Thread / message
   * storage (`PostgresStore`) is unaffected.
   */
  suppressVector?: boolean;
}

/**
 * Construct a per-agent {@link Memory} factory bound to the supplied
 * service-principal pool (see {@link createServicePrincipalPool}).
 * Caches the shared `PgVector` singleton (built on first need) so each
 * agent build is O(1) after the first.
 */
export function createMemoryBuilder(
  config: MastraPluginConfig,
  servicePrincipalPool: Pool,
  options: MemoryBuilderOptions = {},
): MemoryBuilder {
  return new MemoryBuilder(config, servicePrincipalPool, options);
}

/**
 * Builds one `Memory` per agent against a shared service-principal
 * Lakebase pool. Per-instance state keeps the shared `PgVector` alive
 * across calls so registering N agents stays cheap.
 */
export class MemoryBuilder {
  private sharedVector: PgVector | undefined;

  constructor(
    private readonly config: MastraPluginConfig,
    private readonly servicePrincipalPool: Pool,
    private readonly options: MemoryBuilderOptions = {},
  ) {}

  /**
   * Build a `Memory` for `agentId` after the plugin/agent cascade.
   * Returns `undefined` when the agent has neither storage nor a
   * vector store enabled - Mastra accepts a missing `memory` field
   * and treats the agent as stateless.
   */
  /**
   * Build the Mastra-instance-level storage used for workflow
   * snapshots. Returns `undefined` when plugin-level `storage` is
   * disabled, in which case `agent.resumeStream()` (and therefore
   * the `requireApproval` flow) will not be available.
   *
   * The store lives in a dedicated `mastra_instance` schema so it
   * never collides with per-agent `mastra_<agentId>` namespaces.
   * Workflow snapshots are not per-agent state; they belong to the
   * `Mastra` instance that owns the workflow execution.
   */
  instanceStorage(): PostgresStore | undefined {
    const setting = this.config.storage;
    if (!setting) return undefined;
    if (typeof setting === "object") {
      return new PostgresStore(
        withId(setting, "mastra-store__instance") as ConstructorParameters<
          typeof PostgresStore
        >[0],
      );
    }
    return new PostgresStore({
      id: "mastra-store__instance",
      schemaName: "mastra_instance",
      pool: this.servicePrincipalPool,
    });
  }

  forAgent(agentId: string, def: MastraAgentDefinition): Memory | undefined {
    const storageSetting = def.storage ?? this.config.storage;
    const memorySetting = def.memory ?? this.config.memory;

    const storage = this.buildStorage(agentId, storageSetting);
    const vector = this.buildVector(memorySetting);
    if (!storage && !vector) {
      log.debug("agent:stateless", { agentId });
      return undefined;
    }

    log.debug("agent:configured", {
      agentId,
      storage: storage !== undefined,
      vector: vector !== undefined,
      vectorMode:
        vector === undefined
          ? "off"
          : typeof memorySetting === "object"
            ? "dedicated"
            : "shared",
    });

    return new Memory({
      ...(storage ? { storage } : {}),
      ...(vector ? { vector, embedder: fastembed } : {}),
      options: {
        lastMessages: 10,
        ...(vector ? { semanticRecall: { topK: 3, messageRange: 2 } } : {}),
        // Auto-name each thread from its opening turn so the
        // conversation list the UI renders shows meaningful titles
        // instead of raw ids. Titling runs on the small / fast chat
        // tier (see `summarize.ts`) rather than the agent's primary
        // model, so naming a thread never spends the heavyweight model.
        // Only meaningful when storage is on; harmless otherwise.
        ...(storage
          ? {
              generateTitle: {
                model: summaryModel(this.config),
                instructions: TITLE_INSTRUCTIONS,
              },
            }
          : {}),
      },
    });
  }

  private buildStorage(
    agentId: string,
    setting: StorageSetting,
  ): PostgresStore | undefined {
    if (!setting) return undefined;
    if (typeof setting === "boolean") {
      return new PostgresStore({
        id: `mastra-store__${agentId}`,
        schemaName: `mastra_${agentId}`,
        pool: this.servicePrincipalPool,
      });
    }
    // Cast: `withId` guarantees `id` is set, but the distributive
    // Omit + `id?: string` shape doesn't structurally narrow to the
    // discriminated union members. Runtime shape is identical.
    return new PostgresStore(
      withId(setting, `mastra-store__${agentId}`) as ConstructorParameters<
        typeof PostgresStore
      >[0],
    );
  }

  /**
   * Resolve the agent's vector store. Cascade:
   *
   * - falsy: no vector.
   * - `boolean` / `undefined-inheriting-true`: return the shared
   *   singleton (built lazily on first call). All agents that
   *   default-enable memory write into and recall from one index.
   * - object: build a dedicated `PgVector` for this agent.
   */
  private buildVector(setting: MemorySetting): PgVector | undefined {
    // Managed Memory owns the long-term / recall role when active, so
    // skip PgVector entirely regardless of the per-agent / plugin setting.
    if (this.options.suppressVector) return undefined;
    if (!setting) return undefined;
    if (typeof setting === "boolean") return this.getSharedVector();
    return buildPgVector(setting);
  }

  private getSharedVector(): PgVector {
    if (!this.sharedVector) {
      this.sharedVector = buildSharedPgVector(this.servicePrincipalPool);
    }
    return this.sharedVector;
  }
}

/**
 * Build the shared `PgVector` that backs the default
 * `def.memory === true` case across every agent.
 *
 * `PgVector`'s constructor accepts only connection-style configs
 * (`HostConfig` / `ConnectionStringConfig` / `ClientConfig`); there is
 * no `{ pool }` shorthand the way `PostgresStore` has one. Worse, the
 * constructor synchronously kicks off a `cacheWarmupPromise` IIFE that
 * calls `this.pool.connect()` before returning, so we can't cleanly
 * hand it an inert config and patch the pool afterwards.
 *
 * The trick: pass illegal-but-validation-passing placeholders so the
 * warmup's `net.connect()` rejects synchronously with `RangeError`
 * (Node validates `0 <= port < 65536`). The IIFE's `catch {}` swallows
 * it, no DNS lookup or TCP attempt happens, and we then swap
 * `pgVector.pool` to the lakebase pool. Every subsequent `PgVector`
 * method reads `this.pool` at call time, so all real I/O goes through
 * the lakebase pool from then on. The placeholder pool is `.end()`'d
 * so its socket book-keeping is released.
 */
function buildSharedPgVector(pool: Pool): PgVector {
  const vector = new PgVector({
    id: `pg${randomUUID()}`,
    host: "-1",
    port: -1,
    database: "_",
    user: "_",
    password: "_",
  });
  const placeholder = vector.pool;
  vector.pool = pool;
  void placeholder.end().catch(() => undefined);
  return vector;
}

/** Per-agent dedicated `PgVector` (rare; opt-in via object override). */
function buildPgVector(setting: MastraMemoryConfigOverride): PgVector {
  return new PgVector(
    withId(setting, `pg-vector__${randomUUID()}`) as ConstructorParameters<
      typeof PgVector
    >[0],
  );
}

/** True when this setting requires the shared Lakebase pool. */
function settingNeedsSharedPool(
  setting: StorageSetting | MemorySetting | undefined,
): boolean {
  return setting === true;
}

/** Walk the three shapes of `config.agents` into a flat list. */
function collectAgentDefinitions(config: MastraPluginConfig): MastraAgentDefinition[] {
  const agents = config.agents;
  if (!agents) return [];
  if (Array.isArray(agents)) return agents;
  if (typeof (agents as MastraAgentDefinition).instructions === "string") {
    return [agents as MastraAgentDefinition];
  }
  return Object.values(agents as Record<string, MastraAgentDefinition>);
}

/** Fill in a default `id` when the caller didn't supply one. */
function withId<T extends { id?: string }>(value: T, fallback: string): T {
  return value.id ? value : { ...value, id: fallback };
}
