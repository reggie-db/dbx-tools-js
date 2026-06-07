#!/usr/bin/env bun
// Wipe every workspace's `node_modules/` and the root bun lockfile so
// the next `bun install` builds the dependency graph from scratch.
// Useful when a stale hoisted dep or partial install is causing weird
// resolution errors that `bun install` alone won't fix.
//
// Run from the monorepo root via `bun run clean`.

import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { discoverPackageJsons, ROOT } from "./util.js";
import { exists } from "node:fs/promises";

const targets: string[] = [];
for await (const jsonPath of discoverPackageJsons(true)) {
  for (const dirName of ["node_modules", "dist"]) {
    targets.push(resolve(dirname(jsonPath), dirName));
  }
}
for (const lockfile of ["bun.lock", "bun.lockb"]) {
  targets.push(resolve(ROOT, lockfile));
}

let removed = 0;
for (const target of targets) {
  if (!existsSync(target)) continue;
  rmSync(target, { recursive: true, force: true });
  console.log(`Removed ${target}`);
  removed++;
}

if (removed === 0) console.log("Nothing to clean.");
