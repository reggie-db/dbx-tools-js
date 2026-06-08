# @dbx-tools/appkit-mastra-shared

Dependency-free wire-format contract for `@dbx-tools/appkit-mastra`.

This package exists so the React client (and any browser bundle)
can import the types and URL helpers the Mastra plugin's
`clientConfig()` publishes without pulling in `pg`, `fastembed`,
Mastra, or anything else server-only. The surface is lightweight
Zod schemas, inferred TypeScript types, URL helpers, and a
handful of structural guards.

```ts
import {
  // URL helpers
  chatUrl,
  historyUrl,
  chartUrl,
  statementUrl,
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
  type MinimalWriter,
  isGenieAgentResult,
  genieResultToWriterEvents,
} from "@dbx-tools/appkit-mastra-shared";
```

## What the plugin publishes

The Mastra plugin's `clientConfig()` returns a
{@link MastraClientConfig} JSON document. The React client picks it
up via `usePluginClientConfig<MastraClientConfig>("mastra")` and
composes URLs with the helpers below; the published paths are
derived from the plugin's mount point so `/api/<plugin name>/...`
stays correct even if the plugin is renamed.

```ts
interface MastraClientConfig {
  basePath: string;              // /api/<plugin name>
  chatPath: string;              // ${basePath}/route/chat (default agent)
  chatPathTemplate: string;      // ${basePath}/route/chat/:agentId
  modelsPath: string;            // ${basePath}/models
  historyPath: string;           // ${basePath}/route/history (default agent)
  historyPathTemplate: string;   // ${basePath}/route/history/:agentId
  chartsPathTemplate: string;    // ${basePath}/charts/:chartId
  statementsPathTemplate: string; // ${basePath}/statements/:statementId
  defaultAgent: string;          // agent id chatRoute uses when no :agentId
  agents: string[];              // every registered agent id
}
```

The chart-render pipeline uses `chartsPathTemplate` as a long-poll
endpoint: the host UI encounters a `[chart:<chartId>]` marker in
an assistant reply, calls `chartUrl(config, chartId)`, and
long-polls until the server resolves the chart to a `ready` or
`error` state. Similarly, `statementsPathTemplate` resolves
`[data:<statement_id>]` markers to inline table data via
`statementUrl(config, statementId)`.

## URL helpers

### `chatUrl(config, agentId?)`

Returns the chat endpoint for the named agent (or the default if
`agentId` is omitted). Drops the trailing `/<agentId>` segment for
the default agent so the URL matches the unrouted mount.

```tsx
import { useMemo } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { usePluginClientConfig } from "@databricks/appkit-ui/react";
import { chatUrl, type MastraClientConfig } from "@dbx-tools/appkit-mastra-shared";

function Chat() {
  const config = usePluginClientConfig<MastraClientConfig>("mastra");
  const transport = useMemo(
    () => new DefaultChatTransport({ api: chatUrl(config) }),
    [config],
  );
  return useChat({ transport });
}
```

### `historyUrl(config, options?)`

Builds the thread-history URL for an agent + page. Accepts
`{agentId?, page?, perPage?}` and appends them as query params.
Default-agent shorthand mirrors `chatUrl`.

```ts
const url = historyUrl(config, { page: 0, perPage: 20 });
const res = await fetch(url, { credentials: "include" });
const payload = (await res.json()) as MastraHistoryResponse;
// payload.uiMessages is oldest -> newest, ready to prepend to live transcript
```

### `chartUrl(config, chartId, options?)`

Substitutes the `:chartId` placeholder in `chartsPathTemplate` and
optionally appends `?timeoutMs=<n>` to tune the long-poll window.
The server blocks until the chart cache entry transitions to
`ready` / `error` or the budget elapses.

```ts
import { chartUrl, type MastraClientConfig, type Chart } from "@dbx-tools/appkit-mastra-shared";

const url = chartUrl(config, chartId, { timeoutMs: 30_000 });
const res = await fetch(url, { credentials: "include" });
const chart = (await res.json()) as Chart;
```

### `statementUrl(config, statementId, options?)`

Substitutes the `:statementId` placeholder in
`statementsPathTemplate` and optionally appends `?limit=<n>` to
cap the returned rows. Resolves `[data:<statement_id>]` markers
the agent embeds in prose.

```ts
import { statementUrl, type MastraClientConfig, type StatementData } from "@dbx-tools/appkit-mastra-shared";

const url = statementUrl(config, statementId, { limit: 100 });
const res = await fetch(url, { credentials: "include" });
const data = (await res.json()) as StatementData;
```

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
interface ServingEndpointSummary {
  name: string;        // canonical endpoint name
  task?: string;       // e.g. "llm/v1/chat"
  state?: string;      // ready / updating / failed
  description?: string;
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
`GET ${basePath}/statements/:statementId`. Mirrors the agent-side
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
[`GenieWriterEvent`](src/genie.ts) union through Mastra's
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
    case "chart":            // Mastra-only: chart rendered for the active turn
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

`isGenieAgentResult(value)` is an O(1) structural guard that
detects the agent's tool-result payload off Mastra's
`tool-result` chunks without coupling to a specific tool name.

`genieResultToWriterEvents(result)` replays the terminal
`error` event from a completed `GenieAgentResult`, useful for
reconstructing lifecycle pills on history reload. Live-only
chart specs are intentionally not replayed (the resolved
Echarts spec is held off-band on the per-request
`RequestContext`, not on the persisted summary).

## Installation

```bash
bun add @dbx-tools/appkit-mastra-shared
```

## Usage

```ts
import { chatUrl, historyUrl, chartUrl, type MastraClientConfig } from "@dbx-tools/appkit-mastra-shared";

declare const config: MastraClientConfig;

// Chat endpoint for the default agent
const chat = chatUrl(config);

// History with pagination
const history = historyUrl(config, { page: 0, perPage: 50 });

// Chart long-poll URL
const chart = chartUrl(config, "abc123", { timeoutMs: 30_000 });
```

## API

- `chatUrl(config, agentId?)` - returns the chat endpoint URL for a given agent (or the default).
- `historyUrl(config, options?)` - builds the paginated history URL for an agent.
- `chartUrl(config, chartId, options?)` - builds the long-poll chart fetch URL for a given chart id.
- `statementUrl(config, statementId, options?)` - builds the statement fetch URL for a given statement id.
- `isGenieAgentResult(value)` - O(1) structural type guard for `GenieAgentResult`.
- `genieResultToWriterEvents(result)` - replays terminal writer events from a completed result.
- `MastraClientConfig` - shape published by the plugin's `clientConfig()`.
- `MastraHistoryUIMessage` / `MastraHistoryResponse` / `MastraClearHistoryResponse` - history endpoint types.
- `ServingEndpointSummary` / `ServingEndpointsResponse` - model catalogue types.
- `Chart` / `ChartResult` / `ChartType` - chart cache entry and resolved plan types.
- `StatementData` - statement fetch response type.
- `GenieWriterEvent` - unified writer-event union (wire + Mastra-only).
- `GenieAgentResult` / `GenieSummaryItem` / `GenieDataset` / `GenieDatasetData` / `GenieDatasetChart` - workflow output shapes.
- `MinimalWriter` - structural interface for `ctx.writer`.

## License

Apache-2.0
