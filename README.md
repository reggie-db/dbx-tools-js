# dbx-tools-appkit

Bun workspace for the `@dbx-tools/appkit-*` plugins and a runnable demo.

| Package | Path | Published |
| --- | --- | --- |
| [`@dbx-tools/appkit-genie-shared`](packages/appkit-genie-shared) | `packages/appkit-genie-shared` | yes |
| [`@dbx-tools/appkit-genie`](packages/appkit-genie) | `packages/appkit-genie` | yes |
| [`@dbx-tools/appkit-genie-ui`](packages/appkit-genie-ui) | `packages/appkit-genie-ui` | yes |
| `@dbx-tools/appkit-demo` | `packages/appkit-demo` | no (private) |

`appkit-genie-shared` holds the wire-format types. `appkit-genie` is the server plugin
(Genie streaming tools + optional mem0-backed memory tools). `appkit-genie-ui` is the
React `<AgentChat>` component. Both the server and UI packages re-export the shared
types so apps only need to install the one they use.

## Develop

```bash
bun install
bun typecheck
bun run build
```

Run the demo against a real workspace:

```bash
cd packages/appkit-demo
cp .env.example .env  # fill in DATABRICKS_HOST + Genie space + serving endpoint
databricks auth login --host "$DATABRICKS_HOST"
bun dev               # or `bun dev` from the repo root
```

## Release

The three publishable packages are configured as `fixed` in
[`.changeset/config.json`](.changeset/config.json) so they always version
together. Adding a change:

```bash
bun changeset
# pick packages + bump level, write a one-liner summary
```

On push to `main`, the [release workflow](.github/workflows/release.yml)
opens (and on subsequent pushes merges + publishes) a "Version Packages" PR
that applies the bumps and runs `changeset publish` against npm. To enable
publishes, add an `NPM_TOKEN` repo secret with publish access to the
`@dbx-tools` scope.

## License

Apache-2.0
