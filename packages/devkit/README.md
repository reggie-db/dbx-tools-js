# @dbx-tools/devkit

Build, scaffold, and release toolkit for Bun + workspaces monorepos.
It powers this repo's `bun run build` / `typecheck` / `format` /
`codegen` / `verify` / `create` / `readme` / `tag` / `release` scripts,
and is published so other Bun monorepos can reuse the same tooling as a
single dev dependency instead of copying a `scripts/` folder.

The toolkit is built on [pacwich](https://pacwich.dev) for workspace
discovery and script orchestration, and runs on Bun (its bin ships as
TypeScript with a `#!/usr/bin/env bun` shebang, no build step).

## Installation

```bash
bun add -d @dbx-tools/devkit
```

Then point your root `package.json` scripts at the `devkit` bin:

```jsonc
{
  "scripts": {
    "build": "devkit build",
    "typecheck": "devkit typecheck",
    "format": "devkit format",
    "codegen": "devkit codegen",
    "verify": "devkit verify",
    "create": "devkit create",
    "readme": "devkit readme",
    "tag": "devkit tag",
    "release": "devkit release"
  }
}
```

## Commands

| Command | What it does |
| --- | --- |
| `devkit build` | Gate (codegen, format, typecheck, verify, prune unused devDeps) then compile every publishable package in dependency order. |
| `devkit typecheck` | Sync the root tsconfig `references` to the live package set, then `tsc --noEmit`. |
| `devkit format` | `syncpack format`, regroup npm lifecycle hooks, then `prettier --write`. |
| `devkit codegen` | Regenerate each package's `generated/` zod tree from the `.d.ts` inputs its `package.json` declares. |
| `devkit verify` | Fail on imports of sibling packages not declared as dependencies. |
| `devkit clean` | Wipe `dist/` + stale `tsbuildinfo` across the workspace. |
| `devkit create [--plugin\|--shared] <slug>` | Scaffold a new package under `packages/<slug>/`. |
| `devkit readme [--upgrade] [--package <name>]` | Generate/refresh package READMEs via the script agent. |
| `devkit tag [patch\|minor\|major]` | Version bump, commit, tag, push, GitHub Release, local publish. |
| `devkit release` | Build then publish every public package (defaults to local Verdaccio). |

## Configuration

Configuration is optional. Everything is auto-derived from the
workspace; the only knobs live under a `devkit` key in the root
`package.json`:

```jsonc
{
  "devkit": {
    "scope": "@acme",       // npm scope used by `create` (default: most common scope in the workspace)
    "repo": "acme/widgets"  // owner/name for release links (default: the `origin` git remote)
  }
}
```

The release-shaping templates `package.default.json` (low-priority
defaults) and `package.enforced.json` (forced fields) at the repo root,
and each package's optional `codegen.inputs` field, are read by
convention. The AI agent behind `readme` / `tag` is enabled by setting
`SCRIPT_MODEL_PROVIDER` to a `provider/model` spec (`databricks/...`,
`ollama/...`, or any Mastra-routed provider); without it those commands
fall back gracefully.

## Library API

The same commands are exported as functions for projects that want to
compose their own automation:

```ts
import { build, release, tag } from "@dbx-tools/devkit";

await build();
await release({ registry: "http://localhost:4873", dryRun: true });
```

Also exported: `syncReadmes`, `codegen`, `typecheck`, `format`,
`verify`, `clean`, `create`, plus the workspace helpers
(`discoverPackages`, `orderByDependencies`, `writeJson`, `getProject`,
`sh`, `git`, `agentQuery`, ...).

## License

Apache-2.0
