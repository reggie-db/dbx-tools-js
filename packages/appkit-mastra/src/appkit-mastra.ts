import {
  genie,
  getExecutionContext,
  lakebase,
  Plugin,
  serving,
  toPlugin,
  type BasePluginConfig,
  type IAppRouter,
  type PluginManifest,
  type ResourceRequirement,
} from "@databricks/appkit";
import type express from "express";
import { handleChatStream } from "@mastra/ai-sdk";
import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig, OpenAICompatibleConfig } from "@mastra/core/llm";
import { Mastra } from "@mastra/core/mastra";
import type { DynamicArgument } from "@mastra/core/types";
import { Memory } from "@mastra/memory";
import {
  PgVector,
  PgVectorConfig,
  PostgresStore,
  PostgresStoreConfig,
} from "@mastra/pg";
import {
  mastraChatRequestSchema,
  type MastraInfoResponse,
} from "@dbx-tools/appkit-mastra-shared";
import { createUIMessageStreamResponse } from "ai";
import { Readable } from "node:stream";
import type { Pool } from "pg";

// AppKit plugin that builds a single Mastra `Agent` from sibling AppKit
// plugins and exposes it through the same HTTP surface that backs
// https://ui-dojo.mastra.ai/: an AI SDK v5 UI Message Stream at
// `POST /chat` plus a `GET /info` description. The streaming wire format
// is identical to what `@mastra/ai-sdk`'s `chatRoute()` would emit, so
// the client can use `useChat()` from `@ai-sdk/react` with no custom
// payload parsing.
//
// - Model: resolved per-request via the `serving` plugin. The plugin
//   reads the configured `servingAlias` (default `"default"`) off the
//   sibling `serving` plugin, derives the endpoint name from its env
//   var, and exposes the workspace as an OpenAI-compatible base URL.
//   Each request mints a fresh user-scoped bearer via `asUser(req)` and
//   passes it to Mastra's `OpenAICompatibleConfig`, so every Databricks
//   model call runs with the calling user's OAuth identity.
// - Memory / storage: backed by the `lakebase` plugin's `pg.Pool` when
//   `storage` / `memory` are enabled. Disabled by default.
// - Tools: none in this first pass; the agent is LLM + Mastra Memory
//   only.
// - HTTP: routes are auto-mounted at `/api/appkit-mastra/...` by the
//   server plugin. `POST /chat` delegates to `handleChatStream` from
//   `@mastra/ai-sdk` and pipes the resulting UI Message Stream straight
//   through to Express via Node's `Readable.fromWeb()`. There is no
//   custom SSE shaping in this plugin.

const SERVING_MANIFEST = serving().plugin.manifest;
const GENIE_MANIFEST = genie().plugin.manifest;
const LAKEBASE_MANIFEST = lakebase().plugin.manifest;

const DEFAULT_SERVING_ALIAS = "default";
const DEFAULT_AGENT_ID = "analyst";

const ANALYST_INSTRUCTIONS = `You are a data analyst. The user will ask questions about
business metrics and may share personal preferences you should remember across turns.

Rules:

1. Quote numbers exactly. Never invent data.
2. When the user states a preference or durable fact about themselves
   ("I'm in EU so use EUR", "always show me the SQL"), acknowledge that
   you will remember it.
3. If you don't have enough information to answer, ask a clarifying
   question instead of guessing.`;

interface LakebasePluginExports {
  pool: Pool;
}

// Structural view of the `serving` plugin instance we read at setup
// time. The plugin's `config` is `protected`, so we access `endpoints`
// via a cast rather than depending on internal types.
interface ServingLike {
  config?: {
    endpoints?: Record<string, { env: string; servedModel?: string }>;
  };
}

type AppkitMastraMemoryConfig = PgVectorConfig & {
  id?: string;
};

interface AppkitMastraConfig extends BasePluginConfig {
  /** Optional alias on the sibling `serving` plugin used to resolve the
   *  model endpoint. Defaults to `"default"`. */
  servingAlias?: string;
  /** Optional Mastra provider id to publish via `OpenAICompatibleConfig`.
   *  Defaults to `"databricks"`. */
  providerId?: string;
  /** PostgresStore for Mastra threads/messages. `true` reuses the
   *  `lakebase` plugin's pool. */
  storage?: boolean | PostgresStoreConfig;
  /** PgVector store for Mastra memory recall. `true` reuses the
   *  `lakebase` plugin's pool. */
  memory?: boolean | AppkitMastraMemoryConfig;
}

