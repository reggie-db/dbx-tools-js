# @dbx-tools/appkit-mastra-shared

Dependency-free wire-format contract for `@dbx-tools/appkit-mastra`.

This package exists so the React client (and any browser bundle)
can import the types and URL helpers the Mastra plugin's
`clientConfig()` publishes without pulling in `pg`, `fastembed`,
Mastra, or anything else server-only. There is no runtime - just
TypeScript types and three small URL helpers.

```ts
import {
  chatUrl,
  historyUrl,
  type MastraClientConfig,
  type RenderChartRequest,
  type RenderChartResponse,
  type ServingEndpointSummary,
  type ServingEndpointsResponse,
  type MastraHistoryUIMessage,
  type MastraHistoryResponse,
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
  basePath: string;            // /api/<plugin name>
  chatPath: string;            // ${basePath}/route/chat (default agent)
  chatPathTemplate: string;    // ${basePath}/route/chat/:agentId
  modelsPath: string;          // ${basePath}/models
  historyPath: string;         // ${basePath}/route/history (default agent)
  historyPathTemplate: string; // ${basePath}/route/history/:agentId
  renderChartPath: string;     // ${basePath}/route/render-chart
  defaultAgent: string;        // agent id chatRoute uses when no :agentId
  agents: string[];            // every registered agent id
}
```

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

### Inline chart rendering

`POST ${basePath}/route/render-chart` accepts a tabular dataset and
returns an Echarts `EChartsOption` JSON. The chat client uses this
to fill `[[chart:<chartId>]]` markers the model emits in its
markdown reply (paired with `kind: "chart"` writer events from
either Genie or the `render_data` tool).

```ts
interface RenderChartRequest {
  title: string;
  description?: string;
  data: Array<Record<string, unknown>>;
}

interface RenderChartResponse {
  option: Record<string, unknown>; // EChartsOption
  chartType: string;               // "bar" | "line" | "area" | "scatter" | "pie"
}
```

The endpoint runs a server-side Mastra agent on a fast-tier model
(`modelForTier(ModelTier.Fast)`) and returns a pre-built
`EChartsOption`; the client renders it verbatim with
`<ReactECharts option={...} />`. Auth flows through the same
session-cookie middleware as the chat / history routes, so OBO
auth stays user-scoped.

## License

Apache-2.0
