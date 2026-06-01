#!/usr/bin/env bun
// Typecheck every workspace by running `tsc --noEmit` against each
// `tsconfig*.json` file found inside a workspace directory. Walks the
// `workspaces` glob patterns from the root `package.json`, expands them
// with tinyglobby, then runs one `tsc` invocation per tsconfig.
//
// Stops on first failure of an individual config but still reports a
// summary at the end with which ones passed and failed.

import { resolve } from "node:path";
import { globSync } from "tinyglobby";
import { bunx, readJson, ROOT } from "./util.js";

interface RootPackageJson {
  workspaces?: string[];
}

const { workspaces = [] } = readJson<RootPackageJson>(resolve(ROOT, "package.json"));

console.log(`Found ${workspaces.length} workspace pattern(s):`);
for (const pattern of workspaces) console.log(`  ${pattern}`);
console.log();

// For each workspace dir, find every `tsconfig*.json` at its top level.
// `tinyglobby` handles both `packages/*` (glob) and `demo` (literal).
const configs = workspaces
  .flatMap((pattern) =>
    globSync(`${pattern}/tsconfig*.json`, {
      cwd: ROOT,
      absolute: true,
      // Don't dive into nested tsconfigs from node_modules or dist.
      ignore: ["**/node_modules/**", "**/dist/**"],
    }),
  )
  .sort();

if (configs.length === 0) {
  console.warn("No tsconfig files found.");
  process.exit(0);
}

console.log(`Typechecking ${configs.length} config(s):`);
for (const config of configs) console.log(`  - ${config}`);
console.log();

const failures: string[] = [];
for (const config of configs) {
  console.log(`=== ${config} ===`);
  try {
    bunx(["tsc", "--noEmit", "-p", config]);
    console.log(`✓ Passed: ${config}\n`);
  } catch {
    failures.push(config);
    console.error(`✗ Failed: ${config}\n`);
  }
}

console.log("=== Summary ===");
if (failures.length === 0) {
  console.log(`✓ All ${configs.length} tsconfig(s) passed`);
  process.exit(0);
}

console.error(`✗ ${failures.length} of ${configs.length} failed:`);
for (const config of failures) console.error(`  - ${config}`);
process.exit(1);
