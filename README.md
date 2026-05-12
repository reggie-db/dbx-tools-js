# dbx-tools-appkit

pnpm workspace for the `@reggie-db/dbx-tools-appkit-*` packages and a runnable demo.

| Package | Path | Description |
| --- | --- | --- |
| [`@reggie-db/dbx-tools-appkit-shared`](packages/shared) | `packages/shared` | Pure-type package holding the SSE wire format (`ToolProgressEvent`, `ToolProgressPhase`). |
| [`@reggie-db/dbx-tools-appkit`](packages/server) | `packages/server` | AppKit server plugin. Wraps the `genie` plugin's `sendMessage` into an agent tool with live tool-progress over SSE. |
| [`@reggie-db/dbx-tools-appkit-ui`](packages/ui) | `packages/ui` | React `<AgentChat>` component styled to match `@databricks/appkit-ui`'s `<GenieChat>`. Imports types from the shared package, not the server, so it has no Node-only deps. |
| [`@reggie-db/dbx-tools-appkit-demo`](packages/demo) | `packages/demo` | Private demo app that wires the server plugin + UI component end to end. |

## Single source of truth for types

Both `@reggie-db/dbx-tools-appkit` and `@reggie-db/dbx-tools-appkit-ui` depend on `@reggie-db/dbx-tools-appkit-shared` via `workspace:*`. The UI does **not** import from the server package, matching the standard contract-package split:

```
@reggie-db/dbx-tools-appkit-shared   shared types (no runtime, no deps)
        ▲                ▲
        │                │
@reggie-db/dbx-tools-appkit   @reggie-db/dbx-tools-appkit-ui
       (Node, server)               (React, browser)
        ▲                ▲
        └──── demo ──────┘
```

Each consumer (`server`, `ui`) re-exports the shared types so apps only need to import the package they actually use.

## Getting started

This repo uses [pnpm](https://pnpm.io) 11+ workspaces.

```bash
pnpm install
pnpm typecheck
pnpm build
```

Run the demo against a real workspace:

```bash
cd packages/demo
cp .env.example .env  # fill in DATABRICKS_HOST + GENIE space + serving endpoint
databricks auth login --host "$DATABRICKS_HOST"
pnpm dev               # or `pnpm -w dev` from the repo root
```

## Workspace conventions

- **Source-mode `exports`.** Each package's `exports` field points at `./src/index.ts`. tsx (for the server) and Vite (for the client) both compile TypeScript on the fly across package boundaries, so no per-package build step is required during local dev.
- **One zod.** `pnpm-workspace.yaml` pins zod to the version `@databricks/appkit` ships (currently `4.3.6`) via `overrides`. Two zods in the same project break every `tool({ schema })` call with a structural-mismatch type error.
- **No `prepare` build.** Because installs from GitHub are not supported in this layout, sub-packages don't run `tsc` on install. Publish-ready dist artifacts are a future change.

## Publishing (future)

Each package's `name` is already scoped under `@reggie-db/`. To publish later you'll want to:

1. Switch the `exports` field to a built `./dist/index.js` artifact and add a `prepare`/`prepublishOnly` `tsc` script.
2. Replace `workspace:*` deps with concrete version ranges at publish time (pnpm does this automatically via `pnpm publish`).

## License

Apache-2.0
