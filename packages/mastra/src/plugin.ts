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
 *   {@link buildAgents}. Optional `servingAlias` on the plugin config
 *   is reserved for future wiring to the AppKit `serving` plugin.
 * - Memory / storage: when `storage` or `memory` is enabled, uses the
 *   sibling `lakebase` plugin pool through {@link buildMemory} from
 *   `./memory.js`. Both default to off.
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
import { logUtils, pluginUtils } from "@dbx-tools/appkit-shared";
import { chatRoute } from "@mastra/ai-sdk";
import type { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import express from "express";

import { buildAgents, FALLBACK_AGENT_ID, type BuiltAgents } from "./agents.js";
import type { MastraPluginConfig } from "./config.js";
import { buildMemory, needsLakebase, resolveLakebasePool } from "./memory.js";
import { attachRoutePatchMiddleware, MastraServer } from "./server.js";
import {
  clearServingEndpointsCache,
  listServingEndpoints,
  resolveServingConfig,
  type ServingEndpointSummary,
} from "./serving.js";

const GENIE_MANIFEST = pluginUtils.data(genie).plugin.manifest;
const LAKEBASE_MANIFEST = pluginUtils.data(lakebase).plugin.manifest;

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
      this.log.info("setup:complete");
      await this.buildAgentAndServer();
    });
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
    return {
      defaultAgent: this.built?.defaultAgentId ?? FALLBACK_AGENT_ID,
      agents: Object.keys(this.built?.agents ?? {}),
    };
  }

  override injectRoutes(router: IAppRouter): void {
    // `GET /models` exposes the cached endpoint list so clients can
    // populate model pickers, validate `?model=` choices, etc. Must
    // be registered before the catch-all that forwards everything to
    // the Mastra subapp. Errors propagate to Express's default error
    // handler via `next(err)` so callers see the real SDK message.
    router.get("/models", (req, res, next) => {
      this.asUser(req)
        .listModels()
        .then((endpoints) => res.json({ endpoints }))
        .catch(next);
    });

    router.use("", (req, res, next) => {
      if (!this.mastraApp) return res.status(503).end();
      return this.asUser(req).mastraApp!(req, res, next);
    });
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
    // Resolve the Lakebase pool once. Both PostgresStore and PgVector
    // share it; see `./memory.js` for the build details.
    const memory = needsLakebase(this.config)
      ? buildMemory(this.config, resolveLakebasePool(this.context, this.config))
      : undefined;

    // Build every agent declared in `config.agents` (or the built-in
    // fallback when none are declared). Each agent's `model` resolves
    // workspace URL + bearer at call time so concurrent requests get
    // distinct user identities; the `asUser(req)` scope around
    // `handleChat` is what lets `getExecutionContext()` return the
    // right user inside the resolver.
    this.built = await buildAgents({
      config: this.config,
      context: this.context,
      memory,
      log: this.log,
    });

    // `mastra.server.apiRoutes` is only honored by Mastra's standalone
    // dev server. Since we're hosting Mastra inside our own Express
    // subapp via `@mastra/express`, custom routes must be passed to
    // the `MastraServer` constructor directly.
    this.mastra = new Mastra({ agents: this.built.agents });
    this.mastraApp = express();
    attachRoutePatchMiddleware(this.mastraApp);
    this.mastraServer = new MastraServer(this.config, {
      app: this.mastraApp,
      mastra: this.mastra,
      prefix: "",
      customApiRoutes: [
        chatRoute({ path: "/route/chat", agent: this.built.defaultAgentId }),
        chatRoute({ path: "/route/chat/:agentId" }),
      ],
    });
    await this.mastraServer.init();
  }
}

export const mastra = toPlugin(MastraPlugin);
