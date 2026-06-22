# @dbx-tools/appkit-mastra

An AppKit plugin that hosts [Mastra](https://mastra.ai) agents inside a
Databricks App with user-scoped workspace auth (OBO), optional
Lakebase-backed memory, and the standard Mastra agent stream the React
client drives via `@mastra/client-js` (`getAgent(id).stream()`).

The plugin is designed so that wiring it up looks the same as the
AppKit
`[agents](https://developers.databricks.com/docs/appkit/v0/plugins/agents)`
plugin - same `createAgent` / `tool` helpers, same `tools(plugins)`
callback shape, same `ToolkitOptions`. Switching between the two for a
given agent is a one-line import change.

## Quick start

The pattern below is the direct counterpart of AppKit's `agents` plugin
example - swap `agents` for `mastra` and the imports stay structurally
identical:

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
    // storage (`schemaName: "mastra_<agentId>"`) plus a shared
    // semantic-recall vector index. Skip it for a stateless agent.
    lakebase(),
    mastra({ agents: support }),
  ],
});
```

`createAgent` is a no-op identity helper that anchors type inference.
`tool` is the AppKit-shaped factory (`{ description, schema, execute }`)
that auto-adapts to Mastra's `createTool` under the hood.

Memory + storage cascades:

- **No `lakebase()` registered** ▸ agent is fully stateless. No threads,
no recall. Same as `mastra()` alone.
- `**lakebase()` registered, no `storage` / `memory` config** ▸ both
auto-turn on. Each agent gets its own `PostgresStore` schema; every
agent shares one `PgVector` recall index.
- **Per-agent opt-out** ▸ `createAgent({ ..., memory: false, storage: false })`
for routing / one-shot agents that don't need history.
- **Per-agent override** ▸ pass a `PgVectorConfig` / `PostgresStoreConfig` object on the agent for a private index or a shared external schema.

See [Memory + storage](#memory--storage) for the full cascade and worked
examples.

On the React side, drop in the prebuilt chat UI from
[`@dbx-tools/appkit-mastra-ui`](../appkit-mastra-ui) - it wires itself
from the plugin's published client config and streams over
`@mastra/client-js`, so there's no transport code to write:

```tsx
import { MastraChat } from "@dbx-tools/appkit-mastra-ui/react";

export default function ChatPage() {
  return <MastraChat showModelPicker />;
}
```

Under the hood that's `useMastraClient()` -> a `MastraPluginClient`
(a `@mastra/client-js` `MastraClient` subclass) that streams turns and
adds the plugin's custom routes (history, models, suggestions, embeds).
Never hardcode `/api/mastra/...`; the client derives every URL from the
`basePath` published in `clientConfig()`.

See [Client wiring](#client-wiring) for the full `MastraClientConfig`
shape and per-agent selection.

## Sensible defaults

The plugin is opinionated about what "no config" should mean. Everything
below can be overridden, but the bare path works:


| Scenario                                            | What you get                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mastra()`                                          | One built-in `default` analyst agent, model from `/serving-endpoints`; memory + storage auto-on if the `lakebase` plugin is registered                                                                                                                                                                                               |
| `mastra({ agents: def })`                           | Single-agent shorthand - `def` is registered and marked as default                                                                                                                                                                                                                                                                   |
| `mastra({ agents: [def1, def2] })`                  | Array shorthand - keys come from each `def.name` (or `agent_<i>`); first one is default                                                                                                                                                                                                                                              |
| `mastra({ agents: { x: def, y: def }})`             | Record - keys are the registered ids; first key is the default                                                                                                                                                                                                                                                                       |
| No `defaultAgent` set                               | First registered agent wins                                                                                                                                                                                                                                                                                                          |
| No `model` on an agent                              | Falls back to `config.defaultModel`, then `DATABRICKS_SERVING_ENDPOINT_NAME`, then walks `defaultModelFallbacks` (Thinking → Balanced → Fast tiers, Claude ↔ GPT ↔ Gemini interleaved within each, then open-weights) and picks the first endpoint actually present in the workspace |
| No `name` on a definition                           | Uses the registry key as `Agent.name`                                                                                                                                                                                                                                                                                                |
| No `tools` on an agent                              | Inherits plugin-level `config.tools` ambient set (if any)                                                                                                                                                                                                                                                                            |
| No `storage` / `memory` and `lakebase()` registered | Both auto-default to `true`. Pass `false` (or a custom config object) on the plugin or an agent to opt out / override.                                                                                                                                                                                                               |
| `storage` / `memory` on an agent                    | Cascades from plugin: storage namespaces **per-agent** (`schemaName: "mastra_<agentId>"`), vector recall is **shared** across agents on one `PgVector` singleton.                                                                                                                                                                    |


