import {
  getExecutionContext,
  Plugin,
  toPlugin,
  type IAppRouter,
  type PluginManifest,
} from "@databricks/appkit";
import {
  executeFromRegistry,
  toolsFromRegistry,
  type AgentToolDefinition,
  type ToolkitEntry,
  type ToolkitOptions,
  type ToolRegistry,
} from "@databricks/appkit/beta";
import { Memory } from "mem0ai/oss";
import type { Pool } from "pg";
import { installAdapterPatch, SKIP_TEXT_FALLBACK_KEY } from "./adapter.js";
import manifest from "./manifest.json" with { type: "json" };
import {
  DATABRICKS_FM_API_KEY,
  installDatabricksLlmPatch,
} from "./memory-llm.js";
import {
  CONNECTION_POOL_KEY,
  installPgVectorPoolPatch,
} from "./memory-pgvector.js";
import { ToolProgressBus } from "./progress-bus.js";
import { progressSseHandler } from "./routes.js";
import { buildToolRegistry } from "./tools.js";
import type {
  GenieSendMessage,
  GenieWiring,
  IDbxToolsConfig,
  MemoryWiring,
  ToolProgressEvent,
} from "./types.js";

// Reusable agent tools for AppKit apps. Exposes one tool per Genie space the
// `genie` plugin is configured with, and streams phase updates onto an
// in-process event bus so the chat UI can render live "Submitted -> Executing
// SQL -> Completed" status under the running tool-call card.
//
// AppKit's `agents` plugin reads our `ToolRegistry` during its own (deferred-
// phase) `setup()`, so the auto-wire and registry build have to be complete
// SYNCHRONOUSLY by the time our `setup()` returns control. We do both up
// front, before any awaits, so the registry is ready the moment the agents
// plugin invokes `tools(plugins)`.

// Minimal structural type for the genie plugin instance we read during
// setup. The genie plugin's `config.spaces` is `protected`, so we access it
// via a cast rather than depending on internal types.
interface GenieLike {
  sendMessage: GenieSendMessage;
  config?: { spaces?: Record<string, string | undefined> };
}

// Minimal structural type for the lakebase plugin's exports() result.
// We resolve this AT setup:complete time, after lakebase has finished
// its own setup() and the pool is live.
interface LakebaseExports {
  pool: Pool;
}

interface LakebasePluginWithExports {
  exports(): LakebaseExports;
}

export class DbxTools extends Plugin<IDbxToolsConfig> {
  static manifest = manifest as unknown as PluginManifest<"dbx-tools">;

  private readonly progress = new ToolProgressBus();
  private readonly wirings = new Map<string, GenieWiring>();
  private memoryWiring?: MemoryWiring;
  private memory?: Memory;
  private tools: ToolRegistry = {};

  override async setup(): Promise<void> {
    // Synchronously auto-wire upstream plugins and build the tool
    // registry. Both happen before this function yields so the registry
    // is populated by the time the deferred-phase agents plugin's
    // `setup()` reads our tools via `getAgentTools()` / `toolkit()`.
    //
    // Memory wiring is split: the tool ENTRIES are registered here
    // (synchronously, since we only need to know lakebase is in the
    // plugins list, not that its setup has finished); the actual
    // `Memory` instance is constructed in the `setup:complete`
    // lifecycle handler below, after lakebase's setup() has populated
    // its `pg.Pool`. The tool entries resolve the Memory lazily via
    // `wiring.getMemory()` at execution time.
    this._autoWireGenie();
    this._reserveMemoryWiring();
    this._rebuildToolRegistry();

    // Construct the Memory after every plugin's setup() resolves.
    // AppKit emits `setup:complete` once Promise.all over all setups
    // resolves and before serverPlugin.start(), so by the time any
    // HTTP request fires a tool call the Memory instance is live.
    // The hook is async because it has to mint a Databricks token + read
    // the workspace host to default mem0's embedder + LLM at the
    // workspace's `/serving-endpoints` (Foundation Model API).
    this.context?.onLifecycle("setup:complete", async () => {
      await this._buildMemoryInstance();
    });

    // Patch `DatabricksAdapter.prototype.run` to skip its text-tool-call
    // fallback whenever any tool in `input.tools` carries the
    // `SKIP_TEXT_FALLBACK_KEY` marker we stamp onto our tool defs (see
    // `_buildToolkitEntries`). Other agents (different model adapters, or
    // models that genuinely need the text fallback like Llama variants)
    // see the original run() unchanged. Idempotent across plugin restarts.
    installAdapterPatch();
  }

