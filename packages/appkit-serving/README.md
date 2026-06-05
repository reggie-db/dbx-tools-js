# @dbx-tools/appkit-serving

Tiny set of typed accessors over Databricks
`/api/2.0/serving-endpoints`. Use it when you need to rank, filter, or
introspect Foundation Model serving endpoints in a Databricks App
without re-implementing the response parsing yourself.

The wrapper is intentionally minimal: a `servingEndpoints()` listing
that goes through `apiUtils.fetchApi` (so OBO auth from the AppKit
execution context is respected automatically) plus a handful of
generators that pull the fields the SDK types don't currently expose
(`model_class`, `ai_gateway_model_profile.{speed,quality,cost}`,
plus a derived semver from the endpoint name).

```ts
import {
  servingEndpoints,
  foundationModelClass,
  foundationModelProfile,
  foundationModelVersion,
  type ServingEndpoint,
} from "@dbx-tools/appkit-serving";

// Inside an AppKit request handler / setup:complete hook / route:
const endpoints = await servingEndpoints();

// Pluck the AI Gateway profile + class for ranking.
for (const e of endpoints) {
  const profile = foundationModelProfile(e); // { speed, quality, cost } | undefined
  const cls = foundationModelClass(e);       // "claude" | "gpt-oss" | "gemini" | ...
  const ver = foundationModelVersion(e);     // "4.6.0" | "120.0.0.120b" | ...
}
```

## `servingEndpoints()`

Calls `/api/2.0/serving-endpoints` via
`apiUtils.fetchApi<{ endpoints?: ServingEndpoint[] }>("serving-endpoints")`
and returns the list (or `[]`).

`apiUtils.fetchApi` resolves the workspace client off the active
AppKit execution context, so this **must be called inside an
initialized AppKit app** (i.e. after `await createApp(...)`). Tests
that don't want to bootstrap AppKit should mock the function or feed
fixture JSON directly into the consumer; see
`packages/appkit-serving/test/models.test.ts` in this repo for the
inline-JSON pattern.

The call is uncached today; wrap it on the caller side with
`apiUtils.fetchApi`'s cache hook (`{ userKey, options: { ttl } }`)
when you want TTL'd results.

## `ServingEndpoint`

A minimal local interface modeling just the fields the helpers in this
package read:

```ts
interface ServingEndpoint extends Record<string, unknown> {
  name: string;
  config?: {
    served_entities?: {
      foundation_model?: {
        model_class?: string;
        ai_gateway_model_profile?: {
          speed?: number;
          quality?: number;
          cost?: number;
        };
      };
    }[];
  };
}
```

The package deliberately does **not** extend
`serving.ServingEndpoint` from `@databricks/sdk-experimental` -
the SDK's `FoundationModel` type doesn't declare `model_class` or
`ai_gateway_model_profile` (the API surfaces them but the SDK types
lag), so extending gains nothing and adds noise.

## Foundation Model accessors

All take a single `ServingEndpoint`:

| Helper                     | Returns                                | Notes                                                                                           |
| -------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `foundationModels(e)`      | `Generator<FoundationModel>`           | Yields every `served_entities[*].foundation_model` whose entity `type` is `FOUNDATION_MODEL`.   |
| `foundationModelClass(e)`  | `string \| undefined`                  | Convenience over `foundationModelClasses` - first non-empty `model_class`.                      |
| `foundationModelClasses(e)` | `Generator<string>`                   | Yields each foundation model's `model_class`.                                                   |
| `foundationModelProfile(e)` | `AiGatewayModelProfile \| undefined`  | First non-empty `ai_gateway_model_profile` with `speed`/`quality`/`cost` defaulted to `0`.      |
| `foundationModelProfiles(e)` | `Generator<AiGatewayModelProfile>`   | Same shape, every model.                                                                        |
| `foundationModelVersion(e)` | `string \| undefined`                  | Best-effort semver derived from the endpoint name (see below).                                  |

### Version parsing

`foundationModelVersion` extracts a sortable version string from the
endpoint `name`:

| Endpoint name                                | Version           |
| -------------------------------------------- | ----------------- |
| `databricks-claude-opus-4-7`                 | `4.7.0`           |
| `databricks-claude-sonnet-4`                 | `4.0.0`           |
| `databricks-llama-4-maverick`                | `4.0.0`           |
| `databricks-gpt-oss-120b`                    | `120.0.0.120b`    |
| `databricks-gemma-3-12b`                     | `3.12.0.12b`      |
| `databricks-qwen3-next-80b-a3b-instruct`     | `3.80.3.80ba3b`   |
| `databricks-meta-llama-3-3-70b-instruct`     | `3.3.70.70b`      |
| `databricks-bge-large-en` (no digits)        | `undefined`       |
| Non-FOUNDATION_MODEL endpoints               | `undefined`       |

Each `<digits>[<letters>]` chunk in the name contributes its numeric
prefix to the version (up to 3 slots = MAJOR.MINOR.PATCH). Chunks with
trailing letters - and any overflow chunks past the 3rd - contribute
their full form to a 4th dotted component.

## Building a ranker

The helpers compose well with a small filter / threshold pipeline:

```ts
import {
  servingEndpoints,
  foundationModelClass,
  foundationModelProfile,
} from "@dbx-tools/appkit-serving";

async function pickBestClaude() {
  const endpoints = (await servingEndpoints()).filter(
    (e) => foundationModelProfile(e) !== undefined,
  );

  // Just Claude, ranked by AI Gateway quality.
  const claudes = endpoints.filter(
    (e) => foundationModelClass(e)?.toLowerCase() === "claude",
  );
  claudes.sort(
    (a, b) =>
      (foundationModelProfile(b)!.quality ?? 0) -
      (foundationModelProfile(a)!.quality ?? 0),
  );
  return claudes[0];
}
```

`packages/appkit-serving/test/models.test.ts` in this repo demonstrates a
fuller `selectEndpoints({ classes, speed, quality })` ranker built on
the same primitives - including a normalized `[min, max]` distribution
filter that always returns at least the single top item when the
threshold cuts everything out.

## License

Apache-2.0