Every field on `MastraAgentDefinition`:


| Field          | Description                                                                                                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`         | Display name. Defaults to the registry key.                                                                                                                                         |
| `description`  | Long-form description, surfaced as `Agent.description`.                                                                                                                             |
| `instructions` | System prompt body. Required.                                                                                                                                                       |
| `model`        | Per-agent model override. String = `modelId` sugar; otherwise a Mastra `DynamicArgument`.                                                                                           |
| `tools`        | Plain record OR `(plugins) => tools` callback (see below).                                                                                                                          |
| `memory`       | `false`, `true`, or a `PgVectorConfig`. Cascades from `config.memory`. **Default: shared singleton `PgVector` across every agent** - object override switches to a dedicated index. |
| `storage`      | `false`, `true`, or a `PostgresStoreConfig`. Cascades from `config.storage`. **Default: per-agent namespace** via `schemaName: "mastra_<agentId>"` so threads stay isolated.        |


Plugin-level fields:


| Field                   | Description                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents`                | The registry. Omit for a built-in `default` analyst.                                                                                                                                                                                                                                                                                                                                         |
| `defaultAgent`          | Id the client talks to when no `:agentId` is supplied. Defaults to first registered.                                                                                                                                                                                                                                                                                                         |
| `defaultModel`          | Fallback for any agent that omits `model`. Same shape (string sugar or `DynamicArgument`).                                                                                                                                                                                                                                                                                                   |
| `defaultModelFallbacks` | Priority-ordered list tried first when no `model` / env / override is set, ahead of the dynamic score-classified catalogue. First entry whose endpoint exists in the workspace wins. When unset, resolution is driven by the live Foundation Model API scores (see [Model resolution](#model-resolution)); set this to pin a regulated workspace to an approved subset. Compose one with `modelsForTier(ModelTier.Fast)`. |
| `tools`                 | Ambient tools merged into every agent (per-agent tools win on collisions).                                                                                                                                                                                                                                                                                                                   |
| `storage`               | `undefined` (default) auto-enables when `lakebase()` is registered; `true` does the same explicitly; `false` opts out; an object opens a dedicated `PostgresStore`. Per-agent default is `schemaName: "mastra_<agentId>"`.                                                                                                                                                                   |
| `memory`                | `undefined` (default) auto-enables when `lakebase()` is registered; `true` does the same explicitly; `false` opts out; an object opens a dedicated `PgVector`. Default behavior: one shared `PgVector` singleton across every agent.                                                                                                                                                         |
| `modelFuzzyMatch`       | `false` to disable fuzzy snapping of model ids against the workspace's Model Serving catalogue. Defaults to `true`.                                                                                                                                                                                                                                                                          |
| `modelFuzzyThreshold`   | Fuse.js score threshold (`0` exact, `1` anything). Defaults to `0.4`.                                                                                                                                                                                                                                                                                                                        |
| `modelCacheTtlMs`       | TTL for the cached endpoint list, per workspace host. Defaults to 5 minutes. Concurrent callers share one in-flight fetch.                                                                                                                                                                                                                                                                   |
| `modelOverride`         | `false` to disable per-request `X-Mastra-Model` / `?model=` / body overrides. Defaults to `true`.                                                                                                                                                                                                                                                                                            |
| `styleInstructions`     | Style guardrails appended to every agent's `instructions` to curb LLM-isms (em dashes, emojis, sycophantic openers, throwaway closers). `undefined` (default) uses the built-in `DEFAULT_STYLE_INSTRUCTIONS`; a string replaces it; `false` disables.                                                                                                                                        |


## The `tools(plugins)` callback

Each registered agent can supply either a static `tools: { ... }` record
or a `tools(plugins)` callback. The returned record accepts **any**
tool shape Mastra understands:

- Mastra tools built with `createTool` or `new Tool(...)`
- AppKit-shaped tools built with the `tool()` wrapper (below)
- Vercel AI SDK tools (`tool({...})` from `ai`)
- Provider-defined tools (e.g. `openai.tools.webSearch(...)`)
- Toolkits returned from `plugins.<name>.toolkit(...)`

```ts
tools(plugins) {
  return {
    // Sibling plugin toolkits.
    ...plugins.analytics.toolkit(),                          // every analytics tool
    ...plugins.files.toolkit({ only: ["uploads.read"] }),    // filtered subset

    // AppKit-shaped inline tool.
    get_weather: tool({
      description: "Weather",
      schema: z.object({ city: z.string() }),
      execute: async ({ city }) => `Sunny in ${city}`,
    }),

    // Existing Mastra tool dropped in unchanged.
    save_doc: existingMastraTool,
  };
}
```

`plugins` is a typed `Record<string, { toolkit(opts?): tools }>` matching
AppKit's `Plugins` type. It's backed by a runtime Proxy that
**auto-discovers any registered AppKit `ToolProvider` plugin** -
`analytics`, `files`, `lakebase`, `genie`, plus any third-party plugin
that implements the standard `getAgentTools()` + `executeAgentTool()` +
`toolkit()` interface. Tool calls dispatch through the plugin's
`executeAgentTool`, so OBO auth (`asUser`) and telemetry spans stay
intact.

`plugins.genie` is special-cased: it returns a flat set of
Mastra tools the central agent drives directly (no inner
orchestrator agent). Two shared, space-agnostic tools register
once regardless of how many spaces are wired:

- `get_statement(statement_id, limit?)` - fetch rows for a
  Genie statement. Use only when the agent needs to read values
  to reason about them; otherwise embed `[data:<statement_id>]`.
- `prepare_chart({statement_id, title?, description?})` - mint a
  `chartId` (v4 UUID), kick off a background chart-planner task,
  cache the resolved Echarts spec under the id for one hour.
  Returns `{chartId}` synchronously so the agent can embed
  `[chart:<chartId>]` in prose without blocking.

Three per-space tools register per wired alias (`ask_genie`,
`get_space_description`, `get_space_serialized` for the
`default` alias; `ask_genie_<alias>`, etc. for additional
aliases):

- `ask_genie({question})` - drives one `genieEventChat` turn
  and streams wire events (status / thinking / sql) through
  `ctx.writer`. Returns `{message: GenieMessage}`; rows are
  NOT fetched eagerly.
- `get_space_description()` - cheap title / description /
  warehouse id lookup.
- `get_space_serialized()` - full `GenieSpace` JSON for
  column-level grounding when the description isn't enough.

AppKit's `genie()` plugin is honored only for its `spaces`
config (and the matching `app.yaml`-declared resources). The
tools talk to Genie directly via `@dbx-tools/genie`
(`genieEventChat`) and the workspace
`statementExecution.getStatement` API.

The orchestration prompt (decompose, ask Genie focused
sub-questions, place markers in prose) ships as the exported
`GENIE_INSTRUCTIONS` string - compose it into your agent's
`instructions` to get the canonical behavior:

```ts
import { createAgent, GENIE_INSTRUCTIONS } from "@dbx-tools/appkit-mastra";

const support = createAgent({
  instructions: `${baseInstructions}\n\n${GENIE_INSTRUCTIONS}`,
  tools(plugins) {
    return { ...plugins.genie?.toolkit() };
  },
});
```

`GENIE_INSTRUCTIONS` references the default (`default` alias)
tool names. Multi-space deployments should write a custom
variant that names the suffixed per-space tools
(e.g. `ask_genie_sales`).

Genie writer event flow:

- Each `ask_genie` call emits a Mastra-only `started` event
  before any network round-trip, then forwards every wire
  `GenieChatEvent` (status / thinking / sql / rows / suggested
  / message / result / error) through `ctx.writer`.
- Charts ride out-of-band: `prepare_chart` mints a `chartId`
  synchronously, the planner runs in the background and writes
  the spec to the chart cache (1h TTL). The host UI long-polls
  `${basePath}/embed/chart/:id` (via `MastraPluginClient.chart(id)`)
  by id and renders inline at the matching `[chart:<chartId>]`
  marker.
- After a hard reload, the live `started` / `status` / `sql`
  events are gone (they only ride the writer, not persisted
  tool results); the central agent's text reply (with embedded
  `[data:<statement_id>]` / `[chart:<chartId>]` markers) is
  preserved in the message history and the host UI re-resolves
  the markers on its own.

### `render_data` (system-default ambient tool)

`buildAgents` registers a system-level `render_data` tool on
every agent so the model can submit any tabular dataset for
inline charting. Users can shadow it by including a same-named
tool in `config.tools` or in a per-agent `tools` map; otherwise
it's just there.

The tool is generic - not coupled to Genie or any particular
upstream. Input is `{ title, description?, data: Row[] }` where
`data` is an array of objects keyed by column name (a SQL row
set, an API response, a hand-built array, etc.).

#### How it works

`render_data` is a thin wrapper around `prepareChart`, the same
orchestrator the Genie `prepare_chart` tool uses. It mints a
`chartId` synchronously, caches an empty placeholder, and kicks
off the chart-planner in the background. The tool returns just
`{ chartId }` so the model can embed `[chart:<chartId>]` in
prose immediately without blocking on chart generation.

1. Mint a `chartId` (v4 UUID via `crypto.randomUUID()`).
2. Cache an empty `{ chartId }` placeholder so the first
   `fetchChart` call always sees an entry (no spurious 404 race).
3. Fire-and-forget: resolve the dataset (trivial for
   `render_data` since the rows are already in hand) and run
   `runChartPlanner` in the background. On success the cache
   entry settles with `{ chartId, result }` (containing the
   `chartType` and full `EChartsOption`). On failure it settles
   with `{ chartId, error }`.
4. Return `{ chartId }` to the LLM immediately.

The host UI resolves `[chart:<chartId>]` markers by hitting
the plugin's generic `GET /embed/chart/:id` route, which long-polls
until the entry settles or the server-side timeout elapses.

#### Inline placement contract

The model embeds `[chart:<chartId>]` on its own line in its
markdown reply at the position where the chart should appear
(the `<chartId>` is the v4 UUID the tool returned):

```markdown
## Audit Score

Audit Score is stable at ~94%, hovering between 93.5 and 95.0.

[chart:a3f9c1d2-7b4e-4c1a-9f2d-1e6b8c0a5d31]

## Service Time

Service time is the outlier at 162.5s, up from a target of 150s.

[chart:b7e2d4f1-3a9c-4e58-8d10-2f7a4b6c9e02]
```

The chat client splits the assistant text on these markers and
drops a `<ChartSlot>` in at each spot. A marker that arrives
before its chart settles in the cache shows a "Queueing chart"
skeleton; a chart whose marker the model forgot to place falls
through to the end of the reply as a fallback. All three states
(queueing, rendering, rendered) share the same fixed-height
frame so the layout doesn't jump as charts resolve.

#### Trade-offs

- Chart entries live in the cache with a 1h TTL. After expiry
  the `/embed/chart/:id` route returns 404. The model can call
  `render_data` again on the next turn if the user wants the
  chart back.
- The chart-planner is a separate model call per dataset (fast
  tier, but still ~1-3s each). For an N-chart turn, latency is
  `max(planners)` since the planners run concurrently in the
  background and the tool returns immediately.

Plugins that aren't registered (or don't implement the toolkit
interface) resolve to `undefined` at runtime, so guard with `?.` /
`?? {}` when a backing plugin is optional in some environments:

