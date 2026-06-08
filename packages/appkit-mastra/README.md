# @dbx-tools/appkit-mastra

An AppKit plugin that hosts [Mastra](https://mastra.ai) agents inside a
Databricks App with user-scoped workspace auth (OBO), optional
Lakebase-backed memory, and an AI SDK chat route the React client can
consume with `useChat()`.

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

On the React side, never hardcode `/api/mastra/...`. Pull the published
paths from `usePluginClientConfig` and use the `chatUrl` helper. Import
them from the dependency-free `@dbx-tools/appkit-mastra-shared` package
so your browser bundle doesn't pull in `pg`, `fastembed`, or Mastra:

```tsx
import { usePluginClientConfig } from "@databricks/appkit-ui/react";
import { chatUrl, type MastraClientConfig } from "@dbx-tools/appkit-mastra-shared";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useMemo } from "react";

function Chat() {
  const config = usePluginClientConfig<MastraClientConfig>("mastra");
  const transport = useMemo(
    () => new DefaultChatTransport({ api: chatUrl(config) }),
    [config],
  );
  const { messages, sendMessage } = useChat({ transport });
  // ...
}
```

See [Client wiring](#client-wiring) for the full `MastraClientConfig`
shape and per-agent selection.

## Sensible defaults

The plugin is opinionated about what "no config" should mean. Everything
below can be overridden, but the bare path works:


| Scenario                                            | What you get                                                                                                                                                                                                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mastra()`                                          | One built-in `default` analyst agent, model from `/serving-endpoints`; memory + storage auto-on if the `lakebase` plugin is registered                                                                                                                                               |
| `mastra({ agents: def })`                           | Single-agent shorthand - `def` is registered and marked as default                                                                                                                                                                                                                   |
| `mastra({ agents: [def1, def2] })`                  | Array shorthand - keys come from each `def.name` (or `agent_<i>`); first one is default                                                                                                                                                                                              |
| `mastra({ agents: { x: def, y: def }})`             | Record - keys are the registered ids; first key is the default                                                                                                                                                                                                                       |
| No `defaultAgent` set                               | First registered agent wins                                                                                                                                                                                                                                                          |
| No `model` on an agent                              | Falls back to `config.defaultModel`, then `DATABRICKS_SERVING_ENDPOINT_NAME`, then walks `defaultModelFallbacks` (Thinking → Balanced → Fast tiers, Claude ↔ GPT ↔ Gemini interleaved within each, then open-weights) and picks the first endpoint actually present in the workspace |
| No `name` on a definition                           | Uses the registry key as `Agent.name`                                                                                                                                                                                                                                                |
| No `tools` on an agent                              | Inherits plugin-level `config.tools` ambient set (if any)                                                                                                                                                                                                                            |
| No `storage` / `memory` and `lakebase()` registered | Both auto-default to `true`. Pass `false` (or a custom config object) on the plugin or an agent to opt out / override.                                                                                                                                                               |
| `storage` / `memory` on an agent                    | Cascades from plugin: storage namespaces **per-agent** (`schemaName: "mastra_<agentId>"`), vector recall is **shared** across agents on one `PgVector` singleton.                                                                                                                    |


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
| `defaultAgent`          | Id that `chatRoute` binds to when no `:agentId` is supplied. Defaults to first registered.                                                                                                                                                                                                                                                                                                   |
| `defaultModel`          | Fallback for any agent that omits `model`. Same shape (string sugar or `DynamicArgument`).                                                                                                                                                                                                                                                                                                   |
| `defaultModelFallbacks` | Priority-ordered list walked when no `model` / env / override is set. First entry whose endpoint exists in the workspace wins. Default chains the three `ModelTier`s (Thinking → Balanced → Fast); within each tier providers are interleaved Claude ↔ GPT ↔ Gemini with open-weights appended. Compose your own with `modelsForTier(ModelTier.Fast)` or read straight from `MODEL_CATALOG`. |
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
  short `chartId`, kick off a background chart-planner task,
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
  `${MastraClientConfig.chartsPathTemplate}` by id and renders
  inline at the matching `[chart:<chartId>]` marker.
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

`render_data` is a thin wrapper around `runChartPlanner`, a
pure async function that takes a dataset and returns a fully-
resolved Echarts `EChartsOption`. No id-then-promise dance, no
background work: the planner runs inline, and the tool emits a
single chart event with everything attached.

1. Mint a short `chartId` (8 hex chars).
2. `await runChartPlanner({ title, description?, data })`. The
   planner is its own Mastra `Agent` (`modelForTier(ModelTier.Fast)`)
   whose `structuredOutput` schema is a compact "chart plan"
   (chart type + axis labels + categories + series); the helper
   expands the plan into an `EChartsOption` JSON.
3. Push one `{ type: "chart", chartId, title, description?, data,
   option }` event to `ctx.writer`. The chat client's
   `<ChartSlot>` mounts straight to the rendered Echarts
   visualisation - no skeleton frame, because the option arrives
   in the same event as the dataset.
4. If the planner throws, the tool emits a `type: "error"` writer
   event instead. The slot transitions to a "couldn't render
   chart" fallback frame.

Planner latency lands under the tool's trace span (it's
`await`ed directly), and the LLM-bound payload is just
`{ chartId }` so the model's context stays flat regardless of
dataset size. The Genie agent reuses `runChartPlanner` the
same way to embed charts in its structured summary, so the
backbone is shared without coupling the two paths to a
fire-and-forget writer contract.

#### Inline placement contract

The model embeds `[[chart:<chartId>]]` on its own line in its
markdown reply at the position where the chart should appear:

```markdown
## Audit Score

Audit Score is stable at ~94%, hovering between 93.5 and 95.0.

[[chart:a3f9c1d2]]

## Service Time

Service time is the outlier at 162.5s, up from a target of 150s.

[[chart:b7e2d4f1]]
```

The chat client splits the assistant text on these markers and
drops a `<ChartSlot>` in at each spot. A marker that arrives
before its `chart` event (rare; only during fast streaming) shows
a "Queueing chart" skeleton; a chart whose marker the model
forgot to place falls through to the end of the reply as a
fallback. All three states (queueing, rendering, rendered) share
the same fixed-height frame so the layout doesn't jump as
charts resolve.

#### Trade-offs

- Both events ride the writer, not the persisted tool-result, so
  charts don't re-render after a hard reload. The model can call
  `render_data` again (or re-ask Genie) on the next turn if the
  user wants the chart back.
- The chart-planner is a separate model call per dataset (fast
  tier, but still ~1-3s each). For an N-chart turn, latency is
  `Genie + max(planners)` since the planners run concurrently
  with the rest of Genie's stream and with each other.

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

### No explicit ask (tier-aware fallback list)

When nothing is set, the resolver walks an opinionated
priority-ordered list and returns **the first id that is actually
present in the workspace's endpoint listing**. This is how a workspace
without Claude Opus still gets a sensible default automatically -
the resolver skips ahead to whichever Sonnet / GPT-5 / Gemini / Llama
variant is wired up.

The catalogue is grouped two ways:

- By **capability tier** via the `ModelTier` enum:
`ModelTier.Thinking` (deepest reasoning), `ModelTier.Balanced`
(cost/latency sweet spot), `ModelTier.Fast` (cheap & quick for
classification / routing / simple summarisation).
- By **provider** within each tier: `claude`, `gpt`, `gemini`,
`openSource`.

Both views live on `MODEL_CATALOG[tier][provider]`. The walked
`FALLBACK_MODEL_IDS` chains the three tiers in descending power
(Thinking → Balanced → Fast); within each tier providers are
round-robin-zipped (Claude ↔ GPT ↔ Gemini) before the open-weights
tail is appended as the universal floor.


| Tier (most powerful first) | Claude                           | GPT                                   | Gemini                          | Open weights                                   |
| -------------------------- | -------------------------------- | ------------------------------------- | ------------------------------- | ---------------------------------------------- |
| `ModelTier.Thinking`       | Opus 4.8 → 4.7 → 4.6 → 4.5 → 4.1 | 5.5 Pro                               | 3.1 Pro → 3 Pro → 2.5 Pro       | Llama 4 Maverick, GPT-OSS 120B, Llama 3.1 405B |
| `ModelTier.Balanced`       | Sonnet 4.6 → 4.5 → 4             | 5.5 → 5.4 → 5.2 → 5.1 → 5             | 3.5 Flash → 3 Flash → 2.5 Flash | Llama 3.3 70B, Qwen3-Next 80B, Qwen35 122B     |
| `ModelTier.Fast`           | Haiku 4.5                        | 5.4 mini → 5.4 nano → 5 mini → 5 nano | 3.1 Flash Lite                  | GPT-OSS 20B, Gemma 3 12B, Llama 3.1 8B         |


#### Pick a tier-appropriate model for one agent

Use `modelForTier(tier)` to grab the top of a tier as a string; the
agent-step resolver fuzzy-matches it against the live catalogue at
call time so it still works when the literal top pick isn't deployed.

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

`modelsForTier(tier)` returns the priority-ordered list for one tier;
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

const m = appkitUtils.require(this.context, mastra).exports();
const endpoints = await m.asUser(req).listModels(); // user-scoped
m.clearModelsCache(); // force the next call to re-fetch
```

### Per-request model override

Any in-flight request can pick a different backing endpoint without
redeploying. Sources, checked in priority order:


| Source                    | Example                                          |
| ------------------------- | ------------------------------------------------ |
| `X-Mastra-Model` header   | `curl -H 'X-Mastra-Model: claude-haiku' ...`     |
| `?model=` query parameter | `POST /api/mastra/route/chat?model=llama-70b`    |
| Body `model` or `modelId` | `{ "messages": [...], "model": "claude-haiku" }` |


The override flows through the same fuzzy matcher as static ids, so
`X-Mastra-Model: claude sonnet` still snaps to
`databricks-claude-sonnet-4-6`. Set `modelOverride: false` on the
plugin config to disable the override path entirely (e.g. for a
multi-tenant deployment where untrusted clients shouldn't pick the
endpoint).

## Memory + storage

Memory and storage are split into two independent knobs and both auto-on
the moment the `lakebase` plugin is registered. Bare `mastra()` next to
`lakebase()` already gets you per-agent threads + shared semantic recall;
zero extra config required.


| Knob      | Default when `lakebase()` is registered                                                                           | What it backs                                                                                  |
| --------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `storage` | **Per-agent** `PostgresStore` namespaced by `schemaName: "mastra_<agentId>"` so threads + messages stay isolated, plus a Mastra-instance-level `PostgresStore` in schema `mastra_instance`. | Mastra threads, messages, working memory; Mastra-instance-level workflow snapshots (`requireApproval` / `agent.resumeStream()`). |
| `memory`  | **Shared singleton** `PgVector` across every agent (cross-agent semantic recall on one index).                    | RAG-style recall over past messages via FastEmbed vectors.                                     |


Override either at the plugin level, the agent level, or both. The agent
value wins when set; otherwise the plugin value cascades.

```ts
mastra({
  // Plugin defaults. Either field becomes the cascading baseline.
  // Omit entirely to inherit "auto-on when lakebase is present".
  storage: true,      // (default behavior when lakebase is registered)
  memory: true,       // (default behavior when lakebase is registered)

  agents: {
    analyst: createAgent({
      instructions: "...",
      // No overrides: inherits the auto-on defaults above.
      //   - threads stored under schema "mastra_analyst"
      //   - recalls from the shared vector index
    }),

    router: createAgent({
      instructions: "Stateless routing agent.",
      // Opt out of both for a fully stateless agent.
      storage: false,
      memory: false,
    }),

    legal: createAgent({
      instructions: "Compliance-bounded assistant.",
      // Private vector index so legal's recall doesn't bleed into
      // analyst's. Threads still get their own per-agent schema.
      memory: { connectionString: process.env.LEGAL_PG_URL!, /* ... */ },
    }),

    archive: createAgent({
      instructions: "Read-only archive viewer.",
      // Pin to a specific schema (e.g. shared with another service).
      storage: {
        schemaName: "shared_history",
        pool: archivePool,
      },
    }),
  },
});
```

Notes:

- `PostgresStore` runs `CREATE SCHEMA IF NOT EXISTS` on `init()`, so
per-agent schemas (and the shared `mastra_instance` schema) spring
into existence the first time the agent saves anything. No bundle /
migration step required.
- The `mastra_instance` schema exists so that Mastra-instance-level
artifacts (workflow snapshots used by `agent.resumeStream()`,
`requireApproval` flows, etc.) live in their own namespace and never
collide with per-agent thread / message tables. Disable the instance
store by setting `storage: false` at plugin level - approval-gated
tool calls will then error on resume.
- Disabling `lakebase()` from your plugin list while leaving `storage` /
`memory` truthy fails fast at setup with a clear "lakebase plugin not
registered" error.
- The `lakebase` plugin is declared as a **required** resource only when
`storage` / `memory` is explicitly truthy at registration time. Auto-on
defaults activate inside `setup:complete`, after lakebase is already
proven to be present.

## Runtime exports

Other plugins / route handlers can introspect the registry via the
`exports()` surface, modeled on AppKit's:

```ts
import { appkitUtils } from "@dbx-tools/shared";
import { mastra } from "@dbx-tools/appkit-mastra";

const m = appkitUtils.require(this.context, mastra).exports();
m.list(); // ["analyst", "helper"]
m.get("analyst"); // Agent | null
m.getDefault(); // Agent | null
m.getMastra(); // underlying Mastra instance (advanced)
m.listModels(); // Promise<ServingEndpointSummary[]> - cached + OBO when wrapped with asUser(req)
m.clearModelsCache(); // force the next listModels() to re-fetch
```

## Client wiring

`clientConfig()` publishes the mount paths, default agent id, and the
full registry to `usePluginClientConfig("mastra")` so the React client
never has to hardcode `/api/mastra` or rely on `DEFAULT_AGENT_ID`
constants. A tiny URL helper (`chatUrl`) and the `MastraClientConfig`
type ship from the standalone `@dbx-tools/appkit-mastra-shared`
package; that package is pure (no `pg` / `fastembed` / Mastra
dependencies) so it imports cleanly into Vite / Webpack / esbuild
builds.

```tsx
import { usePluginClientConfig } from "@databricks/appkit-ui/react";
import { chatUrl, type MastraClientConfig } from "@dbx-tools/appkit-mastra-shared";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useMemo, useState } from "react";

function Chat() {
  const config = usePluginClientConfig<MastraClientConfig>("mastra");
  const [selected, setSelected] = useState<string>();
  const api = chatUrl(config, selected); // defaults to config.defaultAgent

  const transport = useMemo(() => new DefaultChatTransport({ api }), [api]);
  const { messages, sendMessage } = useChat({ transport });

  return (
    <>
      <select onChange={(e) => setSelected(e.target.value)}>
        {config.agents.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
      {/* render messages, etc. */}
    </>
  );
}
```

`MastraClientConfig` fields (all derived from the server-side plugin
mount, so a custom `mastra({ name: "myMastra" })` rewrites every path):


| Field                 | Example                                | Description                                                          |
| --------------------- | -------------------------------------- | -------------------------------------------------------------------- |
| `basePath`            | `"/api/mastra"`                        | Plugin mount path.                                                   |
| `chatPath`            | `"/api/mastra/route/chat"`             | Default-agent chat URL. Use `chatUrl(config)` to get it.             |
| `chatPathTemplate`    | `"/api/mastra/route/chat/:agentId"`    | OpenAPI-style template for tools / docs.                             |
| `modelsPath`          | `"/api/mastra/models"`                 | `GET` cached endpoint catalogue.                                     |
| `historyPath`         | `"/api/mastra/route/history"`          | Default-agent thread history. Use `historyUrl(config, opts)`.        |
| `historyPathTemplate` | `"/api/mastra/route/history/:agentId"` | OpenAPI-style template for tools / docs.                             |
| `defaultAgent`        | `"analyst"`                            | Agent id `chatRoute` binds to when none is supplied.                 |
| `agents`              | `["analyst", "helper"]`                | Every registered agent id in order.                                  |


`chatUrl(config, agentId?)` returns `config.chatPath` for the default
agent (the registered `chatRoute` mount that omits `:agentId`), and
`${config.chatPath}/${encodeURIComponent(agentId)}` otherwise. The
sibling `historyUrl(config, { agentId?, page?, perPage? })` mirrors
that pattern for the `/history` endpoint and appends pagination
query parameters when provided. Both are pure functions: no React,
no hooks, safe in service workers and SSR.

## License

Apache-2.0