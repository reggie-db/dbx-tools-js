# @dbx-tools/appkit-mastra-shared

Dependency-free wire-format contract for `@dbx-tools/appkit-mastra`.

This package exists so the React client (and any browser bundle)
can import the types, schemas, and route segments the Mastra plugin's
`clientConfig()` publishes without pulling in `pg`, `fastembed`,
Mastra, or anything else server-only. The surface is lightweight
Zod schemas, inferred TypeScript types, the shared `MASTRA_ROUTES`
segments, the embed-marker grammar, and a handful of structural
guards. The HTTP client that drives these routes
(`MastraPluginClient`) ships from `@dbx-tools/appkit-mastra-ui`.

```ts
import {
  // Shared route segments (server registration + client URL building)
  MASTRA_ROUTES,
  // Protocol types + schemas
  type MastraClientConfig,
  type ServingEndpointSummary,
  type ServingEndpointsResponse,
  type MastraHistoryUIMessage,
  type MastraHistoryResponse,
  type MastraClearHistoryResponse,
  type Chart,
  type ChartResult,
  type ChartType,
  type StatementData,
  // Genie writer-event vocabulary + workflow output shapes
  type GenieAgentResult,
  type GenieSummaryItem,
  type GenieDataset,
  type GenieDatasetData,
  type GenieDatasetChart,
  type GenieWriterEvent,
  type MastraWriter,
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
  basePath: string;       // /api/<plugin name>
  defaultAgent: string;   // agent the client talks to when no :agentId
  agents: string[];       // every registered agent id
}

// Relative segments under basePath (single source of truth)
const MASTRA_ROUTES = {
  history: "/route/history",
  suggestions: "/suggestions",
  models: "/models",
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
plus `history()` / `clearHistory()`, `models()`, and `suggestions()`;
see `@dbx-tools/appkit-mastra-ui`.

## Wire-format types

### Chat history

`MastraHistoryUIMessage` is the structural shape `toAISdkV5Messages`
produces server-side. It is 1:1 compatible with `UIMessage` from the
`ai` package; clients can safely cast when needed.

```ts
interface MastraHistoryUIMessage {
  id: string;
  role: "system" | "user" | "assistant";
  parts: ReadonlyArray<unknown>;
  metadata?: unknown;
}

interface MastraHistoryResponse {
  uiMessages: MastraHistoryUIMessage[];
  page: number;
  perPage: number;
  total: number;
  hasMore: boolean;
}
```

### Model catalogue

`GET ${basePath}/models` returns every Model Serving endpoint the
agent's resolver can fall back to, filtered down to chat-capable
endpoints. Useful for a model-picker dropdown that drives the
per-request `X-Mastra-Model` header.

```ts
interface ModelProfile {
  quality?: number;    // higher is more capable
  speed?: number;      // throughput; higher is faster
  cost?: number;       // relative price; lower is cheaper
}

interface ServingEndpointSummary {
  name: string;        // canonical endpoint name
  task?: string;       // e.g. "llm/v1/chat"
  state?: string;      // ready / updating / failed
  description?: string;
  profile?: ModelProfile; // FMAPI scores when scored; absent otherwise
}

interface ServingEndpointsResponse {
  endpoints: ServingEndpointSummary[];
}
```

### Charts

The `Chart` type represents a chart cache entry in three lifecycle
states: processing (both `result` and `error` absent), ready
(`result` set), or failed (`error` set).

```ts
interface Chart {
  chartId: string;
  error?: string;
  result?: {
    chartType: "bar" | "line" | "area" | "scatter" | "pie";
    option: Record<string, unknown>; // full EChartsOption spec
  };
}
```

### Statements

`StatementData` is the payload returned by
`GET ${basePath}/embed/data/:id`. Mirrors the agent-side
`get_statement` tool output so the host UI and the LLM see the
same shape.

```ts
interface StatementData {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}
```

### Genie writer-event vocabulary

The Mastra Genie agent publishes a unified
[`GenieWriterEvent`](src/protocol.ts) union through Mastra's
`ctx.writer`. Subscribers narrow on `event.type` and read the
event's flat fields directly - no payload wrapper, no
translation layer:

```ts
import type { GenieWriterEvent } from "@dbx-tools/appkit-mastra-shared";

function handleEvent(event: GenieWriterEvent) {
  switch (event.type) {
    case "started":          // Mastra-only: tool invocation began
    case "ask_genie_done":   // Mastra-only: one ask_genie turn finished
    case "summary":          // Mastra-only: structured-output coercion landed
    case "error":            // Mastra-only: terminal error
    case "status":           // wire: status transition
    case "thinking":         // wire: Genie thought
    case "text":             // wire: text delta
    case "query":            // wire: SQL emitted
    case "statement":        // wire: warehouse statement submitted
    case "rows":             // wire: row-count progress
    case "suggested_questions": // wire: follow-up suggestions
      // ...
  }
}
```

## Installation

```bash
bun add @dbx-tools/appkit-mastra-shared
```

## Usage

```ts
import { MASTRA_ROUTES, type MastraClientConfig } from "@dbx-tools/appkit-mastra-shared";

declare const config: MastraClientConfig;

// Build a route by hand (the client does this for you)
const historyPath = `${config.basePath}${MASTRA_ROUTES.history}`;
```

For anything beyond raw paths, use `MastraPluginClient` from
`@dbx-tools/appkit-mastra-ui` - it owns URL composition, fetching,
and schema validation for every route plus the agent stream.

## API

- `MASTRA_ROUTES` - relative route segments under `basePath` (single source of truth, shared with the server).
- `MastraClientConfig` - shape published by the plugin's `clientConfig()`.
- `MastraHistoryUIMessage` / `MastraHistoryResponse` / `MastraClearHistoryResponse` - history endpoint types.
- `ServingEndpointSummary` / `ServingEndpointsResponse` - model catalogue types.
- `Chart` / `ChartResult` / `ChartType` - chart cache entry and resolved plan types.
- `StatementData` - statement fetch response type.
- `GenieWriterEvent` - unified writer-event union (wire + Mastra-only).
- `GenieAgentResult` / `GenieSummaryItem` / `GenieDataset` / `GenieDatasetData` / `GenieDatasetChart` - workflow output shapes.
- `MastraWriter` - structural interface for `ctx.writer`.

## License

Apache-2.0
