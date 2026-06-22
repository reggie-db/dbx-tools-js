## @dbx-tools/appkit-demo

Runnable Databricks App that wires up the AppKit plugins in this repo plus
`@dbx-tools/appkit-mastra` for the chat agent.

Generated from the AppKit `app init` template, then adapted to:

- Mount the Mastra plugin alongside `server`, `genie`, and `lakebase`,
  booting through `@dbx-tools/appkit-config`'s `createApp` so Lakebase
  env vars are auto-discovered (`autopg()`) before delegating to AppKit.
- Hand the central Mastra agent the flat Genie toolset
  (`ask_genie`, `get_statement`, `prepare_chart`, plus per-space
  description / serialization tools) and the canonical
  `GENIE_INSTRUCTIONS` block so the LLM can ask the configured
  Genie space (`DATABRICKS_GENIE_SPACE_ID`) for SQL-backed
  answers without any hand-written tool code. Genie streaming
  events (status pills, thinking, SQL text, row sets, suggested
  follow-ups) are forwarded through Mastra's `ToolStream` so the
  UI shows live progress while the model is still waiting on the
  final result.
- Inline-render query results as Echarts visualizations. The
  `prepare_chart` and `render_data` tools mint a short `chartId`
  and kick chart planning into the background; the model embeds
  `[chart:<chartId>]` in its markdown reply at the position the
  chart should appear. The client's `<ChartSlot>` long-polls
  `${basePath}/embed/chart/:id` (the generic embed route the Mastra
  plugin exposes) for the resolved `EChartsOption` and renders it in
  place. Unknown or TTL-expired ids resolve as nothing so the
  prose flows undisturbed. See `packages/appkit-mastra/README.md`
  for the full contract.
- Render the chat UI with the publishable `@dbx-tools/appkit-mastra-ui`
  package (built on `@databricks/appkit-ui` primitives plus
  `streamdown` for GitHub-flavored markdown with Shiki syntax
  highlighting and KaTeX math). The demo is a consumer of that
  package, not the home of the chat code.
- Ship the self-contained `MastraChat` drop-in (`/stream`) that wires
  itself from the Mastra plugin config and streams over
  `@mastra/client-js` (`getAgent(id).stream()`). Includes a
  model-picker dropdown driven by `GET /api/mastra/models` (the live
  serving-endpoint catalogue), passing the selection through an
  `X-Mastra-Model` header, and lazy-loads older history on scroll-up
  via `/api/mastra/route/history`.
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
    server.ts             # createApp (appkit-config) -> autopg() then AppKit createApp({ plugins: [server(), genie(), lakebase(), mastra()] })
  client/
    index.html
    vite.config.ts        # React + Tailwind v4 + workspace `source` condition
    src/
      main.tsx            # TanStack Router shell + ErrorBoundary
      App.tsx             # router root
      ErrorBoundary.tsx
      index.css           # @import appkit-ui/styles.css + tailwindcss + @dbx-tools/appkit-mastra-ui/styles.css
      pages/
        Stream.tsx        # /stream - <MastraChat> drop-in from @dbx-tools/appkit-mastra-ui
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