```ts
tools(plugins) {
  return {
    ...(plugins.analytics?.toolkit() ?? {}),
    ...(plugins.genie?.toolkit({ prefix: "g_" }) ?? {}),
  };
}
```

`plugins.<name>.toolkit(opts)` accepts the same `ToolkitOptions` shape
AppKit's own toolkits expose (passed through verbatim):

- `prefix?: string` - prepended to every key (AppKit default: `${pluginName}.`)
- `only?: string[]` / `except?: string[]` - allow/deny list against the
local tool name
- `rename?: Record<string, string>` - remap individual keys

### `tool()` vs `createTool()`

The `tool()` factory mirrors `@databricks/appkit/beta`'s shape so
sharing tool code between the AppKit `agents` plugin and this one is a
single-line import change:

```ts
import { tool, createTool } from "@dbx-tools/appkit-mastra";

// AppKit-shaped (description / schema / flat-arg execute).
const weather = tool({
  description: "Weather",
  schema: z.object({ city: z.string() }),
  execute: async ({ city }) => `Sunny in ${city}`,
});

// Full Mastra `createTool` (id required, inputSchema, advanced fields).
const saveDoc = createTool({
  id: "save-doc",
  description: "Persist a document",
  inputSchema: z.object({ key: z.string(), value: z.any() }),
  outputSchema: z.object({ saved: z.boolean() }),
  requireApproval: true,
  execute: async (input, ctx) => {
    await ctx.mastra?.getStorage()?.set(input.key, input.value);
    return { saved: true };
  },
});
```

