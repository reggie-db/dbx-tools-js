import { createApp, genie, lakebase, server } from "@databricks/appkit";
import { autopg } from "@dbx-tools/appkit-autopg";
import {
  buildEmailTool,
  createAgent,
  GENIE_INSTRUCTIONS,
  mastra,
  tool,
} from "@dbx-tools/appkit-mastra";
import { z } from "zod";

// AppKit demo wiring for `@dbx-tools/appkit-mastra`.
//
// `autopg()` runs BEFORE `createApp(...)` because AppKit's plugin
// phases only order `setup()` invocation, not async completion - if
// autopg were a plugin it would race lakebase's sync env validation.
// As a top-level helper it resolves LAKEBASE_ENDPOINT / PGHOST /
// PGDATABASE via the Databricks Postgres REST API and writes them to
// `process.env` so the lakebase plugin sees a fully-populated env.
//
// Plugin order:
// 1. `server()` and `lakebase()` register before `mastra()` so the
//    `setup:complete` lifecycle hook can open the Lakebase pool when
//    Mastra storage/memory are enabled.
// 2. `mastra(...)` mounts a chat route per registered agent under
//    `/api/mastra/route/chat/<agentId>` (plus `/route/chat` bound to
//    the default). Each agent resolves its model from the workspace
//    `/serving-endpoints` with user-scoped auth (`asUser(req)`).
// 3. `lakebase()` backs Mastra Memory (`PostgresStore` + `PgVector`)
//    when `storage` / `memory` are true on the mastra plugin.
//
// Genie integration: register the AppKit `genie()` plugin for its
// resource manifest (so `app.yaml` picks up the Genie space binding)
// and its `spaces` config format. The `mastra()` plugin's
// `plugins.genie?.toolkit()` callback returns a flat set of Genie
// tools (`ask_genie`, `get_statement`, `prepare_chart`,
// `get_space_description`, `get_space_serialized`) the central
// agent drives directly. The tools talk to Genie via
// `@dbx-tools/genie` for streaming + `getStatement`-backed row
// hydration; no inner Genie orchestrator agent.
//
// Required env vars (see .env.example):
// - DATABRICKS_SERVING_ENDPOINT_NAME=databricks-claude-sonnet-4-6
// - LAKEBASE_PROJECT (or LAKEBASE_ENDPOINT) - autopg fills in the rest
// - DATABRICKS_GENIE_SPACE_ID - picked up by `genie()` as the
//   `default` space when `spaces` is omitted.

await autopg();

// Agents are declared the same way as AppKit's `agents` plugin:
// build each definition with `createAgent({...})` (a no-op identity
// helper for inference), then hand it to `mastra({ agents })`.
//
// `agents` accepts three shapes for convenience:
//   - record:  `{ support: def, helper: def }`
//   - array:   `[def1, def2]`            (first becomes the default)
//   - single:  `def`                     (becomes the default)
//
// The `tools(plugins)` callback receives a typed plugin index that
// auto-discovers any registered AppKit `ToolProvider` plugin
// (`analytics`, `files`, `lakebase`, `genie`, ...). Unknown names
// return `undefined` so it's safe to guard with `?.`.
//
// `model` falls back to `DATABRICKS_SERVING_ENDPOINT_NAME` then to a
// built-in default. Whatever id wins is fuzzy-matched against the
// workspace's live `/serving-endpoints` list (cached for 5 min), so
// loose values like `"claude sonnet"` snap to the real endpoint name.
// Per-request overrides via `X-Mastra-Model` header, `?model=` query,
// or body `model` field can re-target the same agent without redeploy.
// `GET /api/mastra/models` lists the cached catalogue.
const support = createAgent({
  name: "support",
  instructions: [
    "You help customers with data. When a question needs a SQL query,",
    "drive the Genie tools (`ask_genie`, `get_statement`,",
    "`prepare_chart`, `get_space_description`, `get_space_serialized`)",
    "below. For general help / definitions / clarifications, answer",
    "directly without calling them.",
    "",
    GENIE_INSTRUCTIONS,
  ].join("\n"),
  tools(plugins) {
    return {
      // Auto-discovered AppKit `ToolProvider` plugins. `plugins.<name>`
      // is `undefined` when the plugin isn't registered, so the `?.`
      // guard keeps this safe to copy into other apps. Spread the
      // built-in Genie toolkit so the agent can ask the Genie space
      // (`DATABRICKS_GENIE_SPACE_ID`) for SQL-backed answers.
      ...(plugins.genie?.toolkit() ?? {}),
      // Spread other toolkits once registered (uncomment alongside
      // adding `analytics()` / `files()` to the plugin list below):
      // ...plugins.analytics.toolkit(),
      // ...plugins.files.toolkit({ only: ["uploads.read"] }),
      get_weather: tool({
        description: "Weather",
        schema: z.object({ city: z.string() }),
        execute: async ({ city }) => `Sunny in ${city}`,
      }),
      // Approval-gated email tool. The model can call this freely;
      // execution is paused until the user clicks Approve in the
      // chat UI. The default execute body just logs the would-be
      // email to the server console (see `buildEmailTool`'s
      // `send` option to swap in a real provider).
      send_email: buildEmailTool(),
    };
  },
});

// Bind to loopback (`127.0.0.1`) locally so the dev server isn't
// exposed on the LAN, but fall back to `0.0.0.0` when the Databricks
// Apps platform is running us (it sets `DATABRICKS_APP_PORT` and
// reaches the container over the LAN-bound interface, so anything
// else won't accept traffic). Override with `HOST=...` if you need a
// different bind address for a local tunnel.
const isDatabricksApp = Boolean(process.env.DATABRICKS_APP_PORT);
const host = process.env.HOST ?? (isDatabricksApp ? "0.0.0.0" : "127.0.0.1");

await createApp({
  plugins: [
    server({ host }),
    // `genie()` with no config reads `DATABRICKS_GENIE_SPACE_ID`
    // from the env and registers it as the `default` alias. The
    // `mastra()` plugin's `plugins.genie?.toolkit()` callback
    // auto-discovers these spaces and surfaces a flat set of
    // Genie tools (`ask_genie`, `get_statement`, `prepare_chart`,
    // `get_space_description`, `get_space_serialized`) to the
    // calling agent. Pass `genie({ spaces: { sales: "...", ops:
    // "..." } })` to wire multiple aliases (per-space tools then
    // get suffixed as `ask_genie_sales`, `ask_genie_ops`, ...),
    // or set `mastra({ genieSpaces: { ... } })` if you want to
    // declare them on the Mastra plugin directly.
    genie(),
    lakebase(),
    mastra({
      storage: true,
      memory: true,
      agents: support,
    }),
  ],
});
