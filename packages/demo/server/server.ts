import { createApp, lakebase, server, serving } from "@databricks/appkit";
import { appkitMastra } from "@dbx-tools/appkit-mastra";

// AppKit demo wiring for `@dbx-tools/appkit-mastra`.
//
// Plugin order:
// 1. `server()` + `serving()` + `lakebase()` must register before
//    `appkitMastra()` so its `setup:complete` lifecycle hook can read
//    the resolved serving endpoint name and lakebase `pg.Pool`.
// 2. `serving()` exposes the model endpoint that appkit-mastra resolves
//    via `servingAlias`. The Mastra agent calls the workspace via the
//    OpenAI-compatible base URL (`/serving-endpoints`) using a fresh
//    user-scoped bearer minted via `asUser(req)` per request.
// 3. `lakebase()` backs Mastra's `Memory` (`PostgresStore` + `PgVector`)
//    with the workspace's Lakebase Postgres pool, so threads and recall
//    vectors live in the user's Lakebase instance.
//
// Required env vars (see .env.example):
// - DATABRICKS_SERVING_ENDPOINT_NAME=databricks-claude-sonnet-4-6
// - LAKEBASE_* (instance + database names, etc.)

await createApp({
  plugins: [
    server(),
    serving({
      endpoints: {
        default: { env: "DATABRICKS_SERVING_ENDPOINT_NAME" },
      },
    }),
    lakebase(),
    appkitMastra({
      servingAlias: "default",
      storage: true,
      memory: true,
    }),
  ],
});
