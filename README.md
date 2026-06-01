# dbx-tools-appkit

Bun monorepo for `@dbx-tools` AppKit add-ons: shared helpers, a Lakebase
auto-discovery helper, a Mastra plugin, and the pure-types client surface
for the Mastra plugin, plus a runnable Databricks App demo.

| Package                                                             | Path                     | Published            |
| ------------------------------------------------------------------- | ------------------------ | -------------------- |
| [`@dbx-tools/appkit-shared`](packages/shared)                       | `packages/shared`        | yes                  |
| [`@dbx-tools/appkit-autopg`](packages/autopg)                       | `packages/autopg`        | yes                  |
| [`@dbx-tools/appkit-mastra`](packages/mastra)                       | `packages/mastra`        | yes                  |
| [`@dbx-tools/appkit-mastra-shared`](packages/mastra-shared)         | `packages/mastra-shared` | yes                  |
| [`@dbx-tools/appkit-demo`](demo)                                    | `demo`                   | no (`private: true`) |

`appkit-shared` provides small utilities (typed plugin lookup, cookie parsing,
string case helpers, console log prefixes, memoization) without pulling AppKit
types into every consumer. `appkit-autopg` is a one-line `autopg()` helper that
fills in every Lakebase Postgres env var the AppKit `lakebase` plugin needs
from whatever fragments your deployment carries (resource paths, bare hostnames,
Postgres URIs). `appkit-mastra` is a beta AppKit plugin that mounts Mastra
(`@mastra/express` + `@mastra/ai-sdk` `chatRoute`), resolves the model from the
workspace host and `/serving-endpoints` with per-request user auth, reuses the
`lakebase` plugin pool for Mastra Memory when `storage` / `memory` are enabled,
and forwards Genie streaming events through `ToolStream` for live UI feedback.
`appkit-mastra-shared` is the dependency-free wire-format contract (types +
`chatUrl` helper) that the React client imports without dragging in `pg`,
`fastembed`, or Mastra itself.

### Memory in action

With `storage: true, memory: true`, Mastra persists conversation history into
the `lakebase` Postgres pool and surfaces recent turns as input suggestions on
the next visit:

<p align="center">
  <img src="docs/memory.gif" alt="Demo chat input showing remembered prompts" width="420">
</p>

## Develop

From the repo root:

```bash
bun install
bun typecheck
bun run build
```

Run the demo against a real workspace:

```bash
cd demo
cp .env.example .env   # DATABRICKS_HOST, serving / Lakebase vars as documented there
databricks auth login --host "$DATABRICKS_HOST"
bun dev                # or `bun dev` from the repo root (`--filter` demo)
```

See [demo/README.md](demo/README.md) for layout, scripts, bundle deploy notes,
and how the client targets `/api/mastra/route/chat/<agentId>`.

## Scaffold a new package

```bash
bun run create plugin <slug>   # AppKit plugin stub under packages/<slug>
bun run create shared <slug>   # types-only package stub
```

## Release

Publishable packages use Changesets. Workspace members under `@dbx-tools/*` are
configured as `fixed` in [`.changeset/config.json`](.changeset/config.json) so
they version together. Add a change:

```bash
bun changeset
# pick packages + bump level, write a one-liner summary
```

The [release workflow](.github/workflows/release.yml) is **disabled by default**
(trigger is `workflow_dispatch` only) until packages are ready to ship. To
enable real publishes:

1. Add an `NPM_TOKEN` repo secret with publish access to the `@dbx-tools`
   scope (npm automation token, `Read and Publish` scope).
2. Flip the workflow trigger from `workflow_dispatch:` to
   `push: { branches: [main] }`.

Once enabled, every push to `main` either opens a "Version Packages" PR that
applies pending changesets and regenerates changelogs, or - if no pending
changesets remain - publishes the bumped packages via `bun run release`. The
`release` script (`scripts/publish.ts`) snapshots each package's minimal
`package.json`, mutates it in place with the npm-ready `main` / `types` /
`exports` / `files` fields, runs `changeset publish`, then restores the
originals so the workspace shape on disk stays clean.

To publish manually from a developer machine (after `bun changeset version`):

```bash
bun run release            # bun scripts/build.ts && bun scripts/publish.ts
```

## License

Apache-2.0
