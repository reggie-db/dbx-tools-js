# dbx-tools-js

Bun monorepo for `@dbx-tools` AppKit add-ons: shared helpers, a Lakebase
auto-discovery helper, a Mastra plugin, and the pure-types client surface
for the Mastra plugin, plus a runnable Databricks App demo.

| Package                                                                    | Path                            | Published            |
| -------------------------------------------------------------------------- | ------------------------------- | -------------------- |
| [`@dbx-tools/shared`](packages/shared)                                     | `packages/shared`               | yes                  |
| [`@dbx-tools/sdk-shared`](packages/sdk-shared)                             | `packages/sdk-shared`           | yes                  |
| [`@dbx-tools/genie-shared`](packages/genie-shared)                         | `packages/genie-shared`         | yes                  |
| [`@dbx-tools/genie`](packages/genie)                                       | `packages/genie`                | yes                  |
| [`@dbx-tools/appkit-config`](packages/appkit-config)                       | `packages/appkit-config`        | yes                  |
| [`@dbx-tools/appkit-serving`](packages/appkit-serving)                     | `packages/appkit-serving`       | yes                  |
| [`@dbx-tools/appkit-mastra`](packages/appkit-mastra)                       | `packages/appkit-mastra`        | yes                  |
| [`@dbx-tools/appkit-mastra-shared`](packages/appkit-mastra-shared)         | `packages/appkit-mastra-shared` | yes                  |
| [`@dbx-tools/appkit-mastra-ui`](packages/appkit-mastra-ui)                 | `packages/appkit-mastra-ui`     | yes                  |
| [`@dbx-tools/appkit-demo`](demo)                                           | `demo`                          | no (`private: true`) |

`shared` provides small utilities (typed plugin lookup, cookie parsing,
string case helpers, console log prefixes with `LOG_LEVEL` filtering,
memoization, and an auth-aware Databricks REST helper that resolves the
workspace client off the AppKit execution context) without pulling AppKit
types into every consumer. `sdk-shared` ships generated Zod schemas + inferred
types for the Databricks SDK shapes the workspace consumes (regenerated from
upstream `.d.ts` via `scripts/codegen.ts`). `genie-shared` is the pure wire
contract for Genie - widened `GenieMessage` / `GenieAttachment` schemas plus
a discriminated `GenieChatEvent` union for live streaming. `genie` is the
client-side driver: `genieChat` (raw poll-observed snapshots) and
`genieEventChat` (semantic deduplicated events), built on the workspace
client with cancellation, conversation seeding, and stale-id recovery.
`appkit-config` provides auto-configuration for AppKit apps: its `createApp`
is a drop-in for AppKit's own that resolves and applies each enabled
capability's environment before delegating. Today that means Lakebase
Postgres discovery (the `autopg()` helper, also callable standalone) - which
fills in every env var the AppKit `lakebase` plugin needs from whatever
fragments your deployment carries (resource paths, bare hostnames, Postgres
URIs) - gated on the `lakebase` plugin being present, with room to grow to
other capabilities.
`appkit-serving` is a tiny set of typed accessors over the
`/api/2.0/serving-endpoints` listing - `servingEndpoints()` plus
`foundationModel{Class,Profile,Version}` helpers that pull `model_class`,
the AI Gateway speed/quality/cost profile, and a derived semver out of
each endpoint, so callers can rank or filter Foundation Model endpoints
without re-implementing the parsing themselves. `appkit-mastra` is a beta
AppKit plugin that mounts Mastra
(`@mastra/express`; the client streams over the standard Mastra agent route
via `@mastra/client-js`), resolves the model from the
workspace host and `/serving-endpoints` with per-request user auth, reuses the
`lakebase` plugin pool for Mastra Memory when `storage` / `memory` are enabled,
forwards Genie streaming events through `ToolStream` for live UI feedback,
and renders inline Echarts visualizations via `[chart:<id>]` markers - the
chart-planner agent runs server-side per dataset and ships its `EChartsOption`
straight back through the writer, so the client never has to round-trip for
chart specs.
`appkit-mastra-shared` is the dependency-free wire-format contract (types +
schemas + the shared `MASTRA_ROUTES` segments + Genie writer-event vocabulary)
that the React client imports without dragging in `pg`, `fastembed`, or Mastra
itself.
`appkit-mastra-ui` is the React surface for the Mastra plugin, packaged like
`@databricks/appkit-ui`: a `./react` subpath plus a `./styles.css` entry,
styled entirely with AppKit semantic tokens so it inherits the host theme. It
ships a self-contained `MastraChat` drop-in (streaming, tool-session pills,
approvals, model picker, history pagination, chart/data embeds, and SQL
highlighting) that wires itself from the Mastra plugin config, plus the
controlled `ChatView` shell for callers that own message state themselves.

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
and how the client streams from the Mastra agent route under `/api/mastra`.

