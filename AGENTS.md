# AGENTS.md

Guidance for AI coding agents (Cursor, Claude Code, Codex, Cline, ...)
working in this repo. Cursor users get the same content as auto-loaded
rules under `.cursor/rules/`.

## Repo at a glance

Bun + TypeScript monorepo for `@dbx-tools/*` AppKit add-ons targeting
Databricks Apps. Eight publishable packages plus a runnable demo. See
the root [`README.md`](README.md) for the full package table.

```bash
bun install                 # from repo root
bun run typecheck           # workspace-wide tsc --noEmit
bun run build               # tsc per publishable package
bun test                    # bun test across all packages
bun run --filter '@dbx-tools/appkit-demo' dev   # run the demo
```

## Core conventions

### 1. Use shared helpers; don't reinvent

Three patterns recur enough that inlining them is treated as a code
smell. See [`.cursor/rules/dry-helpers.mdc`](.cursor/rules/dry-helpers.mdc).

- **Error messages**: `commonUtils.errorMessage(err)` instead of
  `err instanceof Error ? err.message : String(err)`.
- **`ctx.writer` publishing (appkit-mastra)**: import `safeWrite`
  from `./writer.js` and pass the module's tagged logger.
- **Sibling plugin lookup**: `appkitUtils.instance(ctx, factory)` or
  `appkitUtils.require(ctx, factory, callerName)`.

### 2. Docstrings document the current contract

No "no longer used", "previously did", "kept private for now", or
similar agent-speak. Tests are exempt for regression notes. See
[`.cursor/rules/docstring-style.mdc`](.cursor/rules/docstring-style.mdc).

### 3. Workspace scripts

- Always `await bunx(...)` and `await run(...)` from `scripts/util.ts`.
- Use `discoverPackages()` / `discoverPackageJsons()` instead of
  re-implementing the workspace walk.
- Use `writeJson()` instead of bare `Bun.write` for `package.json`
  edits (preserves trailing newline).
- See [`.cursor/rules/scripts-conventions.mdc`](.cursor/rules/scripts-conventions.mdc).

### 4. appkit-mastra specifics

Writer events are flat `{ type, ...fields }`; chart specs are held
off-band on `RequestContext` and referenced by `[chart:<id>]`
markers in model output. The plugin's Genie integration talks to
Genie directly via `@dbx-tools/genie`, not through AppKit's stock
`genie` plugin. See
[`.cursor/rules/appkit-mastra-patterns.mdc`](.cursor/rules/appkit-mastra-patterns.mdc).

## Releases

Tag-driven. `bun run tag` bumps every publishable package, commits
+ pushes, then creates and pushes the `v<version>` annotated tag.
Folds dirty files into the release commit. See
[`.cursor/rules/release-workflow.mdc`](.cursor/rules/release-workflow.mdc).

**Don't run `bun run tag`, `bun run release`, or any push command
without explicit user consent in the current message.**

## Where to find more

- Per-package READMEs under `packages/*/README.md`.
- Demo wiring + bundle deploy notes in [`demo/README.md`](demo/README.md).
- Generated AppKit / Mastra plugin docs:
  `npx @databricks/appkit docs --full`.
