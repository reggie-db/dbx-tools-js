import { createApp, lakebase, server } from "@databricks/appkit";
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
  instructions: "You help customers with data and files.",
  tools(plugins) {
    return {
      // Spread sibling plugin toolkits (uncomment once `analytics()` /
      // `files()` are added to the plugin list below):
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

await createApp({
  plugins: [
    server(),
    lakebase(),
    mastra({
      storage: true,
      memory: true,
      agents: support,
    }),
  ],
});
