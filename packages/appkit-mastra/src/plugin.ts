/**
 * AppKit plugin that builds one or more Mastra `Agent` instances and
 * mounts the `@mastra/express` server plus `@mastra/ai-sdk` `chatRoute`
 * handlers. The UI message stream matches what `chatRoute()` emits, so
 * the client can use `useChat()` from `@ai-sdk/react` without custom
 * parsing.
 *
 * - Agents: registered through `config.agents` at plugin creation
 *   ({@link MastraAgentDefinition}). Each entry's `tools` field accepts
 *   either a plain record or a `(plugins) => tools` callback that gets
 *   a typed sibling-plugin index ({@link MastraPlugins}). Omit
 *   `config.agents` to get a single built-in `default` analyst.
 * - Model: each agent call resolves a `MastraModelConfig` via
 *   {@link buildModel} from `./model.js`. Per-agent `model` overrides
 *   (`AgentConfig["model"]` or a `modelId` string) flow through
 *   {@link buildAgents}.
 * - Memory / storage: per-agent, built by {@link createMemoryBuilder}
 *   from `./memory.js`. Both auto-default to `true` when the
 *   `lakebase` plugin is registered (unless the caller passed
 *   `false` or a custom config). Storage namespaces per agent via
 *   `schemaName: "mastra_<agentId>"`; the vector store is a single
 *   shared singleton across every agent.
 * - Server: the Express subapp wiring lives in `./server.js`.
 * - HTTP: AppKit mounts this plugin under `/api/mastra`. `chatRoute`
 *   is registered at `/route/chat` (bound to `config.defaultAgent` or
 *   the first registered id) and `/route/chat/:agentId`, so the
 *   AI SDK transport URL is `/api/mastra/route/chat/<agentId>`.
 */

