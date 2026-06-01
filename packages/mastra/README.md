# @dbx-tools/appkit-mastra

An AppKit plugin that hosts [Mastra](https://mastra.ai) agents inside a
Databricks App with user-scoped workspace auth (OBO), optional
Lakebase-backed memory, and an AI SDK chat route the React client can
consume with `useChat()`.

The plugin is designed so that wiring it up looks the same as the
AppKit
[`agents`](https://developers.databricks.com/docs/appkit/v0/plugins/agents)
plugin - same `createAgent` / `tool` helpers, same `tools(plugins)`
callback shape, same `ToolkitOptions`. Switching between the two for a
given agent is a one-line import change.

## Quick start

The pattern below is the direct counterpart of AppKit's `agents` plugin
example - swap `agents` for `mastra` and the imports stay structurally
identical:

```ts
import { analytics, createApp, files, server } from "@databricks/appkit";
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
  plugins: [server(), analytics(), files(), mastra({ agents: support })],
});
```

`createAgent` is a no-op identity helper that anchors type inference.
`tool` is the AppKit-shaped factory (`{ description, schema, execute }`)
that auto-adapts to Mastra's `createTool` under the hood.

## Sensible defaults

The plugin is opinionated about what "no config" should mean. Everything
below can be overridden, but the bare path works:

| Scenario                                | What you get                                                                                                                                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mastra()`                              | One built-in `default` analyst agent, no memory, model from `/serving-endpoints`                                                                                                                                |
| `mastra({ agents: def })`               | Single-agent shorthand - `def` is registered and marked as default                                                                                                                                              |
| `mastra({ agents: [def1, def2] })`      | Array shorthand - keys come from each `def.name` (or `agent_<i>`); first one is default                                                                                                                         |
| `mastra({ agents: { x: def, y: def }})` | Record - keys are the registered ids; first key is the default                                                                                                                                                  |
| No `defaultAgent` set                   | First registered agent wins                                                                                                                                                                                     |
| No `model` on an agent                  | Falls back to `config.defaultModel`, then `DATABRICKS_SERVING_ENDPOINT_NAME`, then walks `defaultModelFallbacks` (Claude ↔ GPT-5 interleaved, then open-weights) and picks the first endpoint actually present in the workspace |
| No `name` on a definition               | Uses the registry key as `Agent.name`                                                                                                                                                                           |
| No `tools` on an agent                  | Inherits plugin-level `config.tools` ambient set (if any)                                                                                                                                                       |
| `memory` field on an agent              | Defaults `true` - reuses the plugin-level Mastra `Memory` when configured                                                                                                                                       |

Every field on `MastraAgentDefinition`:

| Field          | Description                                                                               |
| -------------- | ----------------------------------------------------------------------------------------- |
| `name`         | Display name. Defaults to the registry key.                                               |
| `description`  | Long-form description, surfaced as `Agent.description`.                                   |
| `instructions` | System prompt body. Required.                                                             |
| `model`        | Per-agent model override. String = `modelId` sugar; otherwise a Mastra `DynamicArgument`. |
| `tools`        | Plain record OR `(plugins) => tools` callback (see below).                                |
| `memory`       | `false` for stateless. Defaults to true when plugin memory is configured.                 |

Plugin-level fields:

| Field                   | Description                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents`                | The registry. Omit for a built-in `default` analyst.                                                                                                                                  |
| `defaultAgent`          | Id that `chatRoute` binds to when no `:agentId` is supplied. Defaults to first registered.                                                                                            |
| `defaultModel`          | Fallback for any agent that omits `model`. Same shape (string sugar or `DynamicArgument`).                                                                                            |
| `defaultModelFallbacks` | Priority-ordered list walked when no `model` / env / override is set. First entry whose endpoint exists in the workspace wins. Default interleaves Claude ↔ GPT-5 by tier, then appends an open-weights tail (see `FALLBACK_MODELS_BY_PROVIDER`). |
| `tools`                 | Ambient tools merged into every agent (per-agent tools win on collisions).                                                                                                            |
| `storage`               | `true` reuses the `lakebase` pool; an object opens a dedicated Postgres store.                                                                                                        |
| `memory`                | Same as `storage` but for the PgVector recall store.                                                                                                                                  |
| `modelFuzzyMatch`       | `false` to disable fuzzy snapping of model ids against the workspace's Model Serving catalogue. Defaults to `true`.                                                                   |
| `modelFuzzyThreshold`   | Fuse.js score threshold (`0` exact, `1` anything). Defaults to `0.4`.                                                                                                                 |
| `modelCacheTtlMs`       | TTL for the cached endpoint list, per workspace host. Defaults to 5 minutes. Concurrent callers share one in-flight fetch.                                                            |
| `modelOverride`         | `false` to disable per-request `X-Mastra-Model` / `?model=` / body overrides. Defaults to `true`.                                                                                     |

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
description plus a 6-char SHA-1 prefix - stable across runs so traces
stay readable. Pass an explicit `id` when you want to pin one.

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

### No explicit ask (priority-ordered fallback list)

When nothing is set, the resolver walks an opinionated
priority-ordered list and returns **the first id that is actually
present in the workspace's endpoint listing**. This is how a workspace
without Claude Opus still gets a sensible default automatically -
the resolver skips ahead to whichever Sonnet / GPT-5 / Llama variant
is wired up.

The defaults live in `FALLBACK_MODELS_BY_PROVIDER` (one bucket per
vendor, most powerful first) and `FALLBACK_MODEL_IDS` (the walked
order). Closed-source vendors are **interleaved by tier** so a
workspace missing Claude Opus still lands on a flagship GPT-5 on the
*second* probe instead of having to descend the entire Claude ladder
before another vendor is tried. The open-weights bucket is appended
verbatim as the universal floor.

| Provider bucket                            | Models (most powerful first)                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `FALLBACK_MODELS_BY_PROVIDER.claude`       | Opus 4.8 → 4.7 → 4.6 → 4.5 → 4.1, Sonnet 4.6 → 4.5 → 4, Haiku 4.5                           |
| `FALLBACK_MODELS_BY_PROVIDER.gpt`          | 5.5 Pro → 5.5 → 5.4 → 5                                                                     |
| `FALLBACK_MODELS_BY_PROVIDER.openSource`   | Llama 4 Maverick → Llama 3.3 70B → GPT-OSS 120B → GPT-OSS 20B → Qwen-35 122B → Llama 3.1 8B |

Resulting `FALLBACK_MODEL_IDS` walk order:

1. Claude Opus 4.8, GPT-5.5 Pro,
2. Claude Opus 4.7, GPT-5.5,
3. Claude Opus 4.6, GPT-5.4,
4. Claude Opus 4.5, GPT-5,
5. Claude Opus 4.1, Sonnet 4.6 → 4.5 → 4, Haiku 4.5 _(Claude continues solo once the GPT-5 list runs out)_,
6. Open-weights tail (Llama 4 → Llama 3.3 → GPT-OSS → Qwen → Llama 3.1).

Pin a regulated workspace to an approved subset (or insert custom
endpoints in front of the catalogue) via
`config.defaultModelFallbacks`:

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
import { pluginUtils } from "@dbx-tools/appkit-shared";
import { mastra } from "@dbx-tools/appkit-mastra";

const m = pluginUtils.require(this.context, mastra).exports();
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

Both `storage` and `memory` opt-in to a Lakebase-backed Mastra Memory:

- `storage: true` reuses the `lakebase` plugin's pool through
  `PostgresStore` for threads/messages.
- `memory: true` reuses the same pool through `PgVector` for recall.
- Pass an explicit `PostgresStoreConfig` / `MastraMemoryConfig` object
  instead of `true` to open a dedicated store.

When either is enabled the plugin declares the `lakebase` plugin as a
required resource at registration time; AppKit surfaces a clear error
if `lakebase()` isn't in your plugin list.

## Runtime exports

Other plugins / route handlers can introspect the registry via the
`exports()` surface, modeled on AppKit's:

```ts
import { pluginUtils } from "@dbx-tools/appkit-shared";
import { mastra } from "@dbx-tools/appkit-mastra";

const m = pluginUtils.require(this.context, mastra).exports();
m.list(); // ["analyst", "helper"]
m.get("analyst"); // Agent | null
m.getDefault(); // Agent | null
m.getMastra(); // underlying Mastra instance (advanced)
m.listModels(); // Promise<ServingEndpointSummary[]> - cached + OBO when wrapped with asUser(req)
m.clearModelsCache(); // force the next listModels() to re-fetch
```

## Client wiring

`clientConfig()` publishes the default agent id and the full registry
to `usePluginClientConfig("mastra")`, so the React client can render an
agent picker without hard-coding ids:

```tsx
const { defaultAgent, agents } = usePluginClientConfig("mastra");
const { messages, sendMessage } = useChat({
  transport: new DefaultChatTransport({
    api: `/api/mastra/route/chat/${selectedAgent ?? defaultAgent}`,
  }),
});
```

The plugin mounts at `/api/mastra` (AppKit's default) so the AI SDK
transport URL is `/api/mastra/route/chat/<agentId>`.

## License

Apache-2.0
