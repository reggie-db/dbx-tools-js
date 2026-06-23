# dbx-tools-js

> **Prerequisite:** This repo is [Bun](https://bun.sh)-only. Install it
> first (`curl -fsSL https://bun.sh/install | bash`); every command below -
> install, build, test, scaffold, release - runs through Bun.

A set of `@dbx-tools/*` add-ons for [AppKit](https://github.com/databricks/appkit),
the framework for building Databricks Apps. AppKit gives you the app
shell, auth, and the core Databricks plugins; these packages fill in the
higher-level pieces you'd otherwise hand-roll on top of it.

## Why use these with AppKit

AppKit already handles OAuth, the workspace client, and the stock
Databricks plugins. What it doesn't ship is the opinionated glue for the
common app shapes - an agent with durable memory, Genie streaming, model
selection, a local LLM gateway, approval-gated side effects. That glue is
what lives here, each piece a drop-in plugin, driver, or UI component
that follows AppKit's own conventions (kebab-case plugins, `create*`
factories, browser-safe wire contracts).

What it simplifies, by use case:

- **Ship a chat agent inside a Databricks App.** `appkit-mastra` mounts
  a [Mastra](https://mastra.ai) agent as an AppKit plugin with a
  streaming chat route and Lakebase-backed conversation memory;
  `appkit-mastra-ui` is the matching drop-in React chat component. No
  bespoke SSE wiring, no manual Postgres session store.
- **Add Genie (natural-language-to-SQL) to an app.** `genie` streams
  Genie space conversations as semantic events; `genie-shared` is the
  browser-safe wire contract the UI types against.
- **Let users name a model loosely.** `model` resolves `"claude sonnet"`
  to a real serving endpoint, ranks endpoints by capability class, and
  falls back sanely offline - so app config and agents aren't pinned to
  brittle endpoint ids.
- **Use Databricks LLMs from any OpenAI tool.** `model-proxy` runs a
  local, OpenAI-compatible proxy in front of Model Serving; point iTerm,
  an editor, the `openai` SDK, or `curl` at a loopback URL and get fuzzy
  model names + fresh-token auth for free.
- **Gate outbound side effects on human approval.** `appkit-email` is an
  approval-gated Mastra tool: a model drafts an email, but nothing sends
  until a human clicks **Approve** in the chat UI (`appkit-email-ui`).
- **Skip Lakebase boilerplate.** `appkit-config` wraps `createApp` and
  auto-configures capabilities (e.g. `autopg()` for the Lakebase Postgres
  env) before delegating to AppKit.

## Packages

Most features ship as a small family: the implementation, plus an
optional **`shared`** sibling (the dependency-free, browser-safe wire
contract - pure types + zod, so a server plugin, a Mastra tool, and a
React component all validate the same payload) and a **`ui`** sibling
(the React presentation layer, built on AppKit's component tokens). The
table lists each primary package with its `shared` / `ui` siblings
linked alongside; every package's own README covers its usage in depth.

| Package | Role |
| --- | --- |
| [`@dbx-tools/shared`](packages/shared) | Plugin lookup, cookies, strings, logger, memoize, auth-aware REST helper. Browser-safe surface via `index.client.ts`. |
| [`@dbx-tools/sdk-shared`](packages/sdk-shared) | Zod schemas generated from the Databricks SDK `.d.ts` types. |
| [`@dbx-tools/genie`](packages/genie) · [shared](packages/genie-shared) | Genie streaming drivers: `genieChat` (raw) + `genieEventChat` (semantic events). |
| [`@dbx-tools/model`](packages/model) · [shared](packages/model-shared) | Workspace-aware model selection: fuzzy name resolution + capability-class ranking. |
| [`@dbx-tools/model-proxy`](packages/model-proxy) | Local OpenAI-compatible proxy in front of Databricks Model Serving (ships a CLI). |
| [`@dbx-tools/appkit-config`](packages/appkit-config) | `createApp` wrapper that auto-configures capabilities (e.g. `autopg()` Lakebase env). |
| [`@dbx-tools/appkit-mastra`](packages/appkit-mastra) · [shared](packages/appkit-mastra-shared) · [ui](packages/appkit-mastra-ui) | AppKit plugin mounting Mastra agents + a chat route + Lakebase memory; drop-in React chat UI. |
| [`@dbx-tools/appkit-email`](packages/appkit-email) · [shared](packages/appkit-email-shared) · [ui](packages/appkit-email-ui) | AppKit plugin + approval-gated `send_email` Mastra tool (SMTP, OBO sender); Approve / Deny card UI. |
| [`@dbx-tools/devkit`](packages/devkit) | The `devkit` build/scaffold/release toolkit (the `bun run build` / `tag` / `release` commands). Reusable as a dev dependency in other Bun monorepos. |
| [`@dbx-tools/appkit-demo`](demo) | Private, runnable Databricks App that wires everything together. |

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
bun run create --plugin <slug>   # AppKit plugin stub under packages/appkit-<slug>
bun run create --shared <slug>   # browser-safe types-only package stub
bun run create <slug>            # standard package stub
```

## Release

Publishable packages under `@dbx-tools/*` are configured as `fixed` in
[`.changeset/config.json`](.changeset/config.json), so they version together.
Releases are **tag-driven**: pushing a `v<version>` tag to `origin` fires the
[release workflow](.github/workflows/release.yml), which builds every
publishable workspace and runs `devkit release` against npm. No PR-based
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

`devkit tag` bumps the version in every publishable `packages/*/package.json`
(they're fixed, so they always bump together), commits the bump as
`chore: release v<version>`, pushes the commit, then creates and pushes the
`v<version>` tag.

For the tag message it assembles the commit log + working-tree diff since
the previous tag and runs it through the Mastra script agent
(in [`@dbx-tools/devkit`](packages/devkit)) to generate markdown
release notes; the agent can
open touched files to fill gaps. If no model/Databricks profile resolves
(or the hook throws) it falls back to a bare `Release v<version>` message.
After pushing the tag it also creates a GitHub Release (when `gh` is on
`PATH`) and publishes the tagged versions to the local registry. Pass
`--readme` to sync every package README with the source before the
release commit is built.

The tag push triggers the workflow. Build + publish typically takes ~2 minutes
on `ubuntu-latest`.

### What the publish step does

`devkit release` keeps the on-disk source tree read-only and instead
**stages** each package into `packages/<slug>/.publish/` (gitignored).
Packages publish in workspace dependency order. For every publishable
workspace it:

1. Asks the registry whether the current `name@version` already exists.
   If so, it skips (so re-running after a partial failure is safe and
   never trips `EPUBLISHCONFLICT`).
2. Creates a fresh `.publish/` directory inside the package.
3. Copies everything matched by the merged manifest's `files` glob, plus
   the conventional `README` / `LICENSE` / `CHANGELOG` / `NOTICE` files,
   into the stage.
4. Writes the merged `package.json` into the stage. The shape is
   `package.default.json` (low-priority template) < the package's own
   manifest < `package.enforced.json` (org-wide constants), with
   per-package `repository.directory` stamped in and every `workspace:*`
   and `catalog:` specifier rewritten to a real version range (npm
   understands neither).
5. Runs `npm publish` from inside the stage. (`npm`, not `bun`, because
   bun doesn't embed the README into the registry manifest, leaving an
   empty package page.)
6. Removes the stage in a `finally`.

Because the source tree's `package.json` files are never mutated, a crash,
Ctrl-C, or a `git add -A` from another process can't wedge the workspace.
The worst-case recovery is `rm -rf packages/*/.publish` (and even that
isn't needed - the next run wipes the directory before reusing it).

The default registry is a local Verdaccio (`http://localhost:4873`) so a
stray `bun run release` can't hit public npm; override with `--registry`
or `NPM_REGISTRY` (CI sets it to the public registry). `bun run release
--dry-run` runs the same flow but swaps `npm publish` for `bun pm pack
--dry-run`, so you can inspect exactly what would ship without touching
any registry.

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
debugging the staged manifest. `bun run release` builds first, then publishes.

```bash
# Inspect the staged tarballs without uploading anything.
bun run release --dry-run

# Publish to the local Verdaccio (default; no npm login needed).
bun run release

# Publish to public npm (auth: ~/.npmrc needs
# //registry.npmjs.org/:_authToken=npm_xxx).
bun run release --registry https://registry.npmjs.org
```

## License

Apache-2.0