  private _autoWireGenie(): void {
    const ctx = this.context;
    if (!ctx?.hasPlugin("genie")) return;

    const geniePlugin = ctx.getPlugins().get("genie") as
      | (GenieLike & { sendMessage: GenieSendMessage })
      | undefined;
    if (!geniePlugin || typeof geniePlugin.sendMessage !== "function") return;

    const spaces = geniePlugin.config?.spaces ?? {};
    const aliases = Object.keys(spaces);
    if (aliases.length === 0) return;

    const sender = geniePlugin.sendMessage.bind(geniePlugin);
    for (const alias of aliases) {
      // Manual wires win over auto-wires so consumers can override (e.g. a
      // wrapper that injects extra telemetry around sendMessage).
      if (!this.wirings.has(alias)) {
        this.wirings.set(alias, { alias, sendMessage: sender });
      }
    }
  }

  /**
   * Synchronously reserves the memory tool wiring if the lakebase plugin
   * is in the app's plugins list. This populates `this.memoryWiring`
   * with a wiring whose `getMemory()` defers to `this.memory`, which is
   * only assigned later (in `_buildMemoryInstance` during the
   * `setup:complete` lifecycle hook).
   *
   * Splitting reservation from construction is necessary because:
   * 1. AppKit's agents plugin reads our tool registry during its own
   *    `setup()`, which races with lakebase's `setup()` via Promise.all.
   * 2. Lakebase's `pg.Pool` doesn't exist until its `setup()` finishes.
   * 3. The tool entries themselves can be registered cheaply against
   *    the lazy resolver; only their execute calls need the live pool.
   */
  private _reserveMemoryWiring(): void {
    const memoryConfig = this.config.memory ?? {};
    if (memoryConfig.enabled === false) return;

    const ctx = this.context;
    if (!ctx?.hasPlugin("lakebase")) {
      if (memoryConfig.enabled === true) {
        throw new Error(
          "dbx-tools memory tools require the `lakebase` plugin to be " +
            "registered. Add `lakebase()` to your AppKit plugins list, " +
            "or set `memory.enabled: false` to disable memory tools.",
        );
      }
      return;
    }

    const collectionName = memoryConfig.collectionName ?? "memories";
    const resolveUser = memoryConfig.resolveUser ?? _defaultResolveUser;

    this.memoryWiring = {
      collectionName,
      resolveUser,
      getMemory: () => {
        if (!this.memory) {
          throw new Error(
            "dbx-tools memory tools were invoked before the `setup:complete` " +
              "lifecycle hook ran. This usually means the lakebase plugin " +
              "failed to initialize - check the startup logs for errors.",
          );
        }
        return this.memory;
      },
    };
  }

