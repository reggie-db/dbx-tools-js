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

| Package                                                                                                                          | Role                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@dbx-tools/shared`](packages/shared)                                                                                           | Plugin lookup, cookies, strings, logger, memoize, auth-aware REST helper. Browser-safe surface via `index.client.ts`.                                |
| [`@dbx-tools/sdk-shared`](packages/sdk-shared)                                                                                   | Zod schemas generated from the Databricks SDK `.d.ts` types.                                                                                         |
| [`@dbx-tools/genie`](packages/genie) · [shared](packages/genie-shared)                                                           | Genie streaming drivers: `genieChat` (raw) + `genieEventChat` (semantic events).                                                                     |
| [`@dbx-tools/model`](packages/model) · [shared](packages/model-shared)                                                           | Workspace-aware model selection: fuzzy name resolution + capability-class ranking.                                                                   |
| [`@dbx-tools/model-proxy`](packages/model-proxy)                                                                                 | Local OpenAI-compatible proxy in front of Databricks Model Serving (ships a CLI).                                                                    |
| [`@dbx-tools/appkit-config`](packages/appkit-config)                                                                             | `createApp` wrapper that auto-configures capabilities (e.g. `autopg()` Lakebase env).                                                                |
| [`@dbx-tools/appkit-mastra`](packages/appkit-mastra) · [shared](packages/appkit-mastra-shared) · [ui](packages/appkit-mastra-ui) | AppKit plugin mounting Mastra agents + a chat route + Lakebase memory; drop-in React chat UI.                                                        |
| [`@dbx-tools/appkit-email`](packages/appkit-email) · [shared](packages/appkit-email-shared) · [ui](packages/appkit-email-ui)     | AppKit plugin + approval-gated `send_email` Mastra tool (SMTP, OBO sender); Approve / Deny card UI.                                                  |
| [`@dbx-tools/devkit`](packages/devkit)                                                                                           | The `devkit` build/scaffold/release toolkit (the `bun run build` / `tag` / `release` commands). Reusable as a dev dependency in other Bun monorepos. |
| [`@dbx-tools/appkit-demo`](demo)                                                                                                 | Private, runnable Databricks App that wires everything together.                                                                                     |

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
publishable workspace and publishes with Bun. No PR-based versioning bot, no
auto-publish on push to `main` - the tag push is the deliberate signal that
this commit ships.

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
`v<version>` tag with a `Release v<version>` message. After pushing the tag it
also creates a GitHub Release (when `gh` is on `PATH`).

The tag push triggers the workflow. Build + publish typically takes ~2 minutes
on `ubuntu-latest`.

### Build and publish shape

Every publishable package owns its shipped `main`, `types`, `exports`, and
`files` fields directly in `packages/<slug>/package.json`. The `source` export
condition keeps editor/typecheck resolution pointed at raw `.ts` sources, while
`types` and `default` point at the bundled artifacts in `packages/<slug>/dist/`.

`bun run build` fans out with `bun run --filter='./packages/*' build`; each
package runs the shared [`tsdown.config.ts`](tsdown.config.ts), which emits ESM
JavaScript and `.d.ts` files. There is no publish-time manifest merge,
`.publish/` staging directory, `package.default.json`, or `package.enforced.json`.

### Auth

The workflow reads `NPM_TOKEN` from a repository secret (npm Automation token
with publish access to the `@dbx-tools` scope). After the very first publish
of each package on npm, you can configure **trusted publishing** per package
(`npmjs.com → @dbx-tools/<pkg> → Settings → Trusted Publishing → GitHub
Actions → workflow `release.yml`, repo `reggie-db/dbx-tools-js``) and then
drop the `NODE_AUTH_TOKEN:`env line from the workflow -`id-token: write`is
already granted, and npm CLI 11.5.1+ on the runner (pinned via`node-version:
24.x`in the workflow) will negotiate the OIDC publish token automatically.
For maximum security, follow up with`Settings → Publishing access → Require
2FA and disallow tokens` to lock out any future leaked token.

### Manual ad-hoc publish

You can run the same publish flow locally - useful for one-off republishes or
debugging the package tarballs. `bun run release` builds first, then publishes.

```bash
# Inspect tarballs without uploading anything.
bun run publish:dry-run

# Publish all publishable packages with Bun.
bun run release

# Publish to a specific registry.
NPM_CONFIG_REGISTRY=https://registry.npmjs.org bun run release
```

## License

Apache-2.0
