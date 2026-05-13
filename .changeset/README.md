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
the generated markdown file alongside your code change. The three publishable
packages (`@dbx-tools/appkit-genie`, `@dbx-tools/appkit-genie-ui`,
`@dbx-tools/appkit-genie-shared`) are configured as `fixed` in
`config.json`, so they always bump together regardless of which one you
selected. The `demo` package is private and never publishes.

## Skipping the prompt

`bun changeset add --empty` records that a commit is intentionally release-
neutral. Useful for docs-only PRs.