  /**
   * Builds the mem0 `Memory` instance against the live lakebase pool.
   * Invoked from the `setup:complete` lifecycle hook, by which point
   * lakebase has finished `setup()` and its `exports().pool` returns a
   * connected `pg.Pool`. After this runs, `memoryWiring.getMemory()`
   * returns the live instance.
   *
   * Embedder + LLM default to Databricks Foundation Model serving
   * (`/serving-endpoints` on the workspace host) using the open-source
   * `databricks-gte-large-en` embedder and `databricks-meta-llama-3-3-
   * 70b-instruct` LLM. The serving endpoint is OpenAI-compatible, so
   * we plumb it through mem0's existing `openai` provider with a
   * Databricks-minted bearer token. Consumers can override via
   * `memory.embedder` / `memory.llm` to point at OpenAI proper or a
   * custom endpoint.
   */
  private async _buildMemoryInstance(): Promise<void> {
    if (!this.memoryWiring) return;

    const ctx = this.context;
    const lakebasePlugin = ctx?.getPlugins().get("lakebase") as
      | LakebasePluginWithExports
      | undefined;
    if (!lakebasePlugin || typeof lakebasePlugin.exports !== "function") {
      return;
    }
    const pool = lakebasePlugin.exports().pool;
    if (!pool) return;

    // Install the factory patches BEFORE constructing the Memory. Both
    // are idempotent and only substitute their respective subclasses
    // when the mem0 config carries a marker key (so non-Databricks
    // deployments in the same process keep working).
    //
    // - `installPgVectorPoolPatch` swaps mem0's bundled `PGVector`
    //   (long-lived `pg.Client`, `CREATE DATABASE` flow) for our
    //   `LakebasePGVector` (pool-backed, skips the db-create dance).
    // - `installDatabricksLlmPatch` swaps mem0's bundled `OpenAILLM`
    //   for `DatabricksFmApiLLM` (drops `response_format`, which
    //   Databricks Foundation Model endpoints reject when the user
    //   message doesn't contain the substring "json").
    installPgVectorPoolPatch();
    installDatabricksLlmPatch();

    const memoryConfig = this.config.memory ?? {};
    const collectionName = this.memoryWiring.collectionName;

    // Resolve Databricks defaults once. The OAuth bearer it returns is
    // a one-shot token (no refresh) because mem0's `openai` provider
    // bakes the apiKey into `new OpenAI(...)` at construction time and
    // doesn't expose a fetch / per-request header hook. For local dev
    // with U2M (~1hr TTL) and short-lived dev servers this is fine; for
    // long-running prod deployments, override `memory.embedder` /
    // `memory.llm` with credentials that don't expire (PAT or
    // service-principal M2M).
    const databricks = await _resolveDatabricksOpenAIDefaults();
    const embedder = memoryConfig.embedder ?? {
      provider: "openai",
      config: {
        model: _DEFAULT_EMBED_MODEL,
        apiKey: databricks.apiKey,
        baseURL: databricks.baseURL,
      },
    };
    const llm = memoryConfig.llm ?? {
      provider: "openai",
      config: {
        model: _DEFAULT_LLM_MODEL,
        apiKey: databricks.apiKey,
        baseURL: databricks.baseURL,
        // Marker our LLM factory patch keys off. Without this, the
        // request hits Databricks with `response_format: json_object`
        // and gets 400'd ("messages must contain the word json"); with
        // it, the patched factory builds a `DatabricksFmApiLLM` that
        // drops `response_format` and relies on prompt-instructed JSON
        // output (which mem0's system prompt already does).
        [DATABRICKS_FM_API_KEY]: true,
      },
    };
    // Default dims match `databricks-gte-large-en` (1024). Users who
    // override `embedder` should override this too; if they don't,
    // mem0's pgvector store will create a 1024-wide column that won't
    // match their model's vectors.
    const embeddingModelDims =
      memoryConfig.embeddingModelDims ?? _DEFAULT_EMBED_DIMS;

    this.memory = new Memory({
      embedder,
      llm,
      vectorStore: {
        provider: "pgvector",
        config: {
          collectionName,
          embeddingModelDims,
          // Marker our factory patch keys off. The actual `pg.Pool`
          // is stashed here so the patched factory builds a
          // `LakebasePGVector` (pool-backed) instead of the bundled
          // `PGVector` (long-lived Client).
          [CONNECTION_POOL_KEY]: pool,
          // The bundled `embeddingModelDims` is required; mirror it as
          // `dimension` so mem0's `_autoInitialize` skips the probe
          // embedding (saves an LLM call and works even if the
          // embedder is mis-configured locally).
          dimension: embeddingModelDims,
        },
      },
      // We don't ship a Postgres-backed history adapter; SQLite would
      // need a writable disk path which Databricks Apps don't reliably
      // have. Disable until users opt in to their own history store.
      disableHistory: true,
    } as ConstructorParameters<typeof Memory>[0]);
  }

  private _rebuildToolRegistry(): void {
    this.tools = buildToolRegistry({
      progress: this.progress,
      wirings: this.wirings,
      memory: this.memoryWiring,
    });
  }

  /**
   * Manually register a `sendMessage` AsyncGenerator under an alias. Usually
   * unnecessary - the genie plugin is auto-wired during `setup()`. Use this
   * to override the auto-wired sender (e.g. a test mock) or to wire an alias
   * that isn't declared in the genie plugin's `spaces` config. The tool
   * registry is rebuilt eagerly so subsequent `toolkit()` / `getAgentTools()`
   * calls reflect the change.
   */
  wireGenie(alias: string, sendMessage: GenieSendMessage): void {
    this.wirings.set(alias, { alias, sendMessage });
    this._rebuildToolRegistry();
  }

  /** Returns the names of all currently wired aliases. */
  listWiredGenieAliases(): string[] {
    return Array.from(this.wirings.keys());
  }

