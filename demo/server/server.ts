import { createApp, lakebase, server } from "@databricks/appkit";
import { autopg } from "@dbx-tools/appkit-autopg";
import { mastra } from "@dbx-tools/appkit-mastra";

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
// 2. The Mastra agent resolves the model from the workspace host plus
//    `/serving-endpoints` and user-scoped auth (`asUser(req)`). Add the
//    AppKit `serving()` plugin separately if you want bundle-driven
//    serving-endpoint resources or future `servingAlias` wiring.
// 3. `lakebase()` backs Mastra Memory (`PostgresStore` + `PgVector`) when
//    `storage` / `memory` are true on the mastra plugin.
//
// Required env vars (see .env.example):
// - DATABRICKS_SERVING_ENDPOINT_NAME=databricks-claude-sonnet-4-6
// - LAKEBASE_PROJECT (or LAKEBASE_ENDPOINT) - autopg fills in the rest

await autopg();

// `mastra({ agents })` accepts a registry of code-defined agents,
// mirroring AppKit's `agents()` plugin. Each entry's `tools` can be a
// plain record or a `(plugins) => tools` callback that receives a typed
// sibling-plugin index (currently just `genie`; extend `MastraPlugins`
// to surface more). Omit `agents` entirely to get a built-in default
// analyst.
await createApp({
  plugins: [
    server(),
    lakebase(),
    mastra({
      servingAlias: "default",
      storage: true,
      memory: true,
      // agents: {
      //   analyst: {
      //     instructions: "You are a data analyst...",
      //     tools(plugins) {
      //       return {
      //         ...(plugins.genie?.toolkit({ aliases: ["default"] }) ?? {}),
      //       };
      //     },
      //   },
      // },
    }),
  ],
});
