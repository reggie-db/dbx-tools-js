# scripts/

Workspace tooling for the `dbx-tools-js` monorepo: build, typecheck,
format, codegen, verify, scaffold, and the tag/release pipeline. Every
script is a standalone Bun TypeScript file wired to a root `package.json`
script (`bun run <name>`), and they share a small set of helper modules
rather than re-implementing workspace walking, subprocess handling, or
git plumbing.

This directory is **not** a workspace package - it has no `package.json`,
only a `jsconfig.json` so editors typecheck it with the repo's `node` +
`bun` types.

## Entry points

Each of these maps to a `bun run <name>` script at the repo root.

| Command | File | What it does |
| --- | --- | --- |
| `bun run build` | `build.ts` | Gate (codegen, format, typecheck, verify, prune unused devDeps) then compile every publishable package in dependency order. |
| `bun run typecheck` | `typecheck.ts` | Sync the root tsconfig `references` to the live package set, then `tsc --noEmit`. |
| `bun run format` | `format.ts` | `syncpack format`, regroup npm lifecycle hooks, then `prettier --write`. |
| `bun run codegen` | `codegen.ts` | Regenerate each package's `generated/` zod tree from the `.d.ts` inputs its `package.json` declares. |
| `bun run verify` | `verify.ts` | Fail on imports of sibling packages not declared as dependencies. |
| `bun run clean` | `clean.ts` | Wipe `dist/` + stale `tsbuildinfo` across the workspace. |
| `bun run create [--plugin\|--shared] <slug>` | `create.ts` | Scaffold a new package under `packages/<slug>/`. |
| `bun run readme [--upgrade] [--package <name>]` | `readme.ts` | Generate/refresh package READMEs via the script agent. |
| `bun run tag [patch\|minor\|major]` | `tag.ts` | Version bump, commit, tag, push, GitHub Release, local publish. |
| `bun run release` | `release.ts` | Build then publish every public package (defaults to local Verdaccio). |

## Shared helpers

The entry points stay thin by leaning on these modules. Reach for them
before re-implementing the same plumbing in a new script.

- **`script.ts`** - script-running glue: `getScriptsDir`, `fail` (log +
  non-zero exit), `errorMessage` (narrow an unknown throw), `nonEmptyLines`
  (split/trim/drop-blanks), and `runScript` (run a script across the
  workspaces via pacwich, streaming each workspace's output under its tag).
- **`project.ts`** - `getProject`, the memoized pacwich `FileSystemProject`
  every other module discovers workspaces through.
- **`package.ts`** - workspace package discovery and manifest editing:
  `discoverPackages`, `discoverPackageJsons`, `orderByDependencies`,
  `toAbsolute` / `toRelative`, `writeJson` (newline-preserving), and the
  `WorkspacePackage` class.
- **`shell.ts`** - subprocess runner over Bun's `$`: `sh` (capture +
  trim + exit-code handling), `bunx`, `bunRun`.
- **`git.ts`** - `git(args)`, a quiet-by-default wrapper over `sh`.
- **`agent.ts`** - the Mastra script agent (file-reading / git / sandboxed
  TS tools) used by `readme.ts` and `tag.ts` for AI-written READMEs and
  release notes. Degrades to `null` when no model/Databricks profile is
  available, so callers fall back rather than fail.

## Conventions

- Always `await sh(...)` / `bunx(...)` / `bunRun(...)` from `shell.ts`
  instead of spawning subprocesses directly.
- Discover packages with `discoverPackages()` / `discoverPackageJsons()`
  rather than re-walking the tree; write manifests with `writeJson()` to
  keep the trailing newline and avoid format churn.
- Bespoke logic that has no good off-the-shelf fit (knip JSON parsing in
  `build.ts`, the tsconfig reference sync in `typecheck.ts`, the
  `workspace:`/`catalog:` specifier resolution in `release.ts`) is kept
  local on purpose; it is too repo-specific for a library.

See [`.cursor/rules/scripts-conventions.mdc`](../.cursor/rules/scripts-conventions.mdc)
for the full convention set.
