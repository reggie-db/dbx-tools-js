import { createApp, genie, lakebase, server, serving } from "@databricks/appkit";
import { agents } from "@databricks/appkit/beta";
import { dbxTools } from "@reggie-db/dbx-tools-appkit";
import { analystAgent } from "./agents/analyst.js";

// AppKit demo wiring for `appkit-plugin-dbx-tools` + `appkit-plugin-dbx-tools-ui`.
//
// Plugin order matters in two places:
// 1. `genie()` and `lakebase()` must appear before `dbxTools()` so they're
//    already registered when dbx-tools reads their context in setup().
// 2. `agents()` must come after `dbxTools()` so the tool registry is
//    populated by the time the agents plugin reads it.
//
// `lakebase()` will only successfully register if the LAKEBASE_* env vars
// are set (see .env.example). If they're absent, drop `lakebase()` from
// the plugins list - dbx-tools will silently skip wiring the memory
// tools and the agent gets `genie` only.

await createApp({
  plugins: [
    server(),
    serving({
      endpoints: {
        default: { env: "DATABRICKS_SERVING_ENDPOINT_NAME" },
      },
    }),
    genie(),
    lakebase(),
    dbxTools(),
    agents({
      dir: false,
      agents: { analyst: analystAgent },
      defaultAgent: "analyst",
    }),
  ],
});