import {
  genie,
  getExecutionContext,
  lakebase,
  Plugin,
  toPlugin,
  type IAppRouter,
  type PluginManifest,
  type ResourceRequirement,
} from "@databricks/appkit";
import { appkitUtils, logUtils } from "@dbx-tools/shared";
import { chatRoute } from "@mastra/ai-sdk";
import type { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import express from "express";

import { buildAgents, FALLBACK_AGENT_ID, type BuiltAgents } from "./agents.js";
import type {
  MastraClientConfig,
  StatementData,
} from "@dbx-tools/appkit-mastra-shared";
import { fetchChart } from "./chart.js";
import type { MastraPluginConfig } from "./config.js";
import { historyRoute } from "./history.js";
import { createMemoryBuilder, needsLakebase } from "./memory.js";
import { buildObservability } from "./observability.js";
import { attachRoutePatchMiddleware, MastraServer } from "./server.js";
import {
  clearServingEndpointsCache,
  listServingEndpoints,
  resolveServingConfig,
  type ServingEndpointSummary,
} from "./serving.js";
import {
  fetchStatementData,
  isStatementNotFoundError,
  STATEMENT_ROW_CAP,
} from "./statement.js";

const GENIE_MANIFEST = appkitUtils.data(genie).plugin.manifest;
const LAKEBASE_MANIFEST = appkitUtils.data(lakebase).plugin.manifest;

/**
 * AppKit plugin (registered name: `mastra`) that hosts Mastra agents
 * with optional Lakebase-backed memory and AI SDK chat routes under
 * the plugin mount (typically `/api/mastra`).
 */
export class MastraPlugin extends Plugin<MastraPluginConfig> {
  static manifest = {
    name: "mastra",
    displayName: "Mastra",
    description:
      "Builds a Mastra Agent with user-scoped workspace auth (asUser) " +
      "and optional Postgres-backed Mastra Memory via the `lakebase` plugin.",
    stability: "beta",
    resources: {
      required: [],
      optional: [
        // Surface the Genie resource binding (space id) declared by
        // AppKit's `genie` plugin manifest. The Mastra plugin no
        // longer uses the genie plugin's tools at runtime - the
        // built-in Genie agent talks to Genie directly via
        // `@dbx-tools/genie` - but reusing the manifest keeps the
        // resource-binding shape identical to AppKit's so existing
        // `app.yaml` configs and `genie({ spaces })` wiring keep
        // working without change.
        ...GENIE_MANIFEST.resources.required,
        ...LAKEBASE_MANIFEST.resources.required,
      ],
    },
  } satisfies PluginManifest<"mastra">;

  /**
   * Tighten resource requirements based on which features are enabled.
   * AppKit calls this at registration time (config-aware) so disabled
   * features don't surface their resource asks to the host app.
   */
  static getResourceRequirements(config: MastraPluginConfig): ResourceRequirement[] {
    const resources: ResourceRequirement[] = [];
    const enabledManifests: PluginManifest<string>[] = [];

    if (needsLakebase(config)) {
      enabledManifests.push(LAKEBASE_MANIFEST);
    }
    for (const m of enabledManifests) {
      for (const resource of m.resources.required) {
        resources.push({ ...resource, required: true } as ResourceRequirement);
      }
    }
    return resources;
  }

  private log = logUtils.logger(this);
  private built: BuiltAgents | null = null;
  private mastra: Mastra | null = null;
  private mastraApp: express.Express | null = null;
  private mastraServer: MastraServer | null = null;

  override async setup(): Promise<void> {
    // Wait until sibling plugins (e.g. `lakebase`) finish `setup()` so
    // the lakebase pool is valid when storage/memory are enabled.
    this.context?.onLifecycle("setup:complete", async () => {
      this.applyLakebaseAutoDefaults();
      this.log.info("setup:complete");
      await this.buildAgentAndServer();
    });
  }

  /**
   * When the `lakebase` plugin is registered, auto-enable `storage`
   * and `memory` unless the caller opted out explicitly (`false` or a
   * custom config object). Run after `setup:complete` so the lookup
   * is reliable: any plugin that registers itself synchronously is
   * already in the registry by the time this fires.
   */
  private applyLakebaseAutoDefaults(): void {
    const hasLakebase = appkitUtils.instance(this.context, lakebase) !== undefined;
    if (!hasLakebase) return;
    if (this.config.storage === undefined) this.config.storage = true;
    if (this.config.memory === undefined) this.config.memory = true;
  }

  override exports() {
    return {
      /**
       * Ids of every registered agent in registration order. Matches
       * AppKit `agents.list()` so callers can iterate the registry the
       * same way under both plugins.
       */
      list: (): string[] => Object.keys(this.built?.agents ?? {}),
      /**
       * Look up a registered agent by id. Returns `null` (not
       * undefined) when unknown so call sites can early-return without
       * a separate `in` check.
       */
      get: (id: string): Agent | null => this.built?.agents[id] ?? null,
      /**
       * The agent `chatRoute` binds to when the client doesn't name
       * one. Resolves to `config.defaultAgent`, the first registered
       * id, or the built-in `default` fallback.
       */
      getDefault: (): Agent | null =>
        (this.built && this.built.agents[this.built.defaultAgentId]) ?? null,
      /** Underlying Mastra instance for advanced use (custom routes etc.). */
      getMastra: () => this.mastra,
      /** Express subapp Mastra is mounted on; mostly for tests. */
      getMastraServer: () => this.mastraServer,
      /**
       * Fetch the workspace's Model Serving endpoints (cached). Same
       * payload the `GET /models` route returns; surfaced here so
       * other plugins / scripts can introspect the catalogue without
       * an HTTP round-trip. AppKit wraps this with `asUser(req)` for
       * OBO scoping automatically.
       */
      listModels: (): Promise<ServingEndpointSummary[]> => this.listModels(),
      /**
       * Force-evict cached endpoint listings via AppKit's
       * `CacheManager`. Useful in tests or right after an admin
       * deploys a new endpoint and doesn't want to wait for the TTL.
       * Returns the underlying `CacheManager.delete`/`clear` promise.
       */
      clearModelsCache: (host?: string): Promise<void> =>
        clearServingEndpointsCache(host),
    };
  }

  override clientConfig(): Record<string, unknown> {
    // AppKit mounts every plugin at `/api/<plugin.name>`. `this.name`
    // honors `config.name` overrides, so the published paths stay
    // accurate if someone remounts the plugin under a custom id.
    // Return widens to `Record<string, unknown>` to satisfy the
    // base-class signature; consumers read it through the typed
    // `MastraClientConfig` shape via `usePluginClientConfig<...>(...)`.
    const basePath = `/api/${this.name}`;
    const config: MastraClientConfig = {
      basePath,
      chatPath: `${basePath}/route/chat`,
      chatPathTemplate: `${basePath}/route/chat/:agentId`,
      modelsPath: `${basePath}/models`,
      historyPath: `${basePath}/route/history`,
      historyPathTemplate: `${basePath}/route/history/:agentId`,
      chartsPathTemplate: `${basePath}/charts/:chartId`,
      statementsPathTemplate: `${basePath}/statements/:statementId`,
      defaultAgent: this.built?.defaultAgentId ?? FALLBACK_AGENT_ID,
      agents: Object.keys(this.built?.agents ?? {}),
    };
    return config as unknown as Record<string, unknown>;
  }

  override injectRoutes(router: IAppRouter): void {
    // `GET /models` exposes the cached endpoint list so clients can
    // populate model pickers, validate `?model=` choices, etc. Must
    // be registered before the catch-all that forwards everything to
    // the Mastra subapp. Errors propagate to Express's default error
    // handler via `next(err)` so callers see the real SDK message.
    router.get("/models", (req, res, next) => {
      this.userScopedSelf(req)
        .listModels()
        .then((endpoints) => res.json({ endpoints }))
        .catch(next);
    });

    // `GET /charts/:chartId` long-polls the chart cache.
    //
    // Charts kicked off by the Genie agent's `prepare_chart` tool
    // (or the system `render_data` tool) resolve asynchronously
    // and land in the AppKit cache under a chartId. The host UI
    // resolves `[chart:<chartId>]` markers by hitting this route,
    // which blocks until the entry settles (`result` or `error`
    // set) or the server-side budget elapses (then returns the
    // last seen still-processing entry so the client can poll
    // again).
    //
    // Status codes:
    //   - 200 with JSON body when the entry is found (any state).
    //   - 404 when the chartId doesn't exist or its 1h TTL elapsed.
    //
    // Query params:
    //   - `timeoutMs` (optional, default 60000): how long to long-poll
    //     before returning a still-processing entry.
    //
    // Wired with `req.signal` so a closed connection unblocks the
    // poll immediately and the request thread frees up. Cache
    // failures bubble through `next(err)` to Express's default
    // error handler.
    router.get("/charts/:chartId", (req, res, next) => {
      const chartId = req.params["chartId"];
      if (!chartId) {
        res.status(400).json({ error: "chartId is required" });
        return;
      }
      const timeoutMs = parseTimeoutMs(req.query["timeoutMs"]);
      // Express's `req` predates `AbortSignal`. Bridge the
      // `close` event onto an `AbortController` so a closed
      // connection unblocks the long-poll immediately and frees
      // the request thread. The `close` listener also fires on
      // a normal completion, but at that point we no longer
      // care about the abort and the listener is GC'd with the
      // request.
      const controller = new AbortController();
      req.on("close", () => controller.abort());
      fetchChart(chartId, {
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        signal: controller.signal,
      })
        .then((entry) => {
          if (!entry) {
            res.status(404).json({ error: "chart not found" });
            return;
          }
          res.json(entry);
        })
        .catch(next);
    });

    // `GET /statements/:statementId` resolves a Genie / Statement
    // Execution result for inline rendering as a table.
    //
    // The agent embeds `[data:<statement_id>]` markers in prose
    // (see `GENIE_INSTRUCTIONS`) whenever it wants the host UI to
    // display a result set without the model re-spelling every
    // row in markdown. This route is what those markers resolve
    // against - one OBO-scoped fetch returns the columns + rows
    // so the client renders an AppKit Table inline.
    //
    // Status codes:
    //   - 200 with `StatementData` body when the statement is found.
    //   - 404 when the workspace can't find / read the statement.
    //
    // Query params:
    //   - `limit` (optional): row cap. Clamped to
    //     {@link STATEMENT_ROW_CAP} so a runaway result set
    //     can't hose the response.
    //
    // OBO-scoped via {@link userScopedSelf} so the caller's
    // workspace permissions apply; SDK errors propagate through
    // `next(err)` to Express's default error handler.
    router.get("/statements/:statementId", (req, res, next) => {
      const statementId = req.params["statementId"];
      if (!statementId) {
        res.status(400).json({ error: "statementId is required" });
        return;
      }
      const limit = parseStatementLimit(req.query["limit"]);
      const controller = new AbortController();
      req.on("close", () => controller.abort());
      this.userScopedSelf(req)
        .fetchStatement(statementId, {
          ...(limit !== undefined ? { limit } : {}),
          signal: controller.signal,
        })
        .then((data) => {
          if (!data) {
            res.status(404).json({ error: "statement not found" });
            return;
          }
          res.json(data);
        })
        .catch(next);
    });

    router.use("", (req, res, next) => {
      if (!this.mastraApp) return res.status(503).end();
      return this.userScopedSelf(req).mastraApp!(req, res, next);
    });
  }

  /**
   * Implementation backing the `/statements/:statementId` route.
   * Runs inside the AppKit user-context proxy so
   * `getExecutionContext()` returns the OBO-scoped workspace
   * client, then reuses the same `fetchStatementData` pipeline
   * the `get_statement` tool runs so the LLM and the UI see the
   * exact same shape for the same statement.
   *
   * Returns `undefined` for upstream 404s so the route can map
   * them to a clean HTTP 404; any other failure bubbles up.
   */
  private async fetchStatement(
    statementId: string,
    options: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<StatementData | undefined> {
    const client = getExecutionContext().client;
    const limit = Math.min(options.limit ?? STATEMENT_ROW_CAP, STATEMENT_ROW_CAP);
    try {
      const data = await fetchStatementData(client, statementId, {
        limit,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return {
        columns: data.columns,
        rows: data.rows,
        rowCount: data.rowCount,
        truncated: data.rows.length < data.rowCount,
      };
    } catch (err) {
      // The Databricks SDK throws on 404; surface as `undefined`
      // so the route maps to a clean HTTP 404 instead of a 500.
      if (isStatementNotFoundError(err)) return undefined;
      throw err;
    }
  }

  /**
   * Return `this.asUser(req)` when the request carries an OBO token,
   * otherwise return `this` directly. Prevents the noisy AppKit warn
   * (`asUser() called without user token in development mode. Skipping
   * user impersonation.`) on every request in local dev where the
   * browser never sends `x-forwarded-access-token`. Behavior is
   * unchanged in production: a missing token always means a real OBO
   * proxy call (and AppKit will throw upstream if that's wrong).
   */
  private userScopedSelf(req: express.Request): this {
    return req.header("x-forwarded-access-token") ? (this.asUser(req) as this) : this;
  }

  /**
   * Implementation backing both the `/models` route and the
   * `listModels` export. Runs inside the AppKit user-context proxy so
   * `getExecutionContext()` returns the OBO-scoped client.
   */
  private async listModels(): Promise<ServingEndpointSummary[]> {
    const client = getExecutionContext().client;
    const host = (await client.config.getHost()).toString();
    const serving = resolveServingConfig(this.config);
    return listServingEndpoints(client, host, { ttlMs: serving.ttlMs });
  }

  private async buildAgentAndServer(): Promise<void> {
    // Per-agent memory factory. The builder resolves the Lakebase pool
    // lazily (on first agent that actually needs storage / vector) and
    // caches both the pool and the shared `PgVector` singleton so
    // registering N agents stays cheap. See `./memory.js`.
    const memoryBuilder = needsLakebase(this.config)
      ? createMemoryBuilder(this.config, this.context)
      : undefined;

    this.log.debug("build:start", {
      lakebase: memoryBuilder !== undefined,
      stripStaleCharts: this.config.stripStaleCharts !== false,
    });

    // Build every agent declared in `config.agents` (or the built-in
    // fallback when none are declared). Each agent's `model` resolves
    // workspace URL + bearer at call time so concurrent requests get
    // distinct user identities; the `asUser(req)` scope around
    // `handleChat` is what lets `getExecutionContext()` return the
    // right user inside the resolver.
    this.built = await buildAgents({
      config: this.config,
      context: this.context,
      memoryBuilder,
      log: this.log,
    });

    // `mastra.server.apiRoutes` is only honored by Mastra's standalone
    // dev server. Since we're hosting Mastra inside our own Express
    // subapp via `@mastra/express`, custom routes must be passed to
    // the `MastraServer` constructor directly.
    //
    // `storage` here is *Mastra-instance-level* and persists workflow
    // snapshots (where suspended `requireApproval` tool calls live).
    // It's separate from each agent's `Memory.storage`, which only
    // covers thread / message history. Without it,
    // `agent.resumeStream()` errors with "could not find a suspended
    // run" and the approval UI hangs after the user clicks Approve.
    const instanceStorage = memoryBuilder?.instanceStorage();
    // Wire Mastra's tracer into AppKit's global OTel pipeline via
    // `@mastra/otel-bridge`. Mastra spans become native OTel spans on
    // whatever tracer provider `TelemetryManager` registered during
    // `createApp`, so the OTLP endpoint / headers / sampling are
    // env-driven and shared with every other AppKit plugin.
    const observability = await buildObservability({ serviceName: this.name });
    this.mastra = new Mastra({
      agents: this.built.agents,
      ...(instanceStorage ? { storage: instanceStorage } : {}),
      ...(observability ? { observability } : {}),
    });
    this.mastraApp = express();
    attachRoutePatchMiddleware(this.mastraApp);
    this.mastraServer = new MastraServer(this.config, {
      app: this.mastraApp,
      mastra: this.mastra,
      prefix: "",
      customApiRoutes: [
        chatRoute({ path: "/route/chat", agent: this.built.defaultAgentId }),
        chatRoute({ path: "/route/chat/:agentId" }),
        // `historyRoute` registers both GET (load) and DELETE
        // (clear) on the same path, so it returns an array we
        // splice in.
        ...historyRoute({ path: "/route/history", agent: this.built.defaultAgentId }),
        ...historyRoute({ path: "/route/history/:agentId" }),
      ],
    });
    await this.mastraServer.init();
    this.log.debug("build:done", {
      agents: Object.keys(this.built.agents),
      defaultAgent: this.built.defaultAgentId,
      routes: ["/route/chat", "/route/history", "/models"],
      instanceStorage: instanceStorage !== undefined,
      observability: observability !== undefined ? "mlflow" : "off",
    });
  }
}

/**
 * Parse the optional `?timeoutMs=<n>` query parameter from a
 * `GET /charts/:chartId` request. Accepts a positive integer up
 * to 5 minutes (clamped) and rejects everything else as
 * `undefined` so {@link fetchChart} falls back to its default.
 * Express produces `string | string[] | undefined`; we normalize
 * to the first scalar before parsing.
 */
function parseTimeoutMs(raw: unknown): number | undefined {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(Math.floor(n), 5 * 60_000);
}

/**
 * Parse the optional `?limit=<n>` query parameter from a
 * `GET /statements/:statementId` request. Accepts a non-negative
 * integer and lets the route clamp to `STATEMENT_ROW_CAP`;
 * rejects anything else as `undefined` so the route falls back
 * to the server-side cap.
 */
function parseStatementLimit(raw: unknown): number | undefined {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}

export const mastra = toPlugin(MastraPlugin);
