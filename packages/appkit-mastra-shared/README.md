# @dbx-tools/appkit-mastra-shared

Dependency-free wire-format contract for `@dbx-tools/appkit-mastra`.

This package exists so the React client (and any browser bundle)
can import the types, schemas, and route segments the Mastra plugin's
`clientConfig()` publishes without pulling in `pg`, `fastembed`,
Mastra, or anything else server-only. The surface is lightweight
Zod schemas, inferred TypeScript types, the shared `MASTRA_ROUTES`
segments, the embed-marker grammar, and a handful of structural
guards - see [`src/protocol.ts`](src/protocol.ts) for the full set.
The HTTP client that drives these routes (`MastraPluginClient`) ships
from `@dbx-tools/appkit-mastra-ui`.

```ts
import {
  MASTRA_ROUTES,
  type MastraClientConfig,
} from "@dbx-tools/appkit-mastra-shared";
```

## What the plugin publishes

The Mastra plugin's `clientConfig()` returns a
{@link MastraClientConfig} JSON document. The React client picks it
up via `usePluginClientConfig<MastraClientConfig>("mastra")` and
hands it to `new MastraPluginClient(config)` (from
`@dbx-tools/appkit-mastra-ui`). Only `basePath` matters for routing -
it encodes the plugin's mount point (`/api/<plugin name>`), so the
client stays correct even if the plugin is renamed. Every endpoint
is derived from `basePath` + a fixed segment in `MASTRA_ROUTES`,
shared between the server's route registration and the client.

```ts
interface MastraClientConfig {
  basePath: string; // /api/<plugin name>
  defaultAgent: string; // agent the client talks to when no :agentId
  agents: string[]; // every registered agent id
  feedbackEnabled: boolean; // whether the server can log MLflow feedback
}

// Relative segments under basePath (single source of truth)
const MASTRA_ROUTES = {
  history: "/route/history",
  threads: "/route/threads",
  suggestions: "/suggestions",
  models: "/models",
  feedback: "/route/feedback",
  embed: "/embed",
};
```

Conversation streaming rides the standard Mastra agent routes
(`@mastra/client-js`'s `getAgent(id).stream()`), so there's no chat
segment to keep in sync.

Every embed marker the agent emits resolves through the single
generic `${basePath}/embed/:type/:id` endpoint. The host UI parses a
`[<type>:<id>]` marker out of an assistant reply and the client
fetches it; the server dispatches on `<type>` and `404`s any type it
doesn't register. The two types it ships:

- `chart` (`/embed/chart/:id`) long-polls the chart cache until
  the entry resolves to a `ready` / `error` state.
- `data` (`/embed/data/:id`) resolves `[data:<statement_id>]`
  markers to inline table data.

`MastraPluginClient` exposes `chart(id)` / `statement(id)` for these,
plus `history()` / `clearHistory()`, `threads()` / `removeThread()` /
`renameThread()`, `setThreadId()`, `models()`, `suggestions()`, and
`feedback()`; see
`@dbx-tools/appkit-mastra-ui`.

## Wire-format types

The route payloads are typed in [`src/protocol.ts`](src/protocol.ts).
The notable ones:

- **Chat history** (`GET ${basePath}/route/history`) - paginated
  `MastraHistoryUIMessage[]`, 1:1 compatible with `UIMessage` from the
  `ai` package, so clients can cast when needed.
- **Model catalogue** (`GET ${basePath}/models`) - the chat-capable
  Model Serving endpoints the resolver can fall back to (with FMAPI
  `quality` / `speed` / `cost` scores when present), for a model-picker
  dropdown that drives the `X-Mastra-Model` header.
- **Charts** (`GET ${basePath}/embed/chart/:id`) - a chart cache entry
  in one of three lifecycle states: processing, ready (carries the
  resolved `EChartsOption`), or failed.
- **Statements** (`GET ${basePath}/embed/data/:id`) - tabular data
  mirroring the agent-side `get_statement` tool output, so the host UI
  and the LLM see the same shape.
- **Feedback** (`POST ${basePath}/route/feedback`) - a thumbs value
  and/or freeform comment for one turn, keyed by the `tr-<hex>` MLflow
  trace id the server stamps on the stream response
  (`MLFLOW_TRACE_ID_HEADER`); logged as a HUMAN trace assessment. Only
  offered when `clientConfig().feedbackEnabled` is `true`.

### Genie writer-event vocabulary

The Mastra Genie agent publishes a unified `GenieWriterEvent` union
through Mastra's `ctx.writer`. Subscribers narrow on `event.type` and
read the event's flat fields directly - no payload wrapper, no
translation layer. The union mixes wire-derived events (`status`,
`thinking`, `text`, `query`, `statement`, `rows`, `suggested_questions`)
with Mastra-only lifecycle events (`started`, `ask_genie_done`,
`summary`, `error`):

```ts
import type { GenieWriterEvent } from "@dbx-tools/appkit-mastra-shared";

function handleEvent(event: GenieWriterEvent) {
  switch (event.type) {
    case "status":
      /* status transition */ break;
    case "thinking":
      /* Genie thought */ break;
    case "query":
      /* SQL emitted */ break;
    case "error":
      /* terminal error */ break;
    // ...see src/protocol.ts for the complete union
  }
}
```

For anything beyond building raw paths, use `MastraPluginClient` from
`@dbx-tools/appkit-mastra-ui` - it owns URL composition, fetching, and
schema validation for every route plus the agent stream.

## License

Apache-2.0