When `tool()`'s `id` is omitted it's auto-derived from a slugified
description plus a 6-char FNV-1a base-32 suffix - stable across runs
so traces stay readable. Pass an explicit `id` when you want to pin
one.

Reach for `createTool` when you need Mastra-only fields (`outputSchema`,
`suspendSchema`, `requireApproval`, `mcp`, etc.).

## Model resolution

Each agent call resolves a `MastraModelConfig` lazily so concurrent
requests get distinct user identities. There are two paths through
the resolver depending on whether the caller asked for a specific
model.

### Explicit ask (override / agent / plugin / env)

When any of these is set the resolver fuzzy-matches that single id
against the live `/serving-endpoints` list, in priority order:

1. Per-request override (`X-Mastra-Model` header, `?model=` query,
  or `model` / `modelId` body field; see below)
2. Per-agent `def.model` (string sugar or `DynamicArgument`)
3. Plugin-level `config.defaultModel`
4. `DATABRICKS_SERVING_ENDPOINT_NAME` env var

The matcher is `fuse.js` extended search with tokens split on
non-word characters and AND-joined. Exact matches win immediately;
loose tokens like `"claude sonnet"` snap to
`databricks-claude-sonnet-4-6`, `"llama 70b"` to
`databricks-meta-llama-3-3-70b-instruct`, `"DBRX"` to
`databricks-dbrx-instruct`, and so on. If no candidate scores below
`modelFuzzyThreshold` (default `0.4`) the input is returned verbatim
and Databricks surfaces the canonical 404.