## Scaffold a new package

```bash
bun run create plugin <slug>   # AppKit plugin stub under packages/<slug>
bun run create shared <slug>   # types-only package stub
```

## Release

Publishable packages under `@dbx-tools/*` are configured as `fixed` in
[`.changeset/config.json`](.changeset/config.json), so they version together.
Releases are **tag-driven**: pushing a `v<version>` tag to `origin` fires the
[release workflow](.github/workflows/release.yml), which builds every
publishable workspace and runs `scripts/release.ts` against npm. No PR-based
versioning bot, no auto-publish on push to `main` - the tag push is the
deliberate signal that this commit ships.

### Per-release flow

```bash
# Working tree must be clean and HEAD pushed to origin. Then:
bun run tag                # patch bump (default)
bun run tag minor          # minor bump
bun run tag major          # major bump
bun run tag --dry-run      # preview without writing or pushing
```

`scripts/tag.ts` bumps the version in every publishable `packages/*/package.json`
(they're fixed, so they always bump together), commits the bump as
`chore: release v<version>`, pushes the commit, then creates and pushes the
`v<version>` tag.

The script also prepares an AI-ready prompt (commit log + diff stat since the
previous tag) and hands the whole context to a `releaseNotes()` hook inside
`scripts/tag.ts`. Plug in whatever model you want (Cursor CLI, OpenAI, Claude,
local, ...). Return a string to use as the annotated tag's message body, or
`null` to fall back to a bare `Release v<version>` message. The hook is a no-op
stub by default; if it throws, the script logs the error and falls back.

The tag push triggers the workflow. Build + publish typically takes ~2 minutes
on `ubuntu-latest`.

### What the publish step does

`scripts/release.ts` keeps the on-disk source tree read-only and instead
**stages** each package into `packages/<slug>/.npm-publish/` (gitignored).
For every publishable workspace it:

1. Asks npm whether the current `name@version` is already on the registry.
   If so, it skips (so re-running the script after a partial failure is
   safe and never trips `EPUBLISHCONFLICT`).
2. Creates a fresh `.npm-publish/` directory inside the package.
3. Copies everything listed in `files` (defaulting to `dist`, `index.ts`,
   `src`) from the package root into the stage.
4. Writes the augmented `package.json` into the stage. Augmentation
   grafts on the npm-ready fields - `main`, `types`, `exports`, `files`,
   `license`, `repository` (with per-package `directory`), `homepage`,
   `bugs`, `publishConfig` - and rewrites every `workspace:*` and
   `catalog:` specifier to a real version range (npm doesn't understand
   either protocol).
5. Runs `npm publish` from inside the stage.
6. Removes the stage in a `finally`.

Because the source tree's `package.json` files are never mutated, a crash,
Ctrl-C, or a `git add -A` from another process can't wedge the workspace.
The worst-case recovery is `rm -rf packages/*/.npm-publish` (and even that
isn't needed - the next run wipes the directory before reusing it).

`bun scripts/release.ts --dry-run` runs the same flow but swaps `npm
publish` for `npm pack --dry-run`, so you can inspect exactly what would
ship without touching the registry.

### Auth

The workflow reads `NPM_TOKEN` from a repository secret (npm Automation token
with publish access to the `@dbx-tools` scope). After the very first publish
of each package on npm, you can configure **trusted publishing** per package
(`npmjs.com → @dbx-tools/<pkg> → Settings → Trusted Publishing → GitHub
Actions → workflow `release.yml`, repo `reggie-db/dbx-tools-js``) and then
drop the `NODE_AUTH_TOKEN:` env line from the workflow - `id-token: write` is
already granted, and npm CLI 11.5.1+ on the runner (pinned via `node-version:
24.x` in the workflow) will negotiate the OIDC publish token automatically.
For maximum security, follow up with `Settings → Publishing access → Require
2FA and disallow tokens` to lock out any future leaked token.

### Manual ad-hoc publish

You can run the same publish flow locally - useful for one-off republishes or
debugging the augmentation:

```bash
# Inspect the staged tarballs without uploading anything.
bun scripts/build.ts
bun scripts/release.ts --dry-run

# For real (auth: ~/.npmrc needs //registry.npmjs.org/:_authToken=npm_xxx)
bun run release            # bun scripts/build.ts && bun scripts/release.ts
```

## License

Apache-2.0
