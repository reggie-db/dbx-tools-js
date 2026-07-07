# @dbx-tools/appkit-mastra

An AppKit plugin that hosts [Mastra](https://mastra.ai) agents inside a
Databricks App with user-scoped workspace auth (OBO), optional
Lakebase-backed memory, and the standard Mastra agent stream the React
client drives via `@mastra/client-js`.

Wiring it up looks the same as the AppKit
`[agents](https://developers.databricks.com/docs/appkit/v0/plugins/agents)`
plugin - same `createAgent` / `tool` helpers, same `tools(plugins)`
callback, same `ToolkitOptions`. Switching a given agent between the two
is a one-line import change.

The implementation lives under `src/`: agent registration in
`[agents.ts](src/agents.ts)`, the plugin + routes in
`[plugin.ts](src/plugin.ts)` / `[server.ts](src/server.ts)`, thread
history / listing in `[history.ts](src/history.ts)` /
`[threads.ts](src/threads.ts)`, Model Serving resolution in
`[model.ts](src/model.ts)` / `[serving.ts](src/serving.ts)`, Genie
tooling in `[genie.ts](src/genie.ts)`, the chart pipeline in
`[chart.ts](src/chart.ts)`, Databricks workspace mounts in
`[workspaces.ts](src/workspaces.ts)` / `[filesystems.ts](src/filesystems.ts)`,
and MLflow feedback logging in
`[mlflow.ts](src/mlflow.ts)` (over the shared REST helper in
`[rest.ts](src/rest.ts)`).

## Quick start

```ts
import { analytics, createApp, files, lakebase, server } from "@databricks/appkit";
import { createAgent, mastra, tool } from "@dbx-tools/appkit-mastra";
import { z } from "zod";

const support = createAgent({
  instructions: "You help customers with data and files.",
  tools(plugins) {
    return {
      ...plugins.analytics.toolkit(), // every analytics tool
      ...plugins.files.toolkit({ only: ["uploads.read"] }), // filtered subset
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
    analytics(),
    files(),
    // Drop `lakebase()` in and `mastra` auto-enables per-agent thread
    // storage plus shared semantic recall. Skip it for a stateless agent.
    lakebase(),
    mastra({ agents: support }),
  ],
});
```

`createAgent` is a no-op identity helper that anchors type inference;
`tool` is the AppKit-shaped factory (`{ description, schema, execute }`)
that adapts to Mastra's `createTool` under the hood. The full config
shapes (`MastraAgentDefinition`, the plugin config) - every field and
default - are typed in `[config.ts](src/config.ts)`.

On the React side, drop in the prebuilt chat UI from
`[@dbx-tools/appkit-mastra-ui](../appkit-mastra-ui)`; it wires itself
from the plugin's published client config and streams over
`@mastra/client-js`, so there's no transport code to write:

```tsx
import { MastraChat } from "@dbx-tools/appkit-mastra-ui/react";

export default function ChatPage() {
  return <MastraChat showModelPicker />;
}
```

## Memory + storage

With no config, memory and storage are driven entirely by whether the
`lakebase` plugin is registered:

- **No** `lakebase()` - the agent is fully stateless: no threads, no
  recall.
- `lakebase()` **registered** - both auto-enable. Each agent gets its
  own `PostgresStore` schema (threads stay isolated per agent); every
  agent shares one `PgVector` semantic-recall index.

Override per plugin or per agent by passing `memory` / `storage` as
`false` (opt out), `true` (explicit on), or a config object (dedicated
index / schema). The fields are typed in `[config.ts](src/config.ts)`;
the wiring is in `[memory.ts](src/memory.ts)`.

## Workspace and Assistant skills

Every `createAgent` call applies a Mastra `Workspace` by default via
`createWorkspace()` (`[workspaces.ts](src/workspaces.ts)`). The
workspace is resolved per request and backed by the OBO user's
`WorkspaceClient` through `[filesystems.ts](src/filesystems.ts)`.

Unless you opt out, `assistantSkills: true` mounts read-only Databricks
trees where Mastra looks for `SKILL.md` files:

| Databricks path                    | Workspace mount          |
| ---------------------------------- | ------------------------ |
| `/Workspace/.assistant/skills`     | `/workspace_skills`      |
| `/Users/<email>/.assistant/skills` | `/workspace_user_skills` |

Production mounts require `workspace` or `all-apis` on the forwarded
access token. `[server.ts](src/server.ts)` stamps parsed scopes on
`MASTRA_SCOPES_KEY` using `tokenUtils` from `@dbx-tools/shared`.
`NODE_ENV=development` skips the scope gate.

```ts
import { createAgent, createWorkspace } from "@dbx-tools/appkit-mastra";

// Default: Assistant skills on.
const support = createAgent({ instructions: "..." });

// Extra per-request mounts (merged with built-in skill mounts).
const analyst = createAgent({
  instructions: "...",
  workspace: createWorkspace({
    mounts: [
      async () => ({
        mounts: { "/data": myFilesystem },
        skillPaths: [],
      }),
    ],
  }),
});

// Disable built-in skill mounts.
const bare = createAgent({
  instructions: "...",
  workspace: createWorkspace({ assistantSkills: false }),
});
```

Exported for direct use: `createWorkspace`, `DatabricksWorkspaceFilesystem`,
`emptyFilesystem`, and path helpers (`normalizeDatabricksBasePath`,
`isDbfsPath`, `resolveDatabricksAbsolutePath`, ...).

## Conversations (threads)

When storage is on, a user owns many conversation threads. The plugin
resolves the thread a request targets from `RequestContext`, in order:

1. A **client-selected thread id** - the thread-selection header
   (`x-mastra-thread-id`) or `?threadId=` query. This is how the chat UI
   references a specific conversation: it picks an id from the threads
   listing (or mints one for a new chat) and stamps it on every call, so
   streaming, history, and clear all target that thread.
2. The **per-session cookie** (`appkit_<plugin-name>_session_id`), minted
   on first contact, as the single-thread fallback for clients that
   don't manage threads explicitly.

The thread id pins both `agent.stream()` persistence and the history /
threads routes, so client and server can never disagree on which
conversation is active. Two custom routes back the UI's conversation
management (registered alongside `/route/history`):

- `GET /route/threads` (`/route/threads/:agentId`) - one page of the
  caller's threads, newest first, **scoped to the caller's resource** so
  a user only ever sees their own conversations.
- `DELETE /route/threads` - delete the targeted thread (id from the
  thread-selection header). Ownership is enforced server-side: a thread
  is only removed when it belongs to the caller.
- `PATCH /route/threads` - rename the targeted thread (id from the
  thread-selection header) to the `{ title }` in the JSON body. Same
  ownership enforcement; existing thread metadata is preserved.

Each thread is auto-titled from its opening turn (Mastra's
`generateTitle`), but titling runs on the **small / fast chat tier**
(`ModelClass.ChatFast`) via the dedicated summarizer in
`[summarize.ts](src/summarize.ts)` - not the agent's primary model - so
naming a conversation never spends the heavyweight model. The route
handlers live in `[threads.ts](src/threads.ts)`; the thread-id
resolution is in `[server.ts](src/server.ts)`. The drop-in `MastraChat`
from `@dbx-tools/appkit-mastra-ui` renders the whole conversation sidebar
over these routes with no extra wiring.

### Summarization (`summarize` tool)

Every agent gets a system-default ambient `summarize` tool that condenses
arbitrary text (long content, notes, transcripts, bulky tool results) on
the small / fast chat tier instead of the agent's primary model. It takes
`text` plus optional `instructions` (e.g. "one sentence", "list the action
items") and a `maxWords` soft cap, and returns `{ summary }`. The same
small-tier summarizer backs conversation titling above. Shadow it by
defining a same-named tool in `config.tools` (or a per-agent `tools`), and
reuse it programmatically via the exported `summarizeText(config, text, opts)` / `buildSummarizeTool(config)`.

## The `tools(plugins)` callback

Each agent supplies either a static `tools: { ... }` record or a
`tools(plugins)` callback. The returned record accepts any tool shape
Mastra understands - Mastra `createTool` tools, AppKit-shaped `tool()`
tools, Vercel AI SDK tools, provider-defined tools, and toolkits from
`plugins.<name>.toolkit(...)`.

```ts
tools(plugins) {
  return {
    ...plugins.analytics.toolkit(),                       // every analytics tool
    ...plugins.files.toolkit({ only: ["uploads.read"] }), // filtered subset
    get_weather: tool({
      description: "Weather",
      schema: z.object({ city: z.string() }),
      execute: async ({ city }) => `Sunny in ${city}`,
    }),
  };
}
```

`plugins` is a runtime Proxy that auto-discovers any registered AppKit
`ToolProvider` plugin (`analytics`, `files`, `lakebase`, `genie`, and
any third-party plugin implementing the standard toolkit interface).
Tool calls dispatch through the plugin's `executeAgentTool`, so OBO auth
and telemetry spans stay intact. Plugins that aren't registered resolve
to `undefined`, so guard optional backings with `?.` / `?? {}`.

`toolkit(opts)` takes the same `ToolkitOptions` AppKit exposes
(`prefix`, `only`, `except`, `rename`), passed through verbatim.

### `tool()` vs `createTool()`

`tool()` mirrors `@databricks/appkit/beta`'s shape so tool code is
portable between the AppKit `agents` plugin and this one. Reach for
Mastra's `createTool` when you need Mastra-only fields (`outputSchema`,
`suspendSchema`, `requireApproval`, `mcp`, ...). An omitted `tool()` `id`
is auto-derived from the description (slug + short hash) so traces stay
stable across runs.

## Genie

`plugins.genie` returns a flat set of Mastra tools the central agent
drives directly - no inner orchestrator agent. The agent asks the
configured Genie space focused sub-questions, embeds inline markers in
its prose, and the host UI resolves them (see [Embeds](#embeds)).

The orchestration prompt ships as the exported `GENIE_INSTRUCTIONS`
string; compose it into your agent's `instructions` to get the canonical
behavior:

```ts
import { createAgent, GENIE_INSTRUCTIONS } from "@dbx-tools/appkit-mastra";

const support = createAgent({
  instructions: `${baseInstructions}\n\n${GENIE_INSTRUCTIONS}`,
  tools(plugins) {
    return { ...plugins.genie?.toolkit() };
  },
});
```

AppKit's stock `genie()` plugin is honored only for its `spaces` config
(and the matching `app.yaml` resources); the tools talk to Genie
directly via `@dbx-tools/genie` (`genieEventChat`) and the workspace
`statementExecution` API. Each Genie turn forwards its wire
`GenieChatEvent`s through `ctx.writer` for live UI progress. The exact
tool set, ids, and writer-event contract live in `[genie.ts](src/genie.ts)`
and the `GenieWriterEvent` docs in
`[@dbx-tools/appkit-mastra-shared](../appkit-mastra-shared)`.

## Embeds

Charts and data tables ride out-of-band via inline markers so the model
never blocks on or round-trips large payloads:

- `render_data` (a system-default ambient tool) and the Genie
  `prepare_chart` tool both mint a `chartId` synchronously, kick chart
  planning into the background, and return `{ chartId }` immediately. The
  model embeds `[chart:<chartId>]` on its own line where the chart should
  appear.
- `[data:<statement_id>]` markers resolve to inline table data.

The host UI splits the assistant text on these markers and long-polls
the plugin's generic `${basePath}/embed/:type/:id` route until each
entry settles. Cache entries carry a 1h TTL; after expiry the route
404s and the marker falls through harmlessly. Implementation and the
placement contract are in `[chart.ts](src/chart.ts)`; the wire shapes
are in `[@dbx-tools/appkit-mastra-shared](../appkit-mastra-shared)`.

## Feedback (MLflow)

When MLflow tracing is wired for the deployment, the plugin lets users
rate an assistant turn (thumbs up / down) and leave a comment, logged as
a HUMAN [assessment](https://mlflow.org/docs/latest/genai/assessments/)
on that turn's trace and attributed to the signed-in (OBO) user.

Enablement is auto-detected: it turns on when an OTLP exporter endpoint
(`OTEL_EXPORTER_OTLP_ENDPOINT` / `..._TRACES_ENDPOINT`) **and** an MLflow
experiment (`MLFLOW_EXPERIMENT_ID` / `MLFLOW_EXPERIMENT_NAME`) are
configured - the two signals that traces actually materialize in MLflow.
Set `config.feedback` to `true` / `false` to force it on or off
regardless of the env.

```ts
mastra({ agents: support, feedback: true }); // force-enable
```

Under the hood the server derives MLflow's trace id from the active
OpenTelemetry span (`tr-<hex(otelTraceId)>`) and stamps it on each
turn's response (`MLFLOW_TRACE_ID_HEADER`); the client sends it back to
`POST ${basePath}/route/feedback`, which posts the assessment to the
Databricks MLflow REST API. Trace export is asynchronous, so a
just-finished trace may not exist yet - the log call retries briefly on
"not found" and otherwise fails softly (the chat stays usable). The
current state is published to the client as
`clientConfig().feedbackEnabled`; see `[mlflow.ts](src/mlflow.ts)` and
the UI wiring in `[@dbx-tools/appkit-mastra-ui](../appkit-mastra-ui)`.

## Model resolution

Each agent call resolves a model lazily (so concurrent requests keep
distinct user identities), delegating to
`[@dbx-tools/model](../model)` for the actual workspace-aware selection
(fuzzy name matching, score-based class classification, offline
fallbacks). Its exports are re-exported here, so `ModelClass` /
`modelForClass` and friends are available straight off
`@dbx-tools/appkit-mastra`.

The plugin layers on the config sources for _which_ model an agent asks
for, in priority order: a per-request override, the per-agent `model`,
the plugin `defaultModel`, then `DATABRICKS_SERVING_ENDPOINT_NAME`. With
none set, resolution falls through to the dynamic class picker.

```ts
import { createAgent, ModelClass, modelForClass } from "@dbx-tools/appkit-mastra";

const classifier = createAgent({
  instructions: "Classify this email into billing, support, or spam.",
  model: modelForClass(ModelClass.ChatFast),
});
```

Per-request overrides arrive via the `X-Mastra-Model` header, a
`?model=` query, or a `model` / `modelId` body field (see
`[serving.ts](src/serving.ts)`). The cached endpoint catalogue is
exposed at `GET ${basePath}/models` for model pickers; the same data is
available in-process from a sibling plugin via
`appkitUtils.require(this.context, mastra).exports()`.

## MCP server

The plugin's agents are exposed as a Mastra
`[MCPServer](https://mastra.ai/docs/tools-mcp/mcp-overview)` **by
default** so external MCP clients - Claude Desktop, Cursor, the Mastra
playground, or another agent - can call them over the standard MCP
transports. The server is registered on the Mastra instance via
`mcpServers`, so `@mastra/express` serves the stock MCP routes under the
plugin mount; no bespoke route is added. It's on out of the box because
wrapping the already-registered agents is free - only the ambient tools
(which assume an in-process chat turn) stay off unless opted in.

```ts
import { mastra } from "@dbx-tools/appkit-mastra";

// MCP is on by default: every registered agent is an `ask_<agentId>`
// MCP tool with no extra config.
mastra({});

// Turn it off entirely.
mastra({ mcp: false });

// Or tune the server id / metadata and expose extra tools.
mastra({
  mcp: {
    serverId: "analytics",
    name: "Analytics MCP",
    version: "2.1.0",
    tools: true, // also expose ambient tools (off by default)
  },
});
```

With `mcp` enabled the transports mount at clean paths under the plugin
base path (`/api/<plugin>`):

- Streamable HTTP: `POST /api/<plugin>/mcp`
- SSE (legacy): `GET /api/<plugin>/sse` + `POST /api/<plugin>/messages`

(`@mastra/express` mounts these under `/mcp/<serverId>/<transport>`
internally - the plugin rewrites the clean alias to that route, so a
client never sees the doubled `/mcp/<serverId>/mcp` segment.)

`serverId` defaults to the plugin name. Requests run under the same
AppKit OBO scope as the chat routes, so an agent invoked over MCP
resolves its model and tools as the calling user. The resolved endpoint
paths are available in-process via
`appkitUtils.require(this.context, mastra).exports().getMcp()`.

## Client API surface (`apiAccess`)

`@mastra/express` registers its full management route table under the
plugin mount - agent inference _plus_ admin / mutating routes (direct
tool execution, workflow control, raw memory read/write, telemetry,
logs, scores). AppKit authenticates every request as the OBO user, but
does not restrict _which_ of those a browser client may call.

`config.apiAccess` gates that surface at the plugin's dispatch point:

- `"scoped"` (default): only the routes the chat client needs are
  dispatched to Mastra - agent inference (`stream` / `generate` /
  `network`), read-only agent metadata (`GET /agents`,
  `GET /agents/:id`), this plugin's own OBO- and resource-scoped
  `/route/*` routes (history / threads / feedback), and, when `mcp` is
  enabled, the MCP transport. Everything else is refused with `403`
  before it reaches Mastra.
- `"full"`: dispatch the entire stock Mastra API. Use only for a trusted
  first-party console that genuinely needs the management surface.

```ts
mastra({ agents: support }); // scoped by default
mastra({ agents: support, apiAccess: "full" }); // opt into the full API
```

The gate is a pure allowlist (`isMastraRequestAllowed` in
`[server.ts](src/server.ts)`); the browser chat client only ever uses
the agent stream and the `/route/*` routes, so the default breaks
nothing.

## License

Apache-2.0