### No explicit ask (dynamic, score-based tiers)

When nothing is set, the resolver classifies the **live** workspace
catalogue and returns **the first id that is actually present in the
endpoint listing**. This is how a workspace without Claude Opus still
gets a sensible default automatically - the resolver skips ahead to
whichever model is the best fit and actually wired up.

Tiers are derived, not hard-coded. Databricks publishes a
`quality` / `speed` / `cost` profile per Foundation Model API endpoint
(the bars in the AI Playground), surfaced on `ServingEndpointSummary.profile`.
`classifyEndpoints(endpoints)` buckets the scored chat models by the
**relative distribution** of `quality`: the observed scores are split
at their 1/3 and 2/3 quantiles, so the top third is
`ModelTier.Thinking`, the bottom third `ModelTier.Fast`, and the
middle `ModelTier.Balanced`. Because the thresholds come from the data,
the split adapts as Databricks adds or rescores models - nothing is
pinned to a fixed score band, and a brand-new model that lands outside
today's range still slots in next to its peers.

Two escape hatches cover missing scores:

- **Unscored but recognizable** endpoints (a model Databricks hasn't
  scored yet, e.g. a fresh release) are placed by a small **family
  heuristic** keyed on provider + variant words (`opus`/`sonnet`/`haiku`,
  `pro`/`mini`/`nano`, `flash`/`flash-lite`, Llama parameter sizes).
  Unrecognized, unscored endpoints are never auto-selected.
