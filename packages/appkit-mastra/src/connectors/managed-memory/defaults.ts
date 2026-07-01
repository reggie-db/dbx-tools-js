/**
 * Default values and environment variable names for the managed-memory
 * connector. Kept in a leaf module so the client, tools, recall
 * processor, and plugin setup can share them without a cycle.
 */

/**
 * Environment variable holding the three-level Unity Catalog store name
 * (`catalog.schema.name`). Read when {@link ManagedMemoryConfig.store}
 * is omitted; also the sole enable signal in prefer-if-available mode
 * (managed memory stays off when it is unset).
 */
export const MEMORY_STORE_ENV = "MEMORY_STORE";

/**
 * Default number of entries the recall processor injects and
 * `search_memory` returns. Matches the prior `PgVector`
 * `semanticRecall.topK` so behavior is unchanged after the swap.
 */
export const DEFAULT_TOPK = 3;

/**
 * Default path `save_memory` writes land under. Managed Memory keys
 * entries by path within a scope, so a single stable path accumulates a
 * user's notes rather than scattering them.
 */
export const DEFAULT_ENTRY_PATH = "/memories/notes.md";

/** Description stamped on the store when the connector auto-creates it. */
export const DEFAULT_STORE_DESCRIPTION =
  "Long-term agent memory managed by @dbx-tools/appkit-mastra.";
