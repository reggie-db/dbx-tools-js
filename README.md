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
| [`@dbx-tools/appkit-mastra`](packages/appkit-mastra)                       | `packages/appkit-mastra`        | yes                  |
| [`@dbx-tools/appkit-mastra-shared`](packages/appkit-mastra-shared)         | `packages/appkit-mastra-shared` | yes                  |
| [`@dbx-tools/appkit-mastra-ui`](packages/appkit-mastra-ui)                 | `packages/appkit-mastra-ui`     | yes                  |
| [`@dbx-tools/appkit-demo`](demo)                                           | `demo`                          | no (`private: true`) |

The lower-level packages (`shared`, `sdk-shared`, `genie-shared`,
`genie`) are browser-safe building blocks: shared utilities, generated
SDK Zod schemas, the Genie wire contract, and the server-side Genie chat
drivers. The `appkit-*` packages are the AppKit add-ons that build on
them: auto-configuration (`appkit-config`), a Mastra agent plugin
(`appkit-mastra`) with its browser-safe wire contract
(`appkit-mastra-shared`) and React chat UI (`appkit-mastra-ui`). Each
package's own README covers its purpose and usage in depth.

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
