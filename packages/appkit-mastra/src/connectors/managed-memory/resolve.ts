/**
 * Setup-time resolution of the managed-memory backend decision from
 * plugin config and environment. Pure (no I/O) so it is easy to unit
 * test; the capability probe and store auto-create happen in
 * `plugin.ts` against the result of {@link resolveManagedMemoryTarget}.
 *
 * Enable semantics:
 * - `managedMemory: false` (or omitted setting + no `MEMORY_STORE`):
 *   disabled. The Postgres `PgVector` path is used as before.
 * - `managedMemory: undefined` with `MEMORY_STORE` set
 *   (prefer-if-available): enabled, store from env.
 * - `managedMemory: true`: enabled; store must come from `MEMORY_STORE`
 *   (a missing store is a setup error).
 * - `managedMemory: { store, ... }`: enabled; store from `store` or
 *   `MEMORY_STORE` (a missing store is a setup error).
 */

import type { MastraPluginConfig } from "../../config.js";
import {
  DEFAULT_ENTRY_PATH,
  DEFAULT_STORE_DESCRIPTION,
  DEFAULT_TOPK,
  MEMORY_STORE_ENV,
} from "./defaults.js";
import type { ManagedMemoryConfig } from "./types.js";

/**
 * Fully-resolved managed-memory target: everything `plugin.ts` needs to
 * probe the API, optionally create the store, and (on success) build
 * the runtime / tools / recall processor.
 */
export interface ManagedMemoryTarget {
  storeName: string;
  description: string;
  topK: number;
  entryPath: string;
  autoCreate: boolean;
  recall: boolean;
  tools: boolean;
}

/**
 * Resolve the managed-memory target from config + env, or `null` when
 * managed memory is disabled. Throws when explicitly enabled but no
 * store name can be resolved (config or `MEMORY_STORE`), so a
 * misconfiguration surfaces at setup rather than silently falling back.
 */
export function resolveManagedMemoryTarget(
  config: MastraPluginConfig,
): ManagedMemoryTarget | null {
  const setting = config.managedMemory;
  if (setting === false) return null;

  const envStore = trimmedEnv(MEMORY_STORE_ENV);
  const obj: ManagedMemoryConfig = typeof setting === "object" ? setting : {};
  const explicit = setting === true || typeof setting === "object";

  // Prefer-if-available (setting undefined): only enable when a store is
  // configured via env. No env, no managed memory - fall back silently.
  if (!explicit && !envStore) return null;

  const storeName = trimmed(obj.store) ?? envStore;
  if (!storeName) {
    throw new Error(
      `mastra: managedMemory is enabled but no store name is set. ` +
        `Set managedMemory.store or the ${MEMORY_STORE_ENV} env var to a ` +
        `three-level Unity Catalog name (catalog.schema.name).`,
    );
  }

  return {
    storeName,
    description: trimmed(obj.description) ?? DEFAULT_STORE_DESCRIPTION,
    topK: obj.topK ?? DEFAULT_TOPK,
    entryPath: trimmed(obj.entryPath) ?? DEFAULT_ENTRY_PATH,
    autoCreate: obj.autoCreate ?? true,
    recall: obj.recall ?? true,
    tools: obj.tools ?? true,
  };
}

/** Trimmed env var value, or undefined when unset / blank. */
function trimmedEnv(name: string): string | undefined {
  return trimmed(process.env[name]);
}

/** Trimmed string, or undefined when undefined / blank. */
function trimmed(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t === "" ? undefined : t;
}