export class AppkitMastra extends Plugin<AppkitMastraConfig> {
  static manifest = {
    name: "appkit-mastra",
    displayName: "Appkit Mastra",
    description:
      "Builds a Mastra Agent from AppKit plugins. Resolves the model " +
      "endpoint via the `serving` plugin (user-scoped via asUser) and " +
      "wires Postgres-backed Mastra Memory via the `lakebase` plugin.",
    stability: "beta",
    resources: {
      required: [...SERVING_MANIFEST.resources.required],
      optional: [
        ...GENIE_MANIFEST.resources.required,
        ...LAKEBASE_MANIFEST.resources.required,
      ],
    },
  } satisfies PluginManifest<"appkit-mastra">;

  /**
   * Tighten resource requirements based on which features are enabled.
   * AppKit calls this at registration time (config-aware) so disabled
   * features don't surface their resource asks to the host app.
   */
  static getResourceRequirements(
    config: AppkitMastraConfig,
  ): ResourceRequirement[] {
    const resources: ResourceRequirement[] = [];
    const enabledManifests: PluginManifest<string>[] = [];

    if (!!config.storage || !!config.memory) {
      enabledManifests.push(LAKEBASE_MANIFEST);
    }
    for (const m of enabledManifests) {
      for (const resource of m.resources.required) {
        resources.push({ ...resource, required: true } as ResourceRequirement);
      }
    }
    return resources;
  }

  private defaultAgent: Agent | null = null;
  private mastra: Mastra | null = null;
  private servingEndpointName?: string;

  override async setup(): Promise<void> {
    // The serving + lakebase plugins both finish their own `setup()`
    // before `setup:complete` fires, so we resolve the endpoint name
    // and build the agent there. Hook is async to leave room for any
    // future awaitable setup (the current synchronous body is fine).
    this.context?.onLifecycle("setup:complete", async () => {
      this.servingEndpointName = this.resolveServingEndpointName();
      this.registerDefaultAgent();
    });
  }

  override exports() {
    return {
      getDefault: () => this.defaultAgent,
      getMastra: () => this.mastra,
    };
  }

  override clientConfig(): Record<string, unknown> {
    return { defaultAgent: DEFAULT_AGENT_ID };
  }

  override injectRoutes(router: IAppRouter): void {
    // Mirror Mastra's defaults: a single streaming chat endpoint that
    // emits an AI SDK v5 UI Message Stream (consumable by `useChat`),
    // plus a small `/info` describing the agent. No `:agentId` in the
    // URL because this plugin owns a single hardcoded default agent.
    this.route(router, {
      name: "chat",
      method: "post",
      path: "/chat",
      handler: async (req, res) => {
        await this.asUser(req).handleChat(req, res);
      },
    });
    this.route(router, {
      name: "info",
      method: "get",
      path: "/info",
      handler: async (_req, res) => {
        const info: MastraInfoResponse = {
          defaultAgent: DEFAULT_AGENT_ID,
          servingEndpoint: this.servingEndpointName ?? null,
        };
        res.json(info);
      },
    });
  }

