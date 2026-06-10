# Changesets

This directory holds [changesets](https://github.com/changesets/changesets) for
this monorepo. The CI workflow at `.github/workflows/release.yml` opens (and
later merges) a "Version Packages" PR when changesets land on `main`, then
publishes the bumped packages to npm.

## Authoring a release

```bash
bun changeset
```

Pick the packages that changed and the bump level (patch/minor/major). Commit
the generated markdown file alongside your code change. Every publishable
package under the `@dbx-tools/*` scope is configured as `fixed` in
`config.json`, so they always bump together regardless of which one you
selected. The `demo` package is private and never publishes.

The canonical "main" version of the monorepo lives on the publishable
`@dbx-tools/*` packages themselves (they bump together as a `fixed` group).
The root `package.json` carries no `version` field - there's nothing to keep
in sync. Newly scaffolded packages (`bun run create plugin <slug>`) read the
current group version straight off the published packages, so they start
already in lockstep with the rest of the workspace.

## Skipping the prompt

`bun changeset add --empty` records that a commit is intentionally release-
neutral. Useful for docs-only PRs.
