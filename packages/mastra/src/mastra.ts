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
import express from "express";
import { randomUUID } from "node:crypto";
import { chatRoute } from "@mastra/ai-sdk";
import { Agent } from "@mastra/core/agent";
import type { AgentMemoryOption } from "@mastra/core/agent";
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
  parseCookies,
  pluginLogger,
  requirePlugin,
  toUnderscoreCase,
} from "@dbx-tools/appkit-shared";

import type { Pool } from "pg";
import { MastraServer } from "@mastra/express";
import { fastembed } from "@mastra/fastembed";

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
// - HTTP: routes are auto-mounted at `/api/mastra/...` by the server
//   plugin. `injectRoutes` mounts a `MastraServer` (from
//   `@mastra/express`) at the plugin root with no extra prefix, exposing
//   Mastra's REST surface (`/agents/...`, `/memory/...`, etc.) plus our
//   `chatRoute()` at `/chat`. The full client URL for AI SDK `useChat`
//   is therefore `/api/mastra/chat`.


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

// Structural view of the `serving` plugin instance we read at setup
// time. The plugin's `config` is `protected`, so we access `endpoints`
// via a cast rather than depending on internal types.
interface ServingLike {
  config?: {
    endpoints?: Record<string, { env: string; servedModel?: string }>;
  };
}

type MastraMemoryConfig = PgVectorConfig & {
  id?: string;
};



interface MastraPluginConfig extends BasePluginConfig {
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
  memory?: boolean | MastraMemoryConfig;
}



export class MastraPlugin extends Plugin<MastraPluginConfig> {
  static manifest = {
    name: "mastra",
    displayName: "Mastra",
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
  } satisfies PluginManifest<"mastra">;