  /** Publish a tool-progress event onto the in-process bus. */
  publishToolProgress(event: Omit<ToolProgressEvent, "ts">): void {
    this.progress.publish(event);
  }

  /** Subscribe to tool-progress events. Returns an unsubscribe function. */
  subscribeToolProgress(
    handler: (event: ToolProgressEvent) => void,
  ): () => void {
    return this.progress.subscribe(handler);
  }

  // ToolProvider contract. AppKit's `isToolProvider` requires all three of
  // `getAgentTools`, `executeAgentTool`, and `asUser` (the last comes from
  // the Plugin base class). Without these methods the plugin is registered
  // as a plain Plugin and the `plugins.dbxTools` lookup in agent
  // `tools(plugins)` callbacks throws with "not registered. Available: ...".

  /**
   * AppKit ToolProvider: enumerate every tool the agent can call. Each
   * returned def carries the `SKIP_TEXT_FALLBACK_KEY` marker so a
   * `DatabricksAdapter` whose `run()` has been patched by `installAdapterPatch`
   * skips the Python-style text-tool-call parser when the agent's tools
   * include any of ours. The marker is harmless on adapters that don't
   * inspect it. The cast keeps the public return type compatible with
   * `AgentToolDefinition`; the extra property is read structurally on the
   * adapter side.
   */
  getAgentTools(): AgentToolDefinition[] {
    return toolsFromRegistry(this.tools).map((def) => {
      const marked: Record<string, unknown> = {
        ...def,
        [SKIP_TEXT_FALLBACK_KEY]: true,
      };
      return marked as unknown as AgentToolDefinition;
    });
  }

  /** AppKit ToolProvider: dispatch a tool invocation against the registry. */
  async executeAgentTool(
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return executeFromRegistry(this.tools, name, args, signal);
  }

  /**
   * Build the agent toolkit. Spread the returned record into the agent's
   * `tools(plugins)` return value. With no arguments, the toolkit includes
   * one Genie tool per auto-wired alias, keyed by its local name (no plugin
   * prefix) so agents see `genie`, `genie_<alias>`, etc.
   *
   * @example
   * ```ts
   * tools(plugins) {
   *   return {
   *     ...plugins.dbxTools.toolkit(),
   *   };
   * }
   * ```
   */
  toolkit(opts: ToolkitOptions = {}): Record<string, ToolkitEntry> {
    return this._buildToolkitEntries({ prefix: "", ...opts });
  }

  // Inline equivalent of AppKit's internal `buildToolkitEntries` helper
  // (not exported from the public API). Mirrors the behavior of the genie
  // / files / analytics plugins so the agents plugin's `isToolkitEntry`
  // brand check dispatches our tool calls through `executeAgentTool`.
  private _buildToolkitEntries(
    opts: ToolkitOptions,
  ): Record<string, ToolkitEntry> {
    const pluginName = this.config.name ?? "dbx-tools";
    const out: Record<string, ToolkitEntry> = {};
    const defs = toolsFromRegistry(this.tools);
    const defByName = new Map(defs.map((d) => [d.name, d]));
    for (const [localName, entry] of Object.entries(this.tools)) {
      const key = _applyToolkitOptions(localName, pluginName, opts);
      if (key === null) continue;
      const baseDef = defByName.get(localName);
      if (!baseDef) continue;
      // Stamp our skip-text-fallback marker onto the def. AppKit's agents
      // plugin spreads `tool.def` verbatim when building the agent's tool
      // index, so the marker flows through to `input.tools[i]` in
      // `DatabricksAdapter.run()` where the patch reads it. Acts as a
      // per-tool "do not parse my output as text tool calls" hint.
      const markedDef: Record<string, unknown> = {
        ...baseDef,
        name: key,
        [SKIP_TEXT_FALLBACK_KEY]: true,
      };
      out[key] = {
        __toolkitRef: true,
        pluginName,
        localName,
        def: markedDef as unknown as AgentToolDefinition,
        annotations: entry.annotations,
        autoInheritable: entry.autoInheritable,
      };
    }
    return out;
  }

  override injectRoutes(router: IAppRouter): void {
    this.route(router, {
      name: "tool-progress",
      method: "get",
      path: "/tool-progress",
      handler: progressSseHandler(this.progress),
    });
  }

