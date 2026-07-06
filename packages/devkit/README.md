# @dbx-tools/devkit

Scaffold, formatting, codegen, verification, build, and release helpers for Bun +
workspaces monorepos. It wraps the shared `tsdown` config for building and a
Bun-based publish flow; `devkit` keeps only the workspace automation that is
orthogonal to writing package code.

## Installation

```bash
bun add -d @dbx-tools/devkit
```

Then point your root `package.json` scripts at the `devkit` bin for the helper
commands you want:

```jsonc
{
  "scripts": {
    "format": "devkit format",
    "build": "devkit build",
    "codegen": "devkit codegen",
    "verify": "devkit verify",
    "create": "devkit create",
    "release": "devkit release",
    "tag": "devkit tag",
  },
}
```

## Commands

| Command                                     | What it does                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `devkit format`                             | `syncpack format`, regroup lifecycle hooks, then `prettier --write`.                                 |
| `devkit build`                              | Compile every publishable package with the shared `tsdown` config.                                   |
| `devkit codegen`                            | Regenerate each package's `generated/` zod tree from the `.d.ts` inputs its `package.json` declares. |
| `devkit verify`                             | Fail on imports of sibling packages not declared as dependencies.                                    |
| `devkit create [--plugin\|--shared] <slug>` | Scaffold a new package under `packages/<slug>/`.                                                     |
| `devkit release [--dry-run]`                | Build, then publish each package with a stamped (complete) manifest.                                 |
| `devkit tag [patch\|minor\|major]`          | Version bump, commit, tag, push, and create a GitHub Release. `--notes-since v0.1.75` widens the notes baseline; default is the previous tag. `--no-ai-notes` skips Codex release notes. |
| `devkit agent [prompt]`                     | Run `ucode codex exec` (`-t` / `--timeout` seconds). Prompt via args or stdin. Requires `ucode codex --version`. |

Typecheck stays a plain `tsc` call:

```bash
tsc --noEmit -p tsconfig.json
```

## Configuration

Configuration is optional. Everything is auto-derived from the workspace; the
only knobs live under a `devkit` key in the root `package.json`:

```jsonc
{
  "devkit": {
    "scope": "@acme", // npm scope used by `create` (default: most common scope in the workspace)
    "repo": "acme/widgets", // owner/name for release links (default: the `origin` git remote)
  },
}
```

Each package's optional `codegen.inputs` field is read by convention.

## Library API

The same commands are exported as functions for projects that want to compose
their own automation:

```ts
import { build, codegen, create, release, tag, verify } from "@dbx-tools/devkit";

await build();
await codegen();
await verify();
await create({ slug: "example" });
await release({ dryRun: true });
await tag({ bump: "patch", publish: false });
```

Also exported: `format`, plus the workspace helpers
(`discoverPackages`, `discoverPackageJsons`, `writeJson`, `getProject`, `sh`,
`git`, ...).

## License

Apache-2.0