  /**
   * Streams the default agent's response in AI SDK v5 UI Message Stream
   * format. Delegates the entire transform from Mastra's `fullStream`
   * to the wire protocol to `handleChatStream` (from `@mastra/ai-sdk`)
   * and `createUIMessageStreamResponse` (from `ai`). Runs inside
   * `asUser(req)` so the per-request bearer minted by `buildModel()`
   * resolves to the calling user.
   */
  async handleChat(req: express.Request, res: express.Response): Promise<void> {
    if (!this.mastra || !this.defaultAgent) {
      res.status(503).json({ error: "Agent registry not ready" });
      return;
    }

    const parsed = mastraChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid chat request body",
        issues: parsed.error.issues,
      });
      return;
    }

    // The AI SDK v5 `useChat` body bundles `messages`, `id`, `trigger`,
    // plus any custom `body` fields the client merged in. Mastra's
    // `handleChatStream` accepts that shape directly and threads
    // `memory: { thread, resource }` through into `agent.stream`, so
    // there is nothing to massage here.
    const stream = await handleChatStream({
      mastra: this.mastra,
      agentId: DEFAULT_AGENT_ID,
      params: parsed.data,
      sendReasoning: true,
    });

    const response = createUIMessageStreamResponse({ stream });
    pipeWebResponseToExpress(response, res);
  }

  /**
   * Builds a Mastra `DynamicArgument<MastraModelConfig>` that resolves
   * a user-scoped `OpenAICompatibleConfig` lazily, once per agent call.
   * The factory closes over the resolved endpoint name and reads the
   * active execution context at invocation time, so a single agent
   * instance can serve concurrent requests with distinct user
   * identities.
   *
   * We return a function (not a resolved config) so the bearer token
   * is minted *after* `agent.stream` enters the `runInUserContext`
   * scope established by `this.asUser(req)`. Outside an active user
   * context (e.g. ad-hoc internal calls), `getExecutionContext()` falls
   * back to the service principal context, which is still a valid
   * token source.
   */
  private buildModel(): DynamicArgument<MastraModelConfig> {
    const endpointName = this.servingEndpointName;
    if (!endpointName) {
      throw new Error(
        "appkit-mastra: serving endpoint name was not resolved at setup. " +
          "Check the `serving` plugin's env var (default " +
          "DATABRICKS_SERVING_ENDPOINT_NAME) and `servingAlias` config.",
      );
    }
    const providerId = this.config.providerId ?? "databricks";
    return async (): Promise<OpenAICompatibleConfig> => {
      const ctx = getExecutionContext();
      const config = ctx.client.config;
      const host = await config.getHost();
      const headers = new Headers();
      await config.authenticate(headers);
      const authz = headers.get("Authorization") ?? "";
      const apiKey = authz.replace(/^Bearer\s+/i, "");
      // The OpenAI Node SDK appends paths like `/chat/completions` to
      // whatever URL we hand it. Drop the trailing slash so the
      // resulting URL stays well-formed
      // (`/serving-endpoints/chat/completions`).
      const url = new URL("/serving-endpoints", host).toString().replace(/\/$/, "");
      return {
        providerId,
        modelId: endpointName,
        url,
        apiKey,
      };
    };
  }

  /**
   * Reads the sibling `serving` plugin's endpoints config and resolves
   * the env var bound to `servingAlias`. Returns the endpoint name
   * string (e.g. `"databricks-claude-sonnet-4-6"`) so we can plumb it
   * into the Mastra model factory as the `modelId`.
   */
  private resolveServingEndpointName(): string | undefined {
    const alias = this.config.servingAlias ?? DEFAULT_SERVING_ALIAS;
    const ctx = this.context;
    const servingPlugin = ctx?.getPlugins().get("serving") as
      | (ServingLike & Plugin)
      | undefined;
    const endpoints = servingPlugin?.config?.endpoints;
    const endpointConfig = endpoints?.[alias];
    if (!endpointConfig) {
      throw new Error(
        `appkit-mastra: serving alias '${alias}' is not configured. ` +
          "Add it to the `serving({ endpoints: { ... } })` plugin or change " +
          "`servingAlias` on appkitMastra().",
      );
    }
    const name = process.env[endpointConfig.env];
    if (!name) {
      throw new Error(
        `appkit-mastra: env var '${endpointConfig.env}' for serving alias ` +
          `'${alias}' is not set. Cannot resolve the model serving endpoint.`,
      );
    }
    return name;
  }

  private registerDefaultAgent(): void {
    // Resolve the Lakebase pool once. Both PostgresStore and PgVector
    // share it: PostgresStore accepts `{ pool }` natively; PgVector
    // doesn't, so we use the swap-after-construct trick documented on
    // `pgVector`.
    const pool = this.needsLakebase() ? this.lakebasePool() : undefined;
    const storage = this.pgStore(pool);
    const vector = this.pgVector(pool);
    const memory =
      storage || vector
        ? new Memory({
            ...(storage ? { storage } : {}),
            ...(vector ? { vector } : {}),
          })
        : undefined;
    // Single hardcoded analyst agent. The agent's `model` is a Mastra
    // `DynamicArgument` that resolves the serving endpoint + bearer at
    // call time, so the same Agent instance serves concurrent requests
    // with distinct user identities. Inside `handleChat` the factory
    // runs in the `asUser(req)` async scope, so `getExecutionContext()`
    // returns the user context.
    this.defaultAgent = new Agent({
      id: DEFAULT_AGENT_ID,
      name: "Analyst",
      instructions: ANALYST_INSTRUCTIONS,
      model: this.buildModel(),
      tools: {},
      ...(memory ? { memory } : {}),
    });

    // `handleChatStream` from `@mastra/ai-sdk` looks the agent up on a
    // `Mastra` instance by id. Building the smallest possible Mastra
    // here (just our default agent, no workflows, no shared storage)
    // keeps this plugin self-contained.
    this.mastra = new Mastra({
      agents: { [DEFAULT_AGENT_ID]: this.defaultAgent },
    });
  }

  private needsLakebase(): boolean {
    return this.config.storage === true || this.config.memory === true;
  }

  private pgStore(pool: Pool | undefined): PostgresStore | undefined {
    if (!this.config.storage) return undefined;
    if (typeof this.config.storage === "boolean") {
      if (!pool) {
        throw new Error("appkit-mastra: lakebase pool missing for storage");
      }
      return new PostgresStore({ id: "appkit-mastra-store", pool });
    }
    return new PostgresStore(this.config.storage);
  }

  /**
   * Builds a `PgVector` that delegates to the lakebase plugin's pool.
   *
   * PgVector's constructor accepts only connection-style configs
   * (`HostConfig` / `ConnectionStringConfig` / `ClientConfig`); there
   * is no `{ pool }` shorthand the way `PostgresStore` has one. Worse,
   * the constructor synchronously kicks off a `cacheWarmupPromise`
   * IIFE that calls `this.pool.connect()` before returning, so we
   * can't cleanly hand it an inert config and patch the pool
   * afterwards.
   *
   * The trick: pass illegal-but-validation-passing placeholders so the
   * warmup's `net.connect()` rejects synchronously with `RangeError`
   * (because Node validates port 0 <= port < 65536). The IIFE's
   * `catch {}` swallows it, no DNS lookup or TCP attempt happens, and
   * we then swap `pgVector.pool` to the lakebase pool. Every
   * subsequent PgVector method reads `this.pool` at call time, so all
   * real I/O goes through the lakebase pool from then on. The
   * placeholder pool is `.end()`'d so its socket book-keeping is
   * released.
   */
  private pgVector(pool: Pool | undefined): PgVector | undefined {
    if (!this.config.memory) return undefined;
    if (typeof this.config.memory === "boolean") {
      if (!pool) {
        throw new Error("appkit-mastra: lakebase pool missing for memory");
      }
      const vector = new PgVector({
        id: "appkit-mastra-memory",
        host: "-1",
        port: -1,
        database: "_",
        user: "_",
        password: "_",
      });
      const placeholder = vector.pool;
      vector.pool = pool;
      void placeholder.end().catch(() => undefined);
      return vector;
    }
    return new PgVector(this.config.memory);
  }

  /**
   * Looks up the `lakebase` plugin and returns its managed `pg.Pool`.
   * Throws if the sibling plugin isn't registered, since enabling
   * `storage` / `memory` without lakebase is a wiring bug, not a
   * runtime condition we can recover from.
   */
  private lakebasePool(): Pool {
    return this.pluginExports<LakebasePluginExports>("lakebase").pool;
  }

  private pluginExports<T>(pluginName: string): T {
    const ctx = this.context;
    const plugin = ctx?.getPlugins().get(pluginName) as Plugin | undefined;
    if (!plugin) {
      throw new Error(`appkit-mastra: required plugin not found: ${pluginName}`);
    }
    return plugin.exports() as T;
  }
}

export const appkitMastra = toPlugin(AppkitMastra);

/**
 * Bridges a Web `Response` (from `createUIMessageStreamResponse`) to
 * the Node/Express response. Copies status + headers, then converts
 * the Web `ReadableStream` body to a Node `Readable` and pipes it. The
 * pipe takes care of backpressure and aborting on client disconnect.
 */
function pipeWebResponseToExpress(
  response: Response,
  res: express.Response,
): void {
  res.status(response.status);
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  if (!response.body) {
    res.end();
    return;
  }
  Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]).pipe(
    res,
  );
}
