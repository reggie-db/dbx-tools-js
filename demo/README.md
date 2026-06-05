## @dbx-tools/appkit-demo

Runnable Databricks App that wires up the AppKit plugins in this repo plus
`@dbx-tools/appkit-mastra` for the chat agent.

Generated from the AppKit `app init` template, then adapted to:

- Mount the Mastra plugin alongside `server`, `genie`, and `lakebase`,
  with `autopg()` discovery for Lakebase env vars.
- Spread the AppKit `genie` toolkit into the agent so the LLM can ask
  the configured Genie space (`DATABRICKS_GENIE_SPACE_ID`) for SQL-
  backed answers without any hand-written tool code. Genie streaming
  events (status pills, SQL text, row sets, suggested follow-ups) are
  forwarded through Mastra's `ToolStream` so the UI shows live
  progress while the model is still waiting on the final result.
- Inline-render Genie query results as Echarts visualizations. Each
  Genie SQL statement gets a short `chartId`; the model embeds
  `[[chart:<chartId>]]` in its markdown reply at the position the
  chart should appear. The chart-planner agent runs server-side per
  dataset and ships its `EChartsOption` straight back through the
  writer, so the client's `<ChartSlot>` just merges the dataset and
  spec events by `chartId` and renders inline - no HTTP round-trip
  to fetch chart specs. The system-default `render_data` tool uses
  the same pipeline, so hand-built charts and Genie charts feel
  identical in the UI. See `packages/appkit-mastra/README.md` for the full
  contract.
- Render the chat UI exclusively with `@databricks/appkit-ui`
  primitives (no `ai-elements`, no vendored shadcn) plus
  `streamdown` for GitHub-flavored markdown rendering (tables, task
  lists, strikethrough) with Shiki syntax highlighting and KaTeX
  math.
- Ship two pages backed by one shared `ChatView` component: a
  vanilla AI SDK `useChat` flow (`/chat`) and a Mastra `MastraClient`
  streaming flow (`/stream`). Both include a model-picker dropdown
  driven by `GET /api/mastra/models` (the live serving-endpoint
  catalogue) and pass the selection through an `X-Mastra-Model`
  header. Lazy-loads older history on scroll-up via
  `/api/mastra/route/history`.
- Bind to `127.0.0.1` locally for the friendliest dev URL; falls back
  to `0.0.0.0` automatically when `DATABRICKS_APP_PORT` is set (i.e.
  inside a deployed Databricks App).

## Layout

```
demo/
  appkit.plugins.json     # AppKit plugin manifest (used by `appkit plugin sync`)
  app.yaml                # Databricks App runtime config (env wiring)
  databricks.yml          # Databricks Asset Bundle: Lakebase autoscaling project
  tsconfig.json           # Solution: references client + server
  tsconfig.server.json    # Server-only typecheck
  tsconfig.client.json    # Client-only typecheck (DOM, vite types, @/* alias)
  tsdown.server.config.ts # Bundles server/server.ts into dist/ for prod
  server/
    server.ts             # autopg() then createApp({ plugins: [server(), genie(), lakebase(), mastra()] })
  client/
    index.html
    vite.config.ts        # React + Tailwind v4 + workspace `source` condition
    src/
      main.tsx            # TanStack Router shell + ErrorBoundary
      App.tsx             # router root
      ErrorBoundary.tsx
      index.css           # @import "@databricks/appkit-ui/styles.css" + tailwindcss + tw-animate-css
      lib/
        mastra-client.ts  # useMastraClient + useMastraModels + fetchMastraHistory
        genie-history.ts  # rebuild ToolEvents from /history results so reloads still show pills
        utils.ts          # cn() helper
      components/
        chat-view.tsx     # shared chat surface: appkit-ui primitives + streamdown +
                          # ChartSlot (Echarts) merging chart writer events at [[chart:<id>]] markers
      pages/
        Chat.tsx          # /chat - @ai-sdk/react useChat against /api/mastra/route/chat
        Stream.tsx        # /stream - MastraClient.stream() with live tool-output events
```

All sibling deps (`@dbx-tools/appkit-*`) are wired through `workspace:*`, so
edits to any sibling source are picked up by Vite (via the `source` export
condition) and by `tsx watch` (via `NODE_OPTIONS='--conditions=source'`)
without a publish or rebuild.

## Setup

```bash
cp .env.example .env
# Fill in DATABRICKS_HOST, DATABRICKS_SERVING_ENDPOINT_NAME,
# DATABRICKS_GENIE_SPACE_ID (genie() registers it as the `default`
# alias automatically), and the LAKEBASE_* / PG* values, then:
databricks auth login --host "$DATABRICKS_HOST"

bun install                                 # from the repo root
bun run --filter '@dbx-tools/appkit-demo' dev
# or, from inside this folder:
bun dev
```

`bun dev` starts the AppKit Express server, which mounts Vite as
middleware on the same port so the React UI hot-reloads against the
live server.

## Scripts

| Command                | What it does                                                     |
| ---------------------- | ---------------------------------------------------------------- |
| `bun dev`              | `tsx watch` over `server/server.ts` (also serves the client).    |
| `bun run build`        | `tsdown` bundles the server, then Vite builds the client.        |
| `bun run build:server` | Bundles `server/server.ts` -> `dist/server.js`.                  |
| `bun run build:client` | Vite production build into `client/dist/`.                       |
| `bun run start`        | Production entry: `node dist/server.js` against `.env`.          |
| `bun run typecheck`    | Type-check both `server/` and `client/`.                         |
| `bun run sync`         | `appkit plugin sync --write` to keep `app.yaml` in sync.         |
| `bun run typegen`      | `appkit generate-types` based on `appkit.plugins.json`.          |
| `bun run setup`        | `appkit setup --write` to scaffold any missing AppKit resources. |
| `bun run clean`        | Remove build output.                                             |

## Deploy

```bash
databricks bundle validate
databricks bundle deploy
```

See the comments in `databricks.yml` for the Lakebase project layout and the
production endpoint settings. The `app.yaml` wires `LAKEBASE_ENDPOINT` and
`DATABRICKS_GENIE_SPACE_ID` from the bundle resources into the runtime app.

## License

Apache-2.0
