## @dbx-tools/appkit-demo

Runnable Databricks App that wires up the AppKit plugins in this repo plus
`@dbx-tools/appkit-mastra` for the chat agent.

Generated from the AppKit `app init` template, then adapted to:

- Mount the Mastra plugin alongside `server`, `serving`, and `lakebase`.
- Use the AI Elements chat UI on the client, hitting the Mastra-mounted
  `/api/mastra/route/chat` SSE endpoint via `@ai-sdk/react`'s `useChat`.

## Layout

```
demo/
  appkit.plugins.json     # AppKit plugin manifest (used by `appkit plugin sync`)
  app.yaml                # Databricks App runtime config (env wiring)
  databricks.yml          # Databricks Asset Bundle: Lakebase autoscaling project
  tsconfig.json           # Solution: references client + server
  tsconfig.shared.json    # Common compiler options (strict, source condition)
  tsconfig.server.json    # Server-only typecheck
  tsconfig.client.json    # Client-only typecheck (DOM, vite types, @/* alias)
  tsdown.server.config.ts # Bundles server/server.ts into dist/ for prod
  server/
    server.ts             # createApp({ plugins: [server(), serving(), lakebase(), mastra()] })
  client/
    index.html
    vite.config.ts        # React + Tailwind v4 + workspace `source` condition
    components.json       # shadcn registry config
    src/
      main.tsx
      App.tsx             # AI SDK chat UI hitting /api/mastra/route/chat
      ErrorBoundary.tsx
      index.css           # @import "@databricks/appkit-ui/styles.css" + tailwindcss
      lib/utils.ts        # cn() helper
      components/ui/      # shadcn primitives
      components/ai-elements/  # AI Elements chat components (vendored)
```

All sibling deps (`@dbx-tools/appkit-*`) are wired through `workspace:*`, so
edits to any sibling source are picked up by Vite (via the `source` export
condition) and by `tsx watch` (via `NODE_OPTIONS='--conditions=source'`)
without a publish or rebuild.

## Setup

```bash
cp .env.example .env
# Fill in DATABRICKS_HOST, DATABRICKS_SERVING_ENDPOINT_NAME, and the
# LAKEBASE_* / PG* values, then:
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
