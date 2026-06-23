import { genie, lakebase, server } from "@databricks/appkit";
import { createApp } from "@dbx-tools/appkit-config";
import { email, emailTool } from "@dbx-tools/appkit-email";
import {
  createAgent,
  GENIE_INSTRUCTIONS,
  mastra,
  tool,
} from "@dbx-tools/appkit-mastra";
import { z } from "zod";

// AppKit demo wiring for `@dbx-tools/appkit-mastra`.
//
// `createApp` here is the auto-configuring wrapper from
// `@dbx-tools/appkit-config`, not AppKit's own. Because a `lakebase()`
// plugin is in the list, it runs `autopg()` BEFORE delegating to
// AppKit's `createApp` - resolving LAKEBASE_ENDPOINT / PGHOST /
// PGDATABASE via the Databricks Postgres REST API and writing them to
// `process.env` so the lakebase plugin sees a fully-populated env. This
// runs up front (not as a plugin) because AppKit's plugin phases only
// order `setup()` invocation, not async completion, so a plugin would
// race lakebase's synchronous env validation.
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
    "You are a data analyst helping customers explore a Databricks",
    "Genie space. Default to driving the Genie tools (`ask_genie`,",
    "`get_statement`, `prepare_chart`, `get_space_description`,",
    "`get_space_serialized`) below - they are the only way to see",
    "the real data, so use them whenever the user's question is",
    "about the data the space covers. Reserve direct (no-tool)",
    "answers for pure meta-questions about your own behaviour or",
    "the conversation itself.",
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
      // Approval-gated email tool from `@dbx-tools/appkit-email`. The
      // model can call this freely; execution pauses until the user
      // clicks Approve in the chat UI, then the message is sent for
      // real over SMTP. The sender is derived from the on-behalf-of
      // user's email on the configured `EMAIL_DOMAIN`; SMTP host /
      // credentials come from the `email()` plugin config / env.
      send_email: emailTool(),
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
    genie(),
    lakebase(),
    // Validates SMTP config + verifies connectivity at startup, and
    // primes the transport the approval-gated `send_email` tool reuses.
    email(),
    mastra({
      storage: true,
      memory: true,
      agents: support,
    }),
  ],
  cache: {
    enabled: true,
  },
});
