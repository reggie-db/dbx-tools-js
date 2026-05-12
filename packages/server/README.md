# @reggie-db/dbx-tools-appkit

AppKit server plugin. Wraps the [genie plugin](https://databricks.github.io/appkit/docs/plugins/genie)'s `sendMessage` AsyncGenerator into an agent tool and streams phase updates onto an in-process event bus so the chat UI can render live "Submitted -> Executing SQL -> Completed" status under the running tool-call card.

The tool is auto-wired from the registered `genie` plugin's `spaces` config during `setup:complete`, so the common case is zero config.

## Quick start

Register `dbxTools()` alongside the `genie` plugin, then spread `dbxTools.toolkit()` into your agent's tool record. No `wireGenie` call, no `onPluginsReady` step:

```ts
import { createApp, genie, server, serving } from "@databricks/appkit";
import { agents, createAgent } from "@databricks/appkit/beta";
import { dbxTools } from "@reggie-db/dbx-tools-appkit";

const kpiWriter = createAgent({
  model: "databricks-claude-sonnet-4-6",
  instructions: "You are an analyst drafting the weekly KPI email...",
  tools(plugins) {
    return {
      ...plugins.dbxTools.toolkit(),
    };
  },
});

await createApp({
  plugins: [
    server(),
    serving({
      endpoints: {
        default: { env: "DATABRICKS_SERVING_ENDPOINT_NAME" },
      },
    }),
    genie(), // defaults to { default: DATABRICKS_GENIE_SPACE_ID }
    dbxTools(),
    agents({
      agents: { "kpi-writer": kpiWriter },
      defaultAgent: "kpi-writer",
    }),
  ],
});
```

Given that setup, the agent receives a single `genie` tool wired to the genie plugin's `default` space.

### Multiple Genie spaces

```ts
genie({
  spaces: {
    "store-intelligence": process.env.STORE_GENIE_SPACE_ID,
    "fleet-ops": process.env.FLEET_GENIE_SPACE_ID,
  },
}),
dbxTools(),
```

Produces `genie_store_intelligence` and `genie_fleet_ops` tools. Alias `default` is named `genie`; any other alias becomes `genie_<alias>` (non-alphanumerics replaced with `_`).

### Customizing or restricting genie tools

```ts
plugins.dbxTools.toolkit({
  genie: [
    {
      alias: "store-intelligence",
      toolName: "ask_store_genie",
      description: "Ask the Store Intelligence Genie space for PSPW, YoY...",
    },
  ],
})
```

Pass `genie: false` to omit genie tools entirely.

## Injected routes

Mounted under `/api/dbx-tools/` by AppKit's server plugin:

| Method | Path             | Purpose                                     |
| ------ | ---------------- | ------------------------------------------- |
| `GET`  | `/tool-progress` | SSE stream of `ToolProgressEvent` payloads. |

## Programmatic API

```ts
appkit.dbxTools.wireGenie(alias, sendMessage); // manual override; usually unnecessary
appkit.dbxTools.listWiredGenieAliases();
appkit.dbxTools.publishToolProgress({ tool, phase, label, detail });
appkit.dbxTools.subscribeToolProgress((event) => { ... });
appkit.dbxTools.toolkit(options);
```

## Types

Wire-format types (`ToolProgressEvent`, `ToolProgressPhase`) live in [`@reggie-db/dbx-tools-appkit-shared`](../shared) and are re-exported from this package, so a single import gets you both the runtime and the contracts:

```ts
import { dbxTools, type ToolProgressEvent } from "@reggie-db/dbx-tools-appkit";
```

## Development

From the repo root:

```bash
pnpm install
pnpm --filter @reggie-db/dbx-tools-appkit typecheck
```

## License

Apache-2.0
