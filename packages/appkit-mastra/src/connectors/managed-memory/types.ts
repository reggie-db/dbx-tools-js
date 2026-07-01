/**
 * Type contract for the Databricks Managed Agent Memory connector.
 *
 * Managed Memory is a Beta Unity Catalog feature (REST-only, no TS
 * SDK yet) that stores long-term agent memories as scoped entries in a
 * UC `memory-store`. In `@dbx-tools/appkit-mastra` it plays the role
 * the Postgres `PgVector` semantic-recall layer otherwise fills: an
 * auto-recall input processor reads the user's top entries before each
 * turn, and `save_memory` / `search_memory` tools let the agent persist
 * and look up durable facts. Every read / write is scoped to the OBO
 * user id resolved in trusted server code - the model never sets scope.
 */

/**
 * Caller-facing configuration for the managed-memory backend, set via
 * {@link MastraPluginConfig.managedMemory}. Every field is optional;
 * the object form only needs to override what differs from the
 * connector defaults.
 */
export interface ManagedMemoryConfig {
  /**
   * Three-level Unity Catalog name of the memory store
   * (`catalog.schema.name`). Falls back to the `MEMORY_STORE` env var
   * when omitted. Required (here or in env) whenever managed memory is
   * explicitly enabled; in prefer-if-available mode its absence simply
   * leaves managed memory off.
   */
  store?: string;
  /** Description stamped on the store when {@link autoCreate} creates it. */
  description?: string;
  /**
   * Number of entries the recall processor injects and `search_memory`
   * returns by default. Defaults to {@link DEFAULT_TOPK}.
   */
  topK?: number;
  /**
   * Create the store at setup when it doesn't exist (requires
   * `CREATE MEMORY STORE` on the schema). Defaults to `true`; set
   * `false` to require the store be provisioned out of band.
   */
  autoCreate?: boolean;
  /**
   * Attach the auto-recall input processor that injects the user's
   * top entries before each turn. Defaults to `true`.
   */
  recall?: boolean;
  /**
   * Expose the `save_memory` / `search_memory` ambient tools to every
   * agent. Defaults to `true`.
   */
  tools?: boolean;
  /**
   * Entry path new `save_memory` writes land under. Defaults to
   * {@link DEFAULT_ENTRY_PATH}. Managed Memory keys entries by path
   * within a scope, so a stable path accumulates notes for a user.
   */
  entryPath?: string;
}

/**
 * A single memory entry as returned by the search endpoint. Fields
 * mirror the UC memory-store wire shape but are all optional except
 * `contents` because the Beta API surface may still drift.
 */
export interface MemoryEntry {
  /** Entry path within the scope (e.g. `/memories/notes.md`). */
  path?: string;
  /** Entry body - the recalled text. */
  contents: string;
  /** Optional one-line summary of the entry. */
  description?: string;
  /** Relevance score from the search ranker, when present. */
  score?: number;
}

/**
 * Resolved managed-memory runtime handed to the tools and recall
 * processor when managed memory is the active long-term backend.
 * Built once at setup after the capability probe succeeds; carries the
 * store target and recall sizing, not the workspace client (that is
 * resolved per-request from the OBO execution context).
 */
export interface ManagedMemoryRuntime {
  /** Three-level UC name of the resolved store. */
  storeName: string;
  /** Entries to recall / return per call. */
  topK: number;
  /** Default path for `save_memory` writes. */
  entryPath: string;
  /** Whether to expose the `save_memory` / `search_memory` tools. */
  tools: boolean;
  /** Whether to attach the auto-recall input processor. */
  recall: boolean;
}
