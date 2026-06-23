# @dbx-tools/model-shared

The pure, browser-safe surface of [`@dbx-tools/model`](../model): the
model-class taxonomy, the serving-endpoint descriptor, the model-lookup
request / ranked-result contract (zod schemas + inferred types), and the
score-driven class classifier.

No `node:*` imports, no `WorkspaceClient`, no I/O - safe to import from a
client bundle. A frontend uses this to validate a lookup request, type a
ranked response, and bucket a `/models` payload by class; an agent tool
can adopt `ModelQuerySchema` directly as its `inputSchema`. Live endpoint
listing and fuzzy resolution live in `@dbx-tools/model`.

## Install

```bash
npm install @dbx-tools/model-shared
```

## Usage

```ts
import {
  ModelClass,
  ModelQuerySchema,
  classifyEndpoints,
  type ServingEndpointSummary,
} from "@dbx-tools/model-shared";

// Validate a caller's lookup request (e.g. an agent tool input).
const query = ModelQuerySchema.parse({ search: "claude sonnet", limit: 5 });

// Bucket a /models response into capability bands, best-first per band.
const byClass = classifyEndpoints(endpoints);
const thinking = byClass[ModelClass.ChatThinking];
```

## What's here

- **`ModelClass`** - `chat-thinking` / `chat-balanced` / `chat-fast` /
  `embedding`, plus its zod schema.
- **`ServingEndpointSummary`** - the stable endpoint descriptor (name,
  task, state, `profile` scores, classified `class`, embedding
  `dimension`).
- **`ModelQuery` / `RankedModel`** - the lookup request and ranked
  result schemas.
- **`classifyEndpoints`** - buckets endpoints into classes from the
  Foundation Model API quality/speed/cost scores (relative quantiles,
  not fixed cut-offs), with a family-name heuristic for unscored chat
  endpoints.

> The offline fallback model list is a server concern and lives in
> `@dbx-tools/model`: a browser never talks to Databricks directly, so it
> consumes the live `/models` response rather than a baked-in list.