- **Catalogue unreachable**: the resolver falls back to the small,
  family-classified `FALLBACK_MODEL_IDS` floor (Thinking → Balanced →
  Fast).

The default chain is therefore: any `defaultModelFallbacks` you set,
then the live score-classified catalogue in descending tier order,
then the `FALLBACK_MODEL_IDS` floor.

#### Pick a tier-appropriate model for one agent

`modelForTier(tier)` / `modelsForTier(tier)` return the **static
fallback opinion** for a tier (the small built-in list, no workspace
call). They're handy for seeding a default; the agent-step resolver
still fuzzy-matches the result against the live catalogue at call time
so it works even when the literal pick isn't deployed.

```ts
import { createAgent, ModelTier, modelForTier } from "@dbx-tools/appkit-mastra";

const classifier = createAgent({
  instructions: "Classify this email into one of: billing, support, spam.",
  model: modelForTier(ModelTier.Fast),
});

const planner = createAgent({
  instructions: "Plan a multi-step data migration.",
  model: modelForTier(ModelTier.Thinking),
});
```

#### Bias the plugin-level fallback toward a tier

`modelsForTier(tier)` returns the static fallback list for one tier;
pass it to `defaultModelFallbacks` to scope the auto-resolver:

```ts
import { mastra, ModelTier, modelsForTier } from "@dbx-tools/appkit-mastra";

mastra({
  // All agents that omit `model` will land on a Fast-tier endpoint.
  defaultModelFallbacks: modelsForTier(ModelTier.Fast),
});
```

#### Pin a custom approved subset

Mix in your own endpoint names (internal fine-tunes, regulated
allowlists, etc) in front of the catalogue:

```ts
mastra({
  defaultModelFallbacks: [
    "my-org-finetune-v2", // try internal endpoint first
    "databricks-claude-sonnet-4-6", // approved fallback
  ],
});
```

If the workspace has none of the listed ids, the top fallback is
returned and Databricks surfaces the canonical error.

The endpoint list is cached per workspace host through AppKit's
built-in `CacheManager` (`CacheManager.getInstanceSync().getOrExecute`),
which is the TypeScript counterpart of Python's `cachetools.TTLCache`
plus `cachetools-async` rolled into one: per-entry TTL (default 5
minutes via `modelCacheTtlMs`), bounded size, in-flight request
coalescing (the manager's internal `inFlightRequests` map shares one
fetch across every concurrent caller), telemetry spans, and optional
Lakebase persistence when the `lakebase` plugin is wired up. No extra
dependency lives in this package; the catalogue piggybacks on whatever
storage backend AppKit picked at boot.

String values (`"databricks-claude-sonnet-4-6"`) are `modelId` sugar
layered on top of the auto-resolver - workspace URL, provider, and OBO
auth stay default. Pass a `DynamicArgument<MastraModelConfig>` on
`def.model` / `config.defaultModel` when you need full control over
auth, provider, or URL; that path bypasses the fuzzy matcher and
per-request override.

### `GET /api/mastra/models`

The plugin exposes the cached endpoint catalogue at `/models` (mounted
under the plugin prefix, default `/api/mastra`) so clients can populate
model pickers and validate `?model=` choices without a separate
Databricks SDK round-trip:

```bash
curl -s http://localhost:8000/api/mastra/models | jq
# {
#   "endpoints": [
#     { "name": "databricks-claude-sonnet-4-6", "task": "llm/v1/chat", "state": "READY", ... },
#     { "name": "databricks-meta-llama-3-3-70b-instruct", ... },
#     ...
#   ]
# }
```

Same payload from a sibling plugin or script (no HTTP round-trip):

```ts
import { appkitUtils } from "@dbx-tools/shared";
import { mastra } from "@dbx-tools/appkit-mastra";

const m = appkitUtils.require(this.context, ma
