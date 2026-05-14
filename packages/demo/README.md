# @dbx-tools/appkit-demo

Runnable AppKit demo that wires up all three sibling packages in this repo:

- [`@dbx-tools/appkit-genie`](../appkit-genie) (server plugin) auto-wires the `genie` plugin and exposes a `genie` tool with live tool-progress over SSE.
- [`@dbx-tools/appkit-genie-ui`](../appkit-genie-ui) (React component) renders `<AgentChat>` and subscribes to the tool-progress channel to surface phase updates under the running tool card.
- [`@dbx-tools/appkit-genie-shared`](../appkit-genie-shared) is pulled in transitively via the two packages above for the shared `ToolProgressEvent` contract.

All sibling deps are wired through `workspace:*`, so any change you make to the source of any sibling package is hot-reloaded in the demo without a publish or build step.

## Layout

```
packages/appkit-demo/
  server/
    server.ts            # createApp(): server, serving, genie, dbxTools, agents
    agents/analyst.ts    # createAgent() with a single genie tool
  client/
    index.html
    vite.config.ts
    src/
      main.tsx           # ReactDOM root
      App.tsx            # <AgentChat agent="analyst" />
      index.css          # imports @databricks/appkit-ui/styles.css
```

## Setup

```bash
cp .env.example .env
# Edit .env to fill in DATABRICKS_HOST, DATABRICKS_GENIE_SPACE_ID, and
# DATABRICKS_SERVING_ENDPOINT_NAME, then:
databricks auth login --host "$DATABRICKS_HOST"

bun install                                 # from the repo root
bun run --filter '@dbx-tools/appkit-demo' dev
# or, from inside this folder:
bun dev
```

`bun dev` starts AppKit's server (which mounts Vite in middleware mode), so the React UI hot-reloads against the live server.

## What happens at runtime

1. AppKit boots, runs each plugin's `setup()`, then fires `setup:complete`.
2. `dbxTools` reads `genie.config.spaces` during `setup:complete` and creates a `genie` tool wired to the default space. No `onPluginsReady` step is needed.
3. The analyst agent's `tools(plugins)` callback spreads `plugins.dbxTools.toolkit()` to receive that `genie` tool.
4. The React app POSTs each user turn to `/api/agents/chat` and opens an SSE connection to `/api/dbx-tools/tool-progress`. As the agent calls `genie`, phase events (`Submitted`, `Executing SQL`, `Fetching result`, `Completed`) stream live underneath the tool-call card.

## Customizing

- **Multiple Genie spaces.** Add more entries to `genie({ spaces: { ... } })`; `dbxTools` produces one `genie_<alias>` tool per space automatically.
- **Other agents.** Drop additional `createAgent({...})` definitions into `server/agents/`, register them on `agents({ agents: { ... } })`, and switch `<AgentChat agent="...">` to match.
- **Other AppKit plugins.** Spread their toolkits next to `plugins.dbxTools.toolkit()` in the agent's `tools()` callback (e.g. `...plugins.files.toolkit()`).

## Scripts

| Command          | What it does                                                  |
| ---------------- | ------------------------------------------------------------- |
| `bun dev`        | `tsx watch` over `server/server.ts` (also serves the client). |
| `bun run build`  | TypeScript build of the server + Vite build of the client.    |
| `bun typecheck`  | Type-check both `server/` and `client/`.                      |
| `bun run clean`  | Remove build output.                                          |

## License

Apache-2.0
