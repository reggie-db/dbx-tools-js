/**
 * AppKit plugin that builds one or more Mastra `Agent` instances and
 * mounts the `@mastra/express` server. Clients drive the conversation
 * over the standard Mastra agent stream (`@mastra/client-js`'s
 * `getAgent(id).stream()`), so there's no bespoke chat transport to
 * keep in sync.
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
 *   {@link agentStorageSchemaName} per agent; the vector store is a single
 *   shared singleton across every agent.
 * - Server: the Express subapp wiring lives in `./server.js`.
 * - HTTP: AppKit mounts this plugin under `/api/mastra`. Alongside the
 *   Mastra agent routes, the plugin registers `/route/history`
 *   (load + clear a thread's messages), `/route/threads` (list the
 *   caller's conversations + delete one), `/models`, `/suggestions`,
 *   `/route/feedback` (log a thumbs / comment to MLflow when feedback
 *   is enabled), and the generic `/embed/:type/:id` resolver for inline
 *   chart / data markers. The stock `@mastra/express` surface is gated
 *   by `config.apiAccess` (default `"scoped"`): only agent inference,
 *   read-only agent metadata, the `/route/*` routes, and (when enabled)
 *   MCP are dispatched to Mastra; admin / mutating / bulk-export routes
 *   are refused with `403`. See {@link isMastraRequestAllowed}.
 * - MCP: opt in with `config.mcp` to expose the agents (and optionally
 *   tools) as a Mastra `MCPServer`. It is registered on the `Mastra`
 *   instance via `mcpServers`, so `@mastra/express` serves the stock
 *   MCP transport routes (`/mcp/<serverId>/...`) under the mount. See
 *   `./mcp.js`.
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
import { apiUtils, appkitUtils, commonUtils, logUtils } from "@dbx-tools/shared";
import type { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import express from "express";
import type { Pool } from "pg";

import {
  MASTRA_ROUTES,
  MastraFeedbackRequestSchema,
  type MastraClientConfig,
  type MastraFeedbackRequest,
  type StatementData,
} from "@dbx-tools/appkit-mastra-shared";
import {
  clearServingEndpointsCache,
  listServingEndpoints,
  type ServingEndpointSummary,
} from "@dbx-tools/model";
import { buildAgents, FALLBACK_AGENT_ID, type BuiltAgents } from "./agents.js";
import { fetchChart } from "./chart.js";
import type { MastraPluginConfig } from "./config.js";
import { collectSpaceSuggestions, resolveGenieSpaces } from "./genie.js";
import { historyRoute } from "./history.js";
import { buildMcpServer, type ResolvedMcp } from "./mcp.js";
import {
  createMemoryBuilder,
  createServicePrincipalPool,
  needsLakebase,
} from "./memory.js";
import { logFeedback, resolveFeedbackEnabled } from "./mlflow.js";
import { buildObservability } from "./observability.js";
import {
  attachRoutePatchMiddleware,
  isMastraRequestAllowed,
  MastraServer,
} from "./server.js";
import { resolveServingConfig } from "./serving.js";
import { fetchStatementData, STATEMENT_ROW_CAP } from "./statement.js";
import { threadsRoute } from "./threads.js";

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
  /**
   * The optional MCP server exposing this plugin's agents / tools, or
   * `null` when `config.mcp` is disabled (the default). Built in
   * {@link buildAgentAndServer} and registered on the Mastra instance.
   */
  private mcp: ResolvedMcp | null = null;
  /**
   * Dedicated service-principal Lakebase pool backing Mastra memory /
   * storage. Built once in {@link buildAgentAndServer} (outside any
   * `asUser` scope, so it never inherits a request's OBO identity) and
   * drained in {@link abortActiveOperations}. `null` until setup runs
   * or when Lakebase isn't needed.
   */
  private servicePrincipalPool: Pool | null = null;

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

  /**
   * Drain the memory service-principal pool on shutdown. AppKit calls
   * this during teardown; the lakebase plugin closes its own SP / OBO
   * pools the same way. Fire-and-forget so shutdown isn't blocked on a
   * slow drain, and clear the handle so a re-`setup()` rebuilds it.
   */
  override abortActiveOperations(): void {
    super.abortActiveOperations();
    if (this.servicePrincipalPool) {
      this.log.info("closing memory SP pool");
      const pool = this.servicePrincipalPool;
      this.servicePrincipalPool = null;
      pool.end().catch((err) => {
        this.log.error("error closing memory SP pool", {
          error: commonUtils.errorMessage(err),
        });
      });
    }
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
       * The agent the client converses with when it doesn't name one.
       * Resolves to `config.defaultAgent`, the first registered id, or
       * the built-in `default` fallback.
       */
      getDefault: (): Agent | null =>
        (this.built && this.built.agents[this.built.defaultAgentId]) ?? null,
      /** Underlying Mastra instance for advanced use (custom routes etc.). */
      getMastra: () => this.mastra,
      /**
       * MCP endpoint info when `config.mcp` is enabled, else `null`.
       * Paths are absolute (under the plugin mount), ready to hand to an
       * MCP client. Streamable HTTP is `http`; the SSE pair is the
       * legacy transport.
       */
      getMcp: (): {
        serverId: string;
        http: string;
        sse: string;
        messages: string;
      } | null =>
        this.mcp
          ? {
              serverId: this.mcp.serverId,
              http: `/api/${this.name}${this.mcp.httpPath}`,
              sse: `/api/${this.name}${this.mcp.ssePath}`,
              messages: `/api/${this.name}${this.mcp.messagePath}`,
            }
          : null,
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
    // honors `config.name` overrides, so publishing `basePath` is
    // enough for the client to stay correct under a custom mount id -
    // the per-route segments are fixed (`MASTRA_ROUTES`) and the
    // client (`MastraPluginClient`) derives every endpoint from
    // `basePath`.
    // Return widens to `Record<string, unknown>` to satisfy the
    // base-class signature; consumers read it through the typed
    // `MastraClientConfig` shape via `usePluginClientConfig<...>(...)`.
    const config: MastraClientConfig = {
      basePath: `/api/${this.name}`,
      defaultAgent: this.built?.defaultAgentId ?? FALLBACK_AGENT_ID,
      agents: Object.keys(this.built?.agents ?? {}),
      feedbackEnabled: this.feedbackEnabled(),
    };
    return config as unknown as Record<string, unknown>;
  }

  /**
   * Whether user feedback can be logged to MLflow. Delegates to
   * {@link resolveFeedbackEnabled} so the client-config flag and the
   * feedback route share the same gate as the server's trace-id header.
   */
  private feedbackEnabled(): boolean {
    return resolveFeedbackEnabled(this.config.feedback);
  }

  override injectRoutes(router: IAppRouter): void {
    // Expose the MCP transport at the clean `/mcp` (plus the legacy
    // `/sse` + `/messages`) under the plugin mount. `@mastra/express`
    // mounts MCP under `/mcp/<serverId>/<transport>`, and the serverId
    // defaults to the plugin name, so the raw route reads
    // `/api/mastra/mcp/mastra/mcp` (doubled segment). This runs before
    // the catch-all and rewrites the alias to the underlying route, so
    // the public path is just `/api/<plugin>/mcp`; the query string
    // (e.g. the SSE `sessionId`) is preserved.
    router.use((req, _res, next) => {
      const target = this.mcpRouteAlias(req.path);
      if (target) {
        const q = req.url.indexOf("?");
        req.url = q >= 0 ? target + req.url.slice(q) : target;
      }
      next();
    });

    // `GET /models` exposes the cached endpoint list so clients can
    // populate model pickers, validate `?model=` choices, etc. Must
    // be registered before the catch-all that forwards everything to
    // the Mastra subapp. Errors propagate to Express's default error
    // handler via `next(err)` so callers see the real SDK message.
    router.get(MASTRA_ROUTES.models, (req, res, next) => {
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

    router.get(`${MASTRA_ROUTES.embed}/:type/:id`, (req, res, next) => {
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
            error: commonUtils.errorMessage(err),
          });
          res.json({ questions: [] });
        });
    };
    router.get(MASTRA_ROUTES.suggestions, handleSuggestions);
    router.get(`${MASTRA_ROUTES.suggestions}/:agentId`, handleSuggestions);

    // `POST /route/feedback` logs a thumbs / comment assessment against
    // a turn's MLflow trace (the `traceId` the client captured from the
    // stream response's trace-id header). Registered on the AppKit
    // router (like `/models`) rather than the Mastra subapp so it runs
    // under the same OBO scope - the feedback is attributed to the
    // signed-in user. Returns 404 when feedback is disabled so the
    // client treats the capability as absent; 400 on a malformed body.
    // A recorded assessment yields `{ ok: true }`; a soft failure (most
    // often the trace hasn't finished exporting to MLflow yet) yields
    // `{ ok: false }` without a 5xx so the UI can prompt a retry.
    router.post(MASTRA_ROUTES.feedback, (req, res, next) => {
      if (!this.feedbackEnabled()) {
        res.status(404).json({ ok: false });
        return;
      }
      const parsed = MastraFeedbackRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ ok: false, error: parsed.error.message });
        return;
      }
      this.userScopedSelf(req)
        .logFeedback(parsed.data)
        .then((assessmentId) =>
          res.json({
            ok: assessmentId !== undefined,
            ...(assessmentId ? { assessmentId } : {}),
          }),
        )
        .catch(next);
    });

    router.use((req, res, next) => {
      if (!this.mastraApp) return res.status(503).end();
      // Gate the stock Mastra surface before dispatch. In the default
      // "scoped" mode only agent inference, read-only agent metadata, this
      // plugin's own `/route/*` routes, and (when enabled) MCP reach Mastra;
      // admin / mutating / bulk-export routes are refused here. `req.path`
      // is mount-relative under the plugin mount. See `server.ts`.
      if (
        !isMastraRequestAllowed(req.method, req.path, {
          access: this.config.apiAccess ?? "scoped",
          // Reflect the *resolved* MCP state, not raw `config.mcp`: MCP is
          // on by default (`config.mcp` undefined), so gate on whether the
          // server was actually built and mounted.
          mcpEnabled: this.mcp !== null,
        })
      ) {
        res
          .status(403)
          .json({ error: "Endpoint not exposed to the client (apiAccess=scoped)" });
        return;
      }
      // Dispatch through a real method, NOT the `mastraApp` property. The
      // AppKit `asUser(req)` proxy wraps function-valued props with
      // `value.bind(target)`. `mastraApp` is an express app whose `.bind` is
      // the HTTP BIND route registrar (express defines a method per HTTP verb,
      // and BIND is one), not `Function.prototype.bind` - so binding it through
      // the proxy registers a bogus route and crashes `pathToRegexp`
      // ("path must be a string ..."). This only manifests in production where
      // an OBO token makes `userScopedSelf` return the proxy. `dispatchMastra`
      // is a plain method (its `.bind` is the normal one) and invokes
      // `this.mastraApp` off the real target, keeping the OBO scope active.
      return this.userScopedSelf(req).dispatchMastra(req, res, next);
    });
  }

  /**
   * Invoke the Mastra express sub-app. Exists as a method (instead of reading
   * `this.mastraApp` through the `asUser(req)` proxy at the call site) so the
   * proxy binds this plain method - whose `.bind` is `Function.prototype.bind`
   * - rather than the express app, whose `.bind` is the HTTP BIND route
   * registrar (see the note in `injectRoutes`). Runs inside the user scope so
   * `getExecutionContext()` returns the OBO client for the agent/model
   * resolvers.
   */
  private dispatchMastra(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): void {
    this.mastraApp!(req, res, next);
  }

  /**
   * Map a clean, mount-relative MCP alias path to the underlying
   * `@mastra/express` route. Returns `null` when MCP is off or the path
   * isn't an alias. Collapses the stock `/mcp/<serverId>/<transport>`
   * layout (serverId defaults to the plugin name) down to `/mcp`,
   * `/sse`, and `/messages`.
   */
  private mcpRouteAlias(path: string): string | null {
    if (!this.mcp) return null;
    const id = this.mcp.serverId;
    if (path === "/mcp") return `/mcp/${id}/mcp`;
    if (path === "/sse") return `/mcp/${id}/sse`;
    if (path === "/messages") return `/mcp/${id}/messages`;
    return null;
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
   * Implementation backing the `/route/feedback` route. Runs inside the
   * AppKit user-context proxy so `getExecutionContext()` returns the
   * OBO-scoped client and the assessment is attributed to the signed-in
   * user (their email / id as the assessment source). Returns the
   * created assessment id on success, or `undefined` on a soft failure
   * (see {@link logFeedback} in `./mlflow.js`).
   */
  private async logFeedback(
    feedback: MastraFeedbackRequest,
  ): Promise<string | undefined> {
    const ctx = getExecutionContext();
    const sourceId =
      "userEmail" in ctx && ctx.userEmail
        ? ctx.userEmail
        : "userId" in ctx
          ? ctx.userId
          : ctx.serviceUserId;
    return logFeedback(ctx.client, {
      ...feedback,
      ...(sourceId ? { sourceId } : {}),
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
      if (apiUtils.errorContext(err).notAccessible) return undefined;
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
    // Per-agent memory factory. When any storage / memory setting needs
    // Postgres, stand up a dedicated service-principal pool first so
    // memory acts as the app SP (owner of the `mastra_*` schemas),
    // never the per-request OBO identity the chat turn runs under.
    // `getPgConfig()` is read here, outside any `asUser` scope, so it
    // returns the SP connection target + token refresh plus any
    // `lakebase({ pool })` overrides; `require` turns a missing
    // sibling into a clear wiring error. The builder caches the shared
    // `PgVector` singleton so registering N agents stays cheap. See
    // `./memory.js`.
    if (needsLakebase(this.config)) {
      const spPgConfig = appkitUtils
        .require(this.context, lakebase, this.config)
        .exports()
        .getPgConfig();
      this.servicePrincipalPool = await createServicePrincipalPool(spPgConfig);
    }
    const memoryBuilder = this.servicePrincipalPool
      ? createMemoryBuilder(this.config, this.servicePrincipalPool)
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
    const observability = await buildObservability({
      serviceName: this.name,
      enabled: this.config.observability,
    });
    // Optional MCP exposure: build a Mastra MCP server from the
    // registered agents (and, opt-in, the ambient tools) and register
    // it on the Mastra instance. `@mastra/express` serves the stock MCP
    // transport routes (`/mcp/<serverId>/...`) off `mcpServers`, so the
    // catch-all dispatch below already routes MCP requests under OBO -
    // no bespoke route needed. See `./mcp.js`.
    this.mcp = buildMcpServer({
      config: this.config,
      pluginName: this.name,
      displayName: MastraPlugin.manifest.displayName,
      agents: this.built.agents,
      ambientTools: this.built.ambientTools,
    });
    this.mastra = new Mastra({
      agents: this.built.agents,
      ...(instanceStorage ? { storage: instanceStorage } : {}),
      ...(observability ? { observability } : {}),
      ...(this.mcp ? { mcpServers: { [this.mcp.serverId]: this.mcp.server } } : {}),
    });
    this.mastraApp = express();
    attachRoutePatchMiddleware(this.mastraApp);
    this.mastraServer = new MastraServer(this.config, {
      app: this.mastraApp,
      mastra: this.mastra,
      prefix: "",
      customApiRoutes: [
        // `historyRoute` registers both GET (load) and DELETE
        // (clear) on the same path, so it returns an array we
        // splice in.
        ...historyRoute({
          path: MASTRA_ROUTES.history,
          agent: this.built.defaultAgentId,
        }),
        // Assert the `:agentId` template type: the per-package build's
        // NodeNext resolution widens the imported `MASTRA_ROUTES.history`
        // to `string` (the source/bundler typecheck keeps it a literal),
        // which would otherwise drop this out of the dynamic-agent
        // overload and demand a fixed `agent`.
        ...historyRoute({
          path: `${MASTRA_ROUTES.history}/:agentId` as `${string}:agentId`,
        }),
        // `threadsRoute` registers GET (list the caller's conversation
        // threads) and DELETE (remove the targeted thread) on the same
        // path; both the default-agent and dynamic-agent mounts are
        // spliced in, mirroring the history routes above.
        ...threadsRoute({
          path: MASTRA_ROUTES.threads,
          agent: this.built.defaultAgentId,
        }),
        ...threadsRoute({
          path: `${MASTRA_ROUTES.threads}/:agentId` as `${string}:agentId`,
        }),
      ],
    });
    await this.mastraServer.init();
    this.log.debug("build:done", {
      agents: Object.keys(this.built.agents),
      defaultAgent: this.built.defaultAgentId,
      routes: [
        "/route/history",
        "/route/threads",
        "/models",
        "/suggestions",
        "/route/feedback",
        "/embed/:type/:id",
      ],
      instanceStorage: instanceStorage !== undefined,
      observability: observability !== undefined ? "mlflow" : "off",
      mcp: this.mcp ? `/api/${this.name}${this.mcp.httpPath}` : "off",
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