  /**
   * Returns the underlying mem0 `Memory` instance when the plugin auto-
   * wired one (lakebase present + memory not disabled, and the
   * `setup:complete` lifecycle hook has run). `undefined` otherwise.
   * Useful when consumers want to call `memory.add` / `memory.search`
   * outside the agent tool surface (e.g. background jobs, REST
   * handlers). Calls before `setup:complete` return `undefined`.
   */
  getMemory(): Memory | undefined {
    return this.memory;
  }

  override exports() {
    return {
      wireGenie: this.wireGenie.bind(this),
      listWiredGenieAliases: this.listWiredGenieAliases.bind(this),
      publishToolProgress: this.publishToolProgress.bind(this),
      subscribeToolProgress: this.subscribeToolProgress.bind(this),
      toolkit: this.toolkit.bind(this),
      getMemory: this.getMemory.bind(this),
    };
  }
}

// Default user resolver: pulls `userId` off the AppKit execution context
// when the call is happening inside a user context (OBO request flow).
// Returns `undefined` when no user context is active (e.g. background
// service calls), leaving the consumer to decide a fallback - the memory
// tools default that to `"default"` so mem0 doesn't reject the call.
function _defaultResolveUser(): string | undefined {
  try {
    const ctx = getExecutionContext();
    if (ctx && "isUserContext" in ctx && ctx.isUserContext) {
      return ctx.userId;
    }
  } catch {
    // ServiceContext not initialized yet; fall through to undefined.
  }
  return undefined;
}

// Default Databricks-hosted models for mem0's embedder + LLM. Both are
// open-source pay-per-token Foundation Model API endpoints available in
// every Databricks workspace without provisioning:
//   - GTE-Large (1024 dims) for embeddings.
//   - Llama-3.3 70B Instruct for the memory-extraction LLM.
// Override via `memory.embedder` / `memory.llm` in the plugin config.
const _DEFAULT_EMBED_MODEL = "databricks-gte-large-en";
const _DEFAULT_EMBED_DIMS = 1024;
const _DEFAULT_LLM_MODEL = "databricks-meta-llama-3-3-70b-instruct";

/**
 * Resolve OpenAI-compatible Databricks Foundation Model API defaults:
 * the workspace's `/serving-endpoints` base URL plus a freshly-minted
 * bearer token (works across U2M, M2M, and PAT auth via the SDK's
 * `Config.authenticate` flow).
 *
 * The returned `apiKey` is a one-shot string because mem0's `openai`
 * provider bakes it into `new OpenAI({apiKey, baseURL})` at
 * construction time. For long-running deployments where a 1hr OAuth
 * token expires, users should override `memory.embedder` /
 * `memory.llm` with non-expiring credentials.
 */
async function _resolveDatabricksOpenAIDefaults(): Promise<{
  baseURL: string;
  apiKey: string;
}> {
  // `setup:complete` runs after ServiceContext is initialized, so
  // `getExecutionContext()` returns the service-principal context here
  // (no user is active yet - the hook fires before any HTTP request).
  const ctx = getExecutionContext();
  const config = ctx.client.config;
  const host = await config.getHost();
  // `config.authenticate(headers)` mutates a Headers object to add the
  // right `Authorization: Bearer <token>` regardless of underlying auth
  // mode (U2M OAuth, M2M client_credentials, PAT). We extract the token
  // by stripping the scheme prefix.
  const headers = new Headers();
  await config.authenticate(headers);
  const authz = headers.get("Authorization") ?? "";
  const apiKey = authz.replace(/^Bearer\s+/i, "");
  // Trailing slash matters: the OpenAI Node SDK appends paths like
  // `/chat/completions` to whatever we hand it. Without the slash it
  // would resolve as `/serving-endpointschat/completions` and 404.
  const baseURL = new URL("/serving-endpoints/", host).toString().replace(/\/$/, "");
  return { baseURL, apiKey };
}

// Mirror of AppKit's internal `applyToolkitOptions` (filter + prefix +
// rename). Inlined because the helper is not part of the public API; kept
// behavior-identical so renames and `only` / `except` filters work the
// same as the built-in plugins.
function _applyToolkitOptions(
  localName: string,
  pluginName: string,
  opts: ToolkitOptions,
): string | null {
  if (opts.only && !opts.only.includes(localName)) return null;
  if (opts.except?.includes(localName)) return null;
  const renamed = opts.rename?.[localName];
  if (typeof renamed === "string" && renamed.length > 0) return renamed;
  return `${opts.prefix ?? `${pluginName}.`}${localName}`;
}

export const dbxTools = toPlugin(DbxTools);
