/**
 * AppKit plugin that builds a single Mastra `Agent` and mounts the
 * `@mastra/express` server plus `@mastra/ai-sdk` `chatRoute` handlers.
 * The UI message stream matches what `chatRoute()` emits, so the
 * client can use `useChat()` from `@ai-sdk/react` without custom parsing.
 *
 * - Model: each agent call resolves a `MastraModelConfig` via
 *   {@link buildModel} from `./model.js`. Optional `servingAlias` on
 *   the plugin config is reserved for future wiring to the AppKit
 *   `serving` plugin.
 * - Memory / storage: when `storage` or `memory` is enabled, uses the
 *   sibling `lakebase` plugin pool through {@link buildMemory} from
 *   `./memory.js`. Both default to off.
 * - Server: the Express subapp wiring lives in `./server.js`.
 * - Tools: the default agent ships with an empty `tools` map; use
 *   `buildGenieTools` from `./genie.js` when wiring the `genie` plugin
 *   into a custom agent.
 * - HTTP: AppKit mounts this plugin under `/api/mastra`. `chatRoute`
 *   is registered at `/route/chat` and `/route/chat/:agentId`, so the
 *   AI SDK transport URL is `/api/mastra/route/chat/<agentId>`.
 */

import {
  genie,
  lakebase,
  Plugin,
  toPlugin,
  type IAppRouter,
  type PluginManifest,
  type ResourceRequirement,
} from "@databricks/appkit";
import { logUtils, pluginUtils } from "@dbx-tools/appkit-shared";
import { chatRoute } from "@mastra/ai-sdk";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import express from "express";

import type { MastraPluginConfig } from "./config.js";
import { buildMemory, needsLakebase, resolveLakebasePool } from "./memory.js";
import { buildModel } from "./model.js";
import { attachRoutePatchMiddleware, MastraServer } from "./server.js";

const GENIE_MANIFEST = pluginUtils.pluginData(genie).plugin.manifest;
const LAKEBASE_MANIFEST = pluginUtils.pluginData(lakebase).plugin.manifest;

const DEFAULT_AGENT_ID = "default";

const ANALYST_INSTRUCTIONS = `You are a data analyst. The user will ask questions about
business metrics and may share personal preferences you should remember across turns.

Rules:

1. Quote numbers exactly. Never invent data.
2. When the user states a preference or durable fact about themselves
   ("I'm in EU so use EUR", "always show me the SQL"), acknowledge that
   you will remember it.
3. If you don't have enough information to answer, ask a clarifying
   question instead of guessing.`;

/**
 * AppKit plugin (registered name: `mastra`) that hosts a Mastra agent
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
  private defaultAgent: Agent | null = null;
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
      getDefault: () => this.defaultAgent,
      getMastra: () => this.mastra,
      getMastraServer: () => this.mastraServer,
    };
  }

  override clientConfig(): Record<string, unknown> {
    return { defaultAgent: DEFAULT_AGENT_ID };
  }

  override injectRoutes(router: IAppRouter): void {
    router.use("", (req, res, next) => {
      if (!this.mastraApp) return res.status(503).end();
      return this.asUser(req).mastraApp!(req, res, next);
    });
  }

  private async buildAgentAndServer(): Promise<void> {
    // Resolve the Lakebase pool once. Both PostgresStore and PgVector
    // share it; see `./memory.js` for the build details.
    const memory = needsLakebase(this.config)
      ? buildMemory(this.config, resolveLakebasePool(this.context, this.config))
      : undefined;
    // Single hardcoded analyst agent. The agent's `model` is a Mastra
    // `DynamicArgument` that resolves workspace URL + bearer at call
    // time, so the same Agent instance serves concurrent requests with
    // distinct user identities. Inside `handleChat` the factory runs
    // in the `asUser(req)` async scope, so `getExecutionContext()`
    // returns the user context.
    this.defaultAgent = new Agent({
      id: DEFAULT_AGENT_ID,
      name: "Default Agent",
      instructions: ANALYST_INSTRUCTIONS,
      model: ({ requestContext }) => buildModel(this.config, requestContext),
      tools: {},
      ...(memory ? { memory } : {}),
    });

    // Smallest possible Mastra: one agent. `mastra.server.apiRoutes` is
    // only honored by Mastra's standalone dev server (port 4111). Since
    // we're hosting Mastra inside our own Express app via
    // `@mastra/express`, custom routes must be passed to the
    // `MastraServer` constructor directly via `customApiRoutes` below.
    this.mastra = new Mastra({
      agents: { [DEFAULT_AGENT_ID]: this.defaultAgent },
    });
    this.mastraApp = express();
    attachRoutePatchMiddleware(this.mastraApp);
    this.mastraServer = new MastraServer(this.config, {
      app: this.mastraApp,
      mastra: this.mastra,
      prefix: "",
      customApiRoutes: [
        chatRoute({ path: "/route/chat", agent: DEFAULT_AGENT_ID }),
        chatRoute({ path: "/route/chat/:agentId" }),
      ],
    });
    await this.mastraServer.init();
  }
}

export const mastra = toPlugin(MastraPlugin);