  /**
   * Tighten resource requirements based on which features are enabled.
   * AppKit calls this at registration time (config-aware) so disabled
   * features don't surface their resource asks to the host app.
   */
  static getResourceRequirements(
    config: MastraPluginConfig,
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
  private log = pluginLogger(this);
  private defaultAgent: Agent | null = null;
  private mastra: Mastra | null = null;
  private mastraApp: express.Express | null = null;
  private mastraServer: MastraServer | null = null;
  private servingEndpointName?: string;

  override async setup(): Promise<void> {
    // The serving + lakebase plugins both finish their own `setup()`
    // before `setup:complete` fires, so we resolve the endpoint name
    // and build the agent there. Hook is async to leave room for any
    // future awaitable setup (the current synchronous body is fine).
    this.context?.onLifecycle("setup:complete", async () => {
      this.log.info("setup:complete");
      this.servingEndpointName = this.resolveServingEndpointName();
      await this.setupMastra();
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
    router.use(this.cookieIdMiddleware())
    router.use("", (req, res, next) => {
      if (!this.mastraApp) return res.status(503).end();
      return this.asUser(req).mastraApp!(req, res, next);
    });
  }

  /**
   * Issues two cookies on the first request from a browser and reads
   * them back on subsequent ones:
   *
   * - `mastra_client_id`: long-lived (1 year). Stable across browser
   *   restarts. Useful for analytics, anonymous personalization, and
   *   default `memory.resource` if no authenticated user is present.
   * - `mastra_session_id`: session-scoped (no Max-Age). The browser
   *   drops it on close. Used as a default `memory.thread` when the
   *   client doesn't pass one explicitly.
   *
   * Same-origin AI SDK calls (`useChat` -> `fetch` to
   * `/api/mastra/chat`) include cookies automatically, so downstream
   * chat handlers can rely on these IDs without changes on the
   * frontend.
   *
   * Both cookies are `HttpOnly` (no JS access, mitigates XSS),
   * `SameSite=Lax`, and `Secure` outside development.
   */
  private cookieIdMiddleware(): express.RequestHandler {
    const pluginName = this.config?.name!;
    return (req, res, next) => {

      const cookies = parseCookies(req.headers.cookie);
      for (const [name, session_cookie] of Object.entries({
        clientId: false,
        sessionId: true,
      })) {
        const cookieName = toUnderscoreCase(true, pluginName, name);
        var cookieValue = cookies[cookieName];
        if (!cookieValue) {
          cookieValue = randomUUID();
          const maxAge = session_cookie ? undefined : 1000 * 60 * 60 * 24 * 365
          res.cookie(cookieName, cookieValue, {
            httpOnly: true,
            sameSite: "lax",
            secure: req.secure,
            path: '/',
            ...(maxAge ? { maxAge } : {}),
          });
        }
        res.locals[name] = cookieValue;
      }
      next();
    }
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
        `mastra: serving alias '${alias}' is not configured. ` +
        "Add it to the `serving({ endpoints: { ... } })` plugin or change " +
        "`servingAlias` on mastra().",
      );
    }
    const name = process.env[endpointConfig.env];
    if (!name) {
      throw new Error(
        `mastra: env var '${endpointConfig.env}' for serving alias ` +
        `'${alias}' is not set. Cannot resolve the model serving endpoint.`,
      );
    }
    return name;
  }

  private async setupMastra(): Promise<void> {
    // Resolve the Lakebase pool once. Both PostgresStore and PgVector
    // share it: PostgresStore accepts `{ pool }` natively; PgVector
    // doesn't, so we use the swap-after-construct trick documented on
    // `pgVector`.
    const memory = this.buildMemory();
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

    // Smallest possible Mastra: one agent. `mastra.server.apiRoutes` is
    // only honored by Mastra's standalone dev server (port 4111). Since
    // we're hosting Mastra inside our own Express app via the
    // `@mastra/express` adapter, custom routes must be passed to the
    // `MastraServer` constructor directly via `customApiRoutes` below.
    this.mastra = new Mastra({
      agents: { [DEFAULT_AGENT_ID]: this.defaultAgent },
    });
    this.mastraApp = express();
    this.attachRoutePatchMiddleware(this.mastraApp);
    this.mastraServer = new MastraServer({
      app: this.mastraApp,
      mastra: this.mastra!,
      prefix: "",
      customApiRoutes: [
        chatRoute({ path: "/route/chat", agent: DEFAULT_AGENT_ID }),
      ],
    });
    await this.mastraServer.init();
  }

  private buildMemory(): Memory | undefined {
    if (!this.needsLakebase()) return undefined;
    const pool = this.lakebasePool();
    return new Memory({
      storage: this.pgStore(pool),
      vector: this.pgVector(pool),
      embedder: fastembed,
      options: {
        lastMessages: 10,
        semanticRecall: {
          topK: 3,
          messageRange: 2,
        }
      }
    })
  }

  /**
   * Patches around `@mastra/express`'s custom-route dispatcher so
   * `chatRoute` works when MastraServer is hosted on an express subapp
   * mounted under a parent path (e.g. `/api/mastra`).
   *
   * Two concerns:
   *
   * 1. The adapter's `registerCustomApiRoutes` matches against
   *    `req.path` (mount-relative, correct) but dispatches to its
   *    internal Hono mini-app using `req.originalUrl`, which still
   *    contains the parent mount prefix. The Hono app has the route
   *    registered at the literal path (`/chat`), so it never matches
   *    the absolute URL and the request silently falls through. We
   *    overwrite `originalUrl` for `/chat` and `/chat/*` so the Hono
   *    dispatcher sees the route's literal path.
   *
   * 2. `memory.resource` must be the authenticated user, not whatever
   *    the client posts. The custom-route forwarder re-serializes
   *    `req.body` into the Request body it hands Hono, so mutating the
   *    parsed body here propagates into `handleChatStream`'s params.
   *    `express.json()` runs first so `req.body` is parsed.
   */
  private attachRoutePatchMiddleware(app: express.Express): void {
    app.use(express.json());
    app.use((req, res, next) => {
      const isChat = req.path === "/route" || req.path.startsWith("/route/");
      if (!isChat) return next();
      req.originalUrl = req.path;

      // Default memory wiring: `resource` is always the authenticated
      // user (server controls identity). `thread` defaults to the
      // session cookie when the client didn't send one, so a fresh tab
      // gets a fresh conversation without any client-side bookkeeping.
      const body = (req.body ?? {}) as Record<string, unknown>;
      const clientMemory =
        (body.memory ?? {}) as Partial<AgentMemoryOption>;
      var thread = clientMemory.thread
      if (!thread) {
        thread = res.locals.sessionId as string | undefined;
        if (thread) {
          this.log.info(`No thread provided, using sessionId: ${thread}`);
        }
      }
      var resource = clientMemory.resource
      if (!resource) {
        resource = this.resolveUserId(req);
        this.log.info(`No resource provided, using user id: ${resource}`);
      }
      body.memory = {
        ...clientMemory,
        thread: thread,
        resource: resource
      };
      this.log.info(`Request body: ${JSON.stringify(body)}`);
      req.body = body;
      next();
    });
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
        "mastra: serving endpoint name was not resolved at setup. " +
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

  private needsLakebase(): boolean {
    return this.config.storage === true || this.config.memory === true;
  }

  private pgStore(pool: Pool): PostgresStore | undefined {
    if (!this.config.storage) return undefined;
    if (typeof this.config.storage === "boolean") {
      if (!pool) {
        throw new Error("mastra: lakebase pool missing for storage");
      }
      return new PostgresStore({ id: "mastra-store", pool });
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
  private pgVector(pool: Pool): PgVector | undefined {
    if (!this.config.memory) return undefined;
    if (typeof this.config.memory === "boolean") {
      if (!pool) {
        throw new Error("mastra: lakebase pool missing for memory");
      }
      const vector = new PgVector({
        id: "mastra-memory",
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
    return requirePlugin(this.context, lakebase, "mastra")
      .exports()
      .pool;
  }
}

export const mastra = toPlugin(MastraPlugin);

