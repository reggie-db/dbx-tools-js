import type { BasePluginConfig } from "@databricks/appkit";
import type { Memory } from "mem0ai/oss";

// Public types for the dbx-tools plugin. Wire-format types live in
// @dbx-tools/appkit-genie-shared so the UI package can consume them
// without pulling Node-only server deps.
export type {
  ToolProgressEvent,
  ToolProgressPhase,
} from "@dbx-tools/appkit-genie-shared";

/**
 * Per-call user-id resolver. Returns the identifier mem0 should scope
 * memories by - typically the current request's user from
 * `getExecutionContext()`. Returning `undefined` keeps the memory un-
 * scoped (mem0 will reject the call), so consumers usually want a
 * fallback (e.g. `"default"`) baked in.
 */
export type MemoryUserResolver = () => string | undefined;

/**
 * Memory subtree of the dbx-tools plugin config. When `enabled` is left
 * unset, memory tools auto-wire iff the `lakebase` plugin is registered.
 * Most fields mirror `mem0ai/oss` config keys so callers can drop in
 * existing memory configs.
 */
export interface IDbxToolsMemoryConfig {
  /** Disable memory tools even if lakebase is present. Default: auto. */
  enabled?: boolean;
  /**
   * Embedder used by mem0 to vectorize new memories. Defaults to the
   * Databricks Foundation Model API's open-source GTE-Large endpoint
   * (`databricks-gte-large-en`, 1024 dims) hit via mem0's `openai`
   * provider with `baseURL` pointed at the workspace's
   * `/serving-endpoints` and an OAuth-minted bearer for `apiKey`.
   *
   * Override to use any OpenAI-compatible endpoint. If you override,
   * also set `embeddingModelDims` to match - the default of 1024 only
   * lines up with the Databricks GTE default.
   */
  embedder?: { provider: string; config: Record<string, unknown> };
  /**
   * LLM used by mem0's memory-extraction / dedup pipeline. Defaults to
   * the Databricks Foundation Model API's open-source Llama-3.3 70B
   * Instruct endpoint (`databricks-meta-llama-3-3-70b-instruct`) hit via
   * mem0's `openai` provider with `baseURL` pointed at the workspace's
   * `/serving-endpoints` and an OAuth-minted bearer for `apiKey`.
   *
   * The bearer is captured at `setup:complete` time and isn't refreshed
   * for the lifetime of the process. For long-running deployments where
   * OAuth tokens expire (typically 1hr), override this with non-expiring
   * credentials (PAT or service-principal M2M).
   */
  llm?: { provider: string; config: Record<string, unknown> };
  /**
   * pgvector collection (table) name. Default: `"memories"`. Will be
   * created on first use if it doesn't already exist on the wired
   * Lakebase endpoint.
   */
  collectionName?: string;
  /**
   * Embedding dimension. Default: `1024` (matches the default
   * `databricks-gte-large-en` embedder). Must match whatever embedder
   * you wire - the pgvector collection's `vector(N)` column is sized
   * to this value at first-use.
   */
  embeddingModelDims?: number;
  /**
   * Resolver for the per-call user identifier passed to mem0 as
   * `userId`. Default: pulls `userId` off `getExecutionContext()` when
   * in a UserContext, falling back to `"default"`.
   */
  resolveUser?: MemoryUserResolver;
}

/** Configuration shape accepted by `dbxTools(config)`. */
export interface IDbxToolsConfig extends BasePluginConfig {
  memory?: IDbxToolsMemoryConfig;
}

/**
 * Memory wiring captured during setup when the lakebase plugin is
 * registered. The plugin owns the `Memory` instance for its lifetime;
 * consumers shouldn't construct their own.
 *
 * `getMemory` is a lazy resolver because the actual `Memory` instance
 * can't be constructed until lakebase's `pg.Pool` exists, and lakebase's
 * pool isn't created until its `setup()` runs - which races with our
 * own `setup()` via AppKit's `Promise.all`. Memory tool entries are
 * registered synchronously (so the agents plugin sees them), and they
 * call `getMemory()` at execution time, by which point the
 * `setup:complete` lifecycle hook has constructed the instance.
 */
export interface MemoryWiring {
  getMemory: () => Memory;
  collectionName: string;
  resolveUser: MemoryUserResolver;
}

/**
 * Loose shape of the events the genie plugin's `sendMessage` AsyncGenerator
 * yields. We intentionally don't import the internal `GenieStreamEvent` type;
 * declaring just the discriminants we react to keeps the dependency footprint
 * stable across appkit versions.
 */
export interface GenieEventLike {
  type: string;
  status?: string;
  messageId?: string;
  conversationId?: string;
  spaceId?: string;
  attachmentId?: string;
  statementId?: string;
  message?: {
    content?: string;
    status?: string;
    attachments?: unknown[];
  };
  error?: string;
}

/**
 * AsyncGenerator the genie plugin exports as `sendMessage`. Auto-wired from
 * the registered `genie` plugin instance during `setup()`; consumers can
 * also call `appkit.dbxTools.wireGenie(alias, fn)` manually to register a
 * custom sender (e.g. a mock in tests, or a wrapper that injects context).
 */
export type GenieSendMessage = (
  alias: string,
  content: string,
  conversationId?: string,
  options?: { timeout?: number; signal?: AbortSignal },
) => AsyncGenerator<GenieEventLike>;

/** Per-alias genie wiring registered via auto-wire or `plugin.wireGenie(...)`. */
export interface GenieWiring {
  alias: string;
  sendMessage: GenieSendMessage;
}
