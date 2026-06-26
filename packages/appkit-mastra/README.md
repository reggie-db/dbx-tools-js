# @dbx-tools/appkit-mastra

An AppKit plugin that hosts [Mastra](https://mastra.ai) agents inside a
Databricks App with user-scoped workspace auth (OBO), optional
Lakebase-backed memory, and the standard Mastra agent stream the React
client drives via `@mastra/client-js`.

Wiring it up looks the same as the AppKit
[`agents`](https://developers.databricks.com/docs/appkit/v0/plugins/agents)
plugin - same `createAgent` / `tool` helpers, same `tools(plugins)`
callback, same `ToolkitOptions`. Switching a given agent between the two
is a one-line import change.

The implementation lives under `src/`: agent registration in
[`agents.ts`](src/agents.ts), the plugin + routes in
[`plugin.ts`](src/plugin.ts) / [`server.ts`](src/server.ts), Model
Serving resolution in [`model.ts`](src/model.ts) / [`serving.ts`](src/serving.ts),
Genie tooling in [`genie.ts`](src/genie.ts), and the chart pipeline in
[`chart.ts`](src/chart.ts).

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
default - are typed in [`config.ts`](src/config.ts).

On the React side, drop in the prebuilt chat UI from
[`@dbx-tools/appkit-mastra-ui`](../appkit-mastra-ui); it wires itself
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

- **No `lakebase()`** - the agent is fully stateless: no threads, no
  recall.
- **`lakebase()` registered** - both auto-enable. Each agent gets its
  own `PostgresStore` schema (threads stay isolated per agent); every
  agent shares one `PgVector` semantic-recall index.

Override per plugin or per agent by passing `memory` / `storage` as
`false` (opt out), `true` (explicit on), or a config object (dedicated
index / schema). The fields are typed in [`config.ts`](src/config.ts);
the wiring is in [`memory.ts`](src/memory.ts).

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
tool set, ids, and writer-event contract live in [`genie.ts`](src/genie.ts)
and the `GenieWriterEvent` docs in
[`@dbx-tools/appkit-mastra-shared`](../appkit-mastra-shared).

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
placement contract are in [`chart.ts`](src/chart.ts); the wire shapes
are in [`@dbx-tools/appkit-mastra-shared`](../appkit-mastra-shared).

## Model resolution

Each agent call resolves a model lazily (so concurrent requests keep
distinct user identities), delegating to
[`@dbx-tools/model`](../model) for the actual workspace-aware selection
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
[`serving.ts`](src/serving.ts)). The cached endpoint catalogue is
exposed at `GET ${basePath}/models` for model pickers; the same data is
available in-process from a sibling plugin via
`appkitUtils.require(this.context, mastra).exports()`.

## MCP server

Set `mcp` to expose the plugin's agents (and, opt-in, its tools) as a
Mastra [`MCPServer`](https://mastra.ai/docs/tools-mcp/mcp-overview) so
external MCP clients - Claude Desktop, Cursor, the Mastra playground, or
another agent - can call them over the standard MCP transports. The
server is registered on the Mastra instance via `mcpServers`, so
`@mastra/express` serves the stock MCP routes under the plugin mount; no
bespoke route is added.

```ts
import { mastra } from "@dbx-tools/appkit-mastra";

// Expose every registered agent as an `ask_<agentId>` MCP tool.
mastra({ mcp: true });

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

With `mcp` enabled the transports mount under the plugin base path
(`/api/<plugin>`):

- Streamable HTTP: `POST /api/<plugin>/mcp/<serverId>/mcp`
- SSE (legacy): `GET /api/<plugin>/mcp/<serverId>/sse` +
  `POST /api/<plugin>/mcp/<serverId>/messages`

`serverId` defaults to the plugin name. Requests run under the same
AppKit OBO scope as the chat routes, so an agent invoked over MCP
resolves its model and tools as the calling user. The resolved endpoint
paths are available in-process via
`appkitUtils.require(this.context, mastra).exports().getMcp()`.

## License

Apache-2.0
