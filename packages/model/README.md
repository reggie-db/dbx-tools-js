# @dbx-tools/model

Workspace-aware model selection for Databricks Model Serving: list a
workspace's `/serving-endpoints` (cached), fuzzy-match loose names like
`"claude sonnet"` to real endpoint ids, rank endpoints by capability
class, and resolve a single usable model id with an offline fallback
floor.

This is the server-side package (it holds a `WorkspaceClient` and
AppKit's cache). Browser consumers want the pure
[`@dbx-tools/model-shared`](../model-shared) surface, which this package
re-exports.

## Install

```bash
npm install @dbx-tools/model
```

Peer: `@databricks/appkit` (provides the cache the listing runs through).

## Usage

Hold a `WorkspaceClient` and just want a usable model id? `selectModel`
lists the catalogue (cached) and resolves in one call. An `explicit`
name is fuzzy-matched; without one, a `modelClass` ceiling (or the
operator `fallbacks`, then the static floor) decides.

```ts
import { WorkspaceClient } from "@databricks/sdk-experimental";
import { selectModel, searchModels } from "@dbx-tools/model";

const client = new WorkspaceClient({});
const host = (await client.config.getHost()).toString();

// Fuzzy name -> real endpoint id (+ how it was reached).
const { modelId, source } = await selectModel(client, host, {
  explicit: "claude sonnet",
}); // -> { modelId: "databricks-claude-sonnet-4-6", source: "fuzzy-match" }

// Best balanced-or-cheaper chat model the workspace actually has.
const fast = await selectModel(client, host, { modelClass: "chat-balanced" });

// Or get the full ranked list (model picker / CLI).
const ranked = await searchModels(client, host, { search: "opus", limit: 5 });
```

The capability class acts as a **ceiling**: `chat-balanced` can fall to
`chat-fast` but never escalate to `chat-thinking`. Embedding endpoints
surface only when `modelClass` is explicitly `embedding`.

### Pure helpers (no I/O)

If you already hold the endpoint list (e.g. from a cached `/models`
response), use the pure functions directly:

```ts
import { resolveModelId, rankModels, resolveModel } from "@dbx-tools/model";

resolveModelId("claude sonnet", endpoints); // single best fuzzy match
rankModels(endpoints, { search: "opus", limit: 3 }); // ranked list
resolveModel(endpoints, { modelClass: "chat-fast" }); // single id + source
```

### Listing the catalogue directly

`selectModel` / `searchModels` list endpoints for you, but you can also
reach the catalogue functions:

```ts
import {
  listServingEndpoints,
  listServingEndpointsUncached,
  searchServingEndpoints,
  clearServingEndpointsCache,
} from "@dbx-tools/model";

// Cached + enriched (model-class stamp, embedding dimensions) through
// AppKit's CacheManager. Keyed by `host`.
const endpoints = await listServingEndpoints(client, host);

// One-shot, dependency-light: straight from the SDK, no cache and no
// enrichment. For CLIs / non-AppKit contexts that only need names.
const raw = await listServingEndpointsUncached(client);

// Fuzzy-rank a held list by name (the core resolveModelId builds on).
searchServingEndpoints("claude sonnet", endpoints); // ScoredEndpoint[]

// Force-evict one host's cache entry (or all when omitted).
await clearServingEndpointsCache(host);
```

## How resolution works

1. **Explicit ask** - fuzzy-matched within the optional class ceiling
   (or returned verbatim when `fuzzy: false`).
2. **No explicit ask** - the first operator-pinned `fallbacks` entry
   that exists in the live catalogue wins first, then the ranked live
   catalogue, then a small static `FALLBACK_MODEL_IDS` floor when the
   catalogue yields nothing in range (so a model id is always returned
   even offline).

Capability bands are derived from the live workspace catalogue (the
Foundation Model API quality/speed/cost scores), not a hand-maintained
table - see `@dbx-tools/model-shared` for the classifier.
