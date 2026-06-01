#!/usr/bin/env bun
// Wipe every workspace's `node_modules/` and the root bun lockfile so
// the next `bun install` builds the dependency graph from scratch.
// Useful when a stale hoisted dep or partial install is causing weird
// resolution errors that `bun install` alone won't fix.
//
// Run from the monorepo root via `bun run clean`.

import { rmSync } from "node:fs";
import { globSync } from "tinyglobby";
import { ROOT } from "./util.js";

const targets = globSync(
  ["**/node_modules", "bun.lock", "bun.lockb"],
  {
    cwd: ROOT,
    absolute: true,
    onlyFiles: false,
    // Don't recurse into node_modules looking for nested node_modules
    // dirs; the outer match captures the whole tree to delete.
    ignore: ["**/node_modules/**/node_modules"],
  },
);

if (targets.length === 0) {
  console.log("Nothing to clean.");
  process.exit(0);
}

for (const target of targets) {
  rmSync(target, { recursive: true, force: true });
  console.log(`Removed ${target}`);
}
