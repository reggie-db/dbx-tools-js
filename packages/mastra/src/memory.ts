/**
 * Lakebase-backed Mastra memory wiring.
 *
 * Builds a `Memory` whose `PostgresStore` and `PgVector` share the pg
 * pool exposed by the sibling `lakebase` AppKit plugin. Callers either
 * set `storage`/`memory` to `true` (use the lakebase pool) or pass a
 * standalone Postgres/PgVector config object.
 */

import { lakebase } from "@databricks/appkit";
import { pluginUtils } from "@dbx-tools/appkit-shared";
import { fastembed } from "@mastra/fastembed";
import { Memory } from "@mastra/memory";
import { PgVector, PostgresStore } from "@mastra/pg";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

import type { MastraPluginConfig } from "./config.js";

/** Pool handle returned by the AppKit `lakebase` plugin `exports().pool`. */
export type LakebasePool = ReturnType<
  InstanceType<ReturnType<typeof lakebase>["plugin"]>["exports"]
>["pool"];

/** True when either storage or memory is enabled in the plugin config. */
export function needsLakebase(config: MastraPluginConfig): boolean {
  return config.storage || config.memory ? true : false;
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
  return pluginUtils.requirePlugin(context, lakebase, caller).exports().pool;
}

/**
 * Build a Mastra `Memory` for the given config, reusing the supplied
 * lakebase pool when sub-features are set to `true`. Returns
 * `undefined` when neither storage nor memory is enabled.
 */
export function buildMemory(
  config: MastraPluginConfig,
  pool: LakebasePool,
): Memory | undefined {
  if (!needsLakebase(config)) return undefined;
  return new Memory({
    storage: pgStore(config, pool),
    vector: pgVector(config, pool),
    embedder: fastembed,
    options: {
      lastMessages: 10,
      semanticRecall: {
        topK: 3,
        messageRange: 2,
      },
    },
  });
}

function pgStore(
  config: MastraPluginConfig,
  pool: LakebasePool,
): PostgresStore | undefined {
  if (!config.storage) return undefined;
  if (typeof config.storage === "boolean") {
    if (!pool) {
      throw new Error("mastra: lakebase pool missing for storage");
    }
    return new PostgresStore({ id: "mastra-store", pool: pool as Pool });
  }
  return new PostgresStore(config.storage);
}

/**
 * Build a `PgVector` that delegates to the lakebase plugin's pool.
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
function pgVector(
  config: MastraPluginConfig,
  pool: LakebasePool,
): PgVector | undefined {
  if (!config.memory) return undefined;
  if (typeof config.memory === "boolean") {
    if (!pool) {
      throw new Error("mastra: lakebase pool missing for memory");
    }
    const vector = new PgVector({
      id: "pg" + randomUUID(),
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
  return new PgVector(config.memory);
}
