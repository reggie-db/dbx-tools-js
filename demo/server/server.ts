import { createApp, genie, lakebase, server } from "@databricks/appkit";
import { autopg } from "@dbx-tools/appkit-autopg";
import { createAgent, mastra, tool } from "@dbx-tools/appkit-mastra";
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
// Required env vars (see .env.example):
// - DATABRICKS_SERVING_ENDPOINT_NAME=databricks-claude-sonnet-4-6
// - LAKEBASE_PROJECT (or LAKEBASE_ENDPOINT) - autopg fills in the rest
// - DATABRICKS_GENIE_SPACE_ID - registered automatically as the
//   `default` space by `genie()` when no `spaces` config is passed

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
    "call Genie. For general help / definitions / clarifications,",
    "answer directly without calling Genie.",
    "",
    "Issue ONE Genie call per turn (don't shop for phrasings; ask the",
    "user to clarify if the answer doesn't fit). Reuse the previous",
    "`conversationId` to follow up in the same thread. Prefer",
    "aggregated queries for time-series and distributions.",
    "",
    "To display a dataset as a chart, embed `[[chart:<chartId>]]` on",
    "its own line where the chart should appear. Add interpretation",
    "around the chart; quote specific numbers Genie called out in",
    "`genieAnswer` exactly when you reference them.",
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
    };
  },
});

// Bind to loopback (`127.0.0.1`) locally so a dev server isn't
// exposed on the LAN, but fall back to `0.0.0.0` when the Databricks
// Apps platform is running us (it sets `DATABRICKS_APP_PORT` and
// reaches the container over the LAN-bound interface, so anything
// else won't accept traffic). Override with `FLASK_RUN_HOST=...` if
// you need a different bind address for a local tunnel.
const isDatabricksApp = Boolean(process.env.DATABRICKS_APP_PORT);
const host = process.env.FLASK_RUN_HOST ?? (isDatabricksApp ? "0.0.0.0" : "127.0.0.1");

await createApp({
  plugins: [
    server({ host }),
    // `genie()` with no config reads `DATABRICKS_GENIE_SPACE_ID` from
    // the env and registers it as the `default` alias. Pass
    // `genie({ spaces: { sales: "...", ops: "..." } })` to register
    // multiple aliases; each becomes a separate tool the LLM can pick.
    genie(),
    lakebase(),
    mastra({
      storage: true,
      memory: true,
      agents: support,
    }),
  ],
});
