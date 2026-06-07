#!/usr/bin/env bun
// Blind-delete every `node_modules/` and `dist/` directory under the
// repo root, plus the root bun lockfile(s), so the next `bun install`
// + `bun run build` rebuild the dependency graph and artifacts from
// scratch. Useful when a stale hoisted dep or partial install is
// causing weird resolution errors that `bun install` alone won't
// fix.
//
// "Blind" because the walker doesn't consult the workspace list at
// all - it just descends from `ROOT`, prunes anything it's about to
// delete (so we don't recurse into a `node_modules/` to find more
// `node_modules/`), and skips `.git`. That way the script keeps
// working even when `bun.lock` is missing or workspaces have been
// reshuffled.
//
// Run from the monorepo root via `bun run clean`.

import { existsSync, readdirSync, rmSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { ROOT, toRelative } from "./util.js";

/** Directory names we wipe wherever we find them. */
const TARGET_NAMES = new Set(["node_modules", "dist"]);

/** Directory names we never descend into during the walk. */
const SKIP_NAMES = new Set([".git", ...TARGET_NAMES]);

/** Lockfiles at the repo root that the next `bun install` will recreate. */
const ROOT_LOCKFILES = ["bun.lock", "bun.lockb"];

/**
 * Recursively collect every directory matching `TARGET_NAMES` under
 * `dir`. Stops descending at any directory in `SKIP_NAMES` so we
 * don't waste time walking into a `node_modules` we're about to
 * delete.
 */
function collectTargets(dir: string, acc: string[]): void {
  let entries: Dirent<string>[];
  try {
    // `encoding: "utf8"` pins the string overload; without it the
    // type inference defaults to Buffer-flavored Dirent entries.
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = join(dir, entry.name);
    if (TARGET_NAMES.has(entry.name)) {
      acc.push(full);
      continue;
    }
    if (SKIP_NAMES.has(entry.name)) continue;
    collectTargets(full, acc);
  }
}

const targets: string[] = [];
collectTargets(ROOT, targets);
for (const lockfile of ROOT_LOCKFILES) targets.push(join(ROOT, lockfile));

let removed = 0;
for (const target of targets) {
  if (!existsSync(target)) continue;
  rmSync(target, { recursive: true, force: true });
  console.log(`Removed ${toRelative(target)}`);
  removed++;
}

if (removed === 0) console.log("Nothing to clean.");
