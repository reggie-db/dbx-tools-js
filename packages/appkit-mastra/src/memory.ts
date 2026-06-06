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

import { lakebase } from "@databricks/appkit";
import { logUtils, pluginUtils } from "@dbx-tools/shared";
import { fastembed } from "@mastra/fastembed";
import { Memory } from "@mastra/memory";
import { PgVector, PostgresStore } from "@mastra/pg";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

import type {
  MastraAgentDefinition,
  MastraMemoryConfigOverride,
} from "./agents.js";
import type { MastraPluginConfig } from "./config.js";

const log = logUtils.logger("mastra/memory");

/** Pool handle returned by the AppKit `lakebase` plugin `exports().pool`. */
export type LakebasePool = ReturnType<
  InstanceType<ReturnType<typeof lakebase>["plugin"]>["exports"]
>["pool"];

/** Effective per-knob setting after the plugin/agent cascade. */
type StorageSetting = MastraAgentDefinition["storage"];
type MemorySetting = MastraAgentDefinition["memory"];

/**
 * True when any plugin-level or per-agent setting could need the
 * Lakebase pool. Used by `plugin.ts` to gate pool acquisition; the
 * builder also acquires lazily so missed cases still fail with a
 * clear lakebase-not-registered error.
 */
export function needsLakebase(config: MastraPluginConfig): boolean {
  if (settingNeedsSharedPool(config.storage)) return true;
  if (settingNeedsSharedPool(config.memory)) return true;
  const defs = collectAgentDefinitions(config);
  return defs.some(
    (d) =>
      settingNeedsSharedPool(d.storage) || settingNeedsSharedPool(d.memory),
  );
}

/**
 * Look up the `lakebase` plugin and return its managed `pg.Pool`.
 * Throws when the sibling plugin is not registered; enabling
 * `storage` / `memory` without lakebase is a wiring bug, not a runtime
 * condition we can recover from.
 */
export function resolveLakebasePool(
  context: pluginUtils.PluginContextLike | undefined,
  caller: MastraPluginConfig,
): LakebasePool {
  return pluginUtils.require(context, lakebase, caller).exports().pool;
}

/**
 * Construct a per-agent {@link Memory} factory. Caches the shared
 * `PgVector` singleton (built on first need) and the lazily-resolved
 * Lakebase pool so each agent build is O(1) after the first.
 */
export function createMemoryBuilder(
  config: MastraPluginConfig,
  context: pluginUtils.PluginContextLike | undefined,
): MemoryBuilder {
  return new MemoryBuilder(config, context);
}

/**
 * Builds one `Memory` per agent. Per-instance state keeps the shared
 * `PgVector` and the resolved Lakebase pool alive across calls so
 * registering N agents stays cheap.
 */
export class MemoryBuilder {
  private sharedVector: PgVector | undefined;
  private pool: LakebasePool | undefined;

  constructor(
    private readonly config: MastraPluginConfig,
    private readonly context: pluginUtils.PluginContextLike | undefined,
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
      pool: this.requirePool() as Pool,
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
        ...(vector
          ? { semanticRecall: { topK: 3, messageRange: 2 } }
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
        pool: this.requirePool() as Pool,
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
    if (!setting) return undefined;
    if (typeof setting === "boolean") return this.getSharedVector();
    return buildPgVector(setting);
  }

  private getSharedVector(): PgVector {
    if (!this.sharedVector) {
      this.sharedVector = buildSharedPgVector(this.requirePool());
    }
    return this.sharedVector;
  }

  private requirePool(): LakebasePool {
    if (!this.pool) {
      this.pool = resolveLakebasePool(this.context, this.config);
    }
    return this.pool;
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
function buildSharedPgVector(pool: LakebasePool): PgVector {
  const vector = new PgVector({
    id: `pg${randomUUID()}`,
    host: "-1",
    port: -1,
    database: "_",
    user: "_",
    password: "_",
  });
  const placeholder = vector.pool;
  vector.pool = pool as Pool;
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
function collectAgentDefinitions(
  config: MastraPluginConfig,
): MastraAgentDefinition[] {
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
