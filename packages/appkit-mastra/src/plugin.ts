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

import type {
  MastraClientConfig,
  StatementData,
} from "@dbx-tools/appkit-mastra-shared";
import { buildAgents, FALLBACK_AGENT_ID, type BuiltAgents } from "./agents.js";
import { fetchChart } from "./chart.js";
import type { MastraPluginConfig } from "./config.js";
import { collectSpaceSuggestions, resolveGenieSpaces } from "./genie.js";
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
      embedPathTemplate: `${basePath}/embed/:type/:id`,
      suggestionsPath: `${basePath}/suggestions`,
      suggestionsPathTemplate: `${basePath}/suggestions/:agentId`,
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

    // `GET /embed/:type/:id` is the single resolver for every embed
    // marker the agent emits in prose (`[chart:<id>]`,
    // `[data:<id>]`, ...). `:type` selects a resolver from the
    // registry below; `:id` is that resolver's lookup key. The
    // grammar (see `marker.ts`) is type-agnostic on purpose - new
    // embed kinds are added by registering a resolver here, with no
    // client or grammar change.
    //
    // Status codes:
    //   - 200 with the resolver's JSON body when the id resolves.
    //   - 404 when `:type` isn't registered (unsupported embed
    //     type) OR a registered resolver can't find `:id` (unknown
    //     / expired - e.g. a chart past its 1h TTL or a fabricated
    //     id the model never minted).
    //   - 400 when `:id` is empty.
    //
    // Per-type query knobs and behavior:
    //   - `chart`: long-polls the chart cache until the entry
    //     settles (`result` / `error`) or the budget elapses (then
    //     returns the still-processing entry to poll again).
    //     `?timeoutMs=<n>` (default 60s, capped 5min) tunes it.
    //   - `data`: one OBO-scoped Statement Execution fetch.
    //     `?limit=<n>` caps rows (clamped to STATEMENT_ROW_CAP).
    //
    // Built once (this handler is registered once) and keyed by the
    // raw `:type` token. Each resolver gets the request (for query
    // parsing + OBO scoping) and an `AbortSignal` bridged off the
    // connection `close` event so a long-poll unblocks the instant
    // the client disconnects. `undefined` from a resolver maps to a
    // clean 404; thrown errors bubble through `next(err)`.
    const embedResolvers: Record<string, EmbedResolver> = {
      chart: (req, id, signal) => {
        const timeoutMs = parseTimeoutMs(req.query["timeoutMs"]);
        return fetchChart(id, {
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          signal,
        });
      },
      data: (req, id, signal) => {
        const limit = parseStatementLimit(req.query["limit"]);
        return this.userScopedSelf(req).fetchStatement(id, {
          ...(limit !== undefined ? { limit } : {}),
          signal,
        });
      },
    };

    router.get("/embed/:type/:id", (req, res, next) => {
      const type = req.params["type"] ?? "";
      const id = req.params["id"];
      const resolve = embedResolvers[type];
      if (!resolve) {
        res.status(404).json({ error: `unsupported embed type: ${type}` });
        return;
      }
      if (!id) {
        res.status(400).json({ error: "id is required" });
        return;
      }
      // Express's `req` predates `AbortSignal`; bridge the `close`
      // event onto an `AbortController` so a closed connection
      // unblocks any long-poll immediately and frees the request
      // thread. The listener is GC'd with the request on normal
      // completion.
      const controller = new AbortController();
      req.on("close", () => controller.abort());
      resolve(req, id, controller.signal)
        .then((entry) => {
          if (entry === undefined) {
            res.status(404).json({ error: `${type} not found` });
            return;
          }
          res.json(entry);
        })
        .catch(next);
    });

    // `GET /suggestions` (and `/suggestions/:agentId`) returns the
    // curated starter questions for the agent's Genie space(s) - the
    // author-configured `sample_questions`, surfaced as one-tap
    // prompts on the chat empty state. Returns `{ questions: [] }`
    // when no Genie space is wired so the client renders a bare
    // empty state (no built-in example prompts). The `:agentId`
    // segment is accepted for URL symmetry with the chat / history
    // routes; Genie spaces are resolved per-plugin, not per-agent,
    // so it doesn't change the result. OBO-scoped like the other
    // data routes so the space lookup runs as the calling user.
    const handleSuggestions = (req: express.Request, res: express.Response): void => {
      const controller = new AbortController();
      req.on("close", () => controller.abort());
      this.userScopedSelf(req)
        .fetchSuggestions(controller.signal)
        .then((questions) => res.json({ questions }))
        .catch((err: unknown) => {
          // Suggestions are a non-critical enhancement; a lookup
          // failure should leave the chat usable with a bare empty
          // state rather than surfacing a 500. Log and degrade.
          this.log.warn("suggestions:error", {
            error: err instanceof Error ? err.message : String(err),
          });
          res.json({ questions: [] });
        });
    };
    router.get("/suggestions", handleSuggestions);
    router.get("/suggestions/:agentId", handleSuggestions);

    router.use("", (req, res, next) => {
      if (!this.mastraApp) return res.status(503).end();
      return this.userScopedSelf(req).mastraApp!(req, res, next);
    });
  }

  /**
   * Implementation backing the `/suggestions` route. Runs inside the
   * AppKit user-context proxy so `getExecutionContext()` returns the
   * OBO-scoped client. Resolves the plugin's Genie spaces and merges
   * their curated `sample_questions` (see {@link collectSpaceSuggestions}).
   * Returns `[]` when no Genie space is configured so the client
   * shows a bare empty state instead of built-in example prompts.
   */
  private async fetchSuggestions(signal?: AbortSignal): Promise<string[]> {
    const spaces = resolveGenieSpaces(this.config, this.context);
    if (Object.keys(spaces).length === 0) return [];
    const client = getExecutionContext().client;
    return collectSpaceSuggestions({
      spaces,
      client,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Implementation backing the `data` embed resolver
   * (`GET /embed/data/:id`). Runs inside the AppKit user-context proxy so
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
 * Resolver for one embed `<type>` behind the generic
 * `GET /embed/:type/:id` route. Returns the JSON body to send on
 * success, or `undefined` to signal a 404 (unknown / expired id).
 * `signal` aborts when the client disconnects so long-polling
 * resolvers (e.g. `chart`) unblock immediately.
 */
type EmbedResolver = (
  req: express.Request,
  id: string,
  signal: AbortSignal,
) => Promise<unknown | undefined>;

/**
 * Parse the optional `?timeoutMs=<n>` query parameter from a
 * `GET /embed/chart/:id` request. Accepts a positive integer up
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
 * `GET /embed/data/:id` request. Accepts a non-negative
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
