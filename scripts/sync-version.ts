#!/usr/bin/env bun
// Mirror the canonical workspace version into the root `package.json`.
//
// Source of truth: the `fixed` group in `.changeset/config.json`
// (currently every `@dbx-tools/*` package). Changesets bumps every
// member of that group to the same version on `changeset version`, so
// we can read any one of them to find "the current main version".
//
// The root `package.json` is private and never publishes, so the
// version field there is purely a label - "this is what the project
// is on right now". Two consumers read it:
//
//   - `scripts/create.ts` stamps it on newly scaffolded packages so a
//     fresh `@dbx-tools/<foo>` starts on the current main version
//     instead of an arbitrary `0.1.0`.
//   - Humans, browsing the root manifest, see the same number they'd
//     see on npm.
//
// This script is wired into the root `version` npm script
// (`changeset version && bun scripts/sync-version.ts`), so the root
// auto-tracks whatever changesets just emitted. It can also be run
// standalone (`bun run sync-version`) to reconcile drift after a
// manual edit.

import { resolve } from "node:path";
import { discoverPackages, fail, ROOT, writeJson } from "./util.js";

const SCOPE_PREFIX = "@dbx-tools/";

const rootJsonPath = resolve(ROOT, "package.json");
const rootMeta = (await Bun.file(rootJsonPath).json()) as {
  version?: string;
  [key: string]: unknown;
};

const packages = (await discoverPackages()).filter((pkg) =>
  pkg.meta.name?.startsWith(SCOPE_PREFIX),
);

if (packages.length === 0) {
  fail(`no \`${SCOPE_PREFIX}*\` packages found - nothing to sync against`);
}

const versions = new Map<string, string[]>();
for (const pkg of packages) {
  const v = pkg.meta.version;
  if (!v) {
    fail(`${pkg.meta.name ?? pkg.slug} has no \`version\` field`);
  }
  const bucket = versions.get(v) ?? [];
  bucket.push(pkg.meta.name ?? pkg.slug);
  versions.set(v, bucket);
}

if (versions.size > 1) {
  const summary = [...versions.entries()]
    .map(([v, names]) => `  ${v}: ${names.join(", ")}`)
    .join("\n");
  fail(
    `fixed-group versions diverged - changesets \`fixed\` should keep them in lockstep:\n${summary}`,
  );
}

const [canonical] = [...versions.keys()];
if (!canonical) fail("could not resolve canonical version");

if (rootMeta.version === canonical) {
  console.log(`root already at ${canonical} - nothing to do`);
  process.exit(0);
}

const previous = rootMeta.version ?? "(unset)";
rootMeta.version = canonical;
await writeJson(rootJsonPath, rootMeta);
console.log(`root version: ${previous} -> ${canonical}`);
