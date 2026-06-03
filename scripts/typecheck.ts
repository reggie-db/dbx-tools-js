#!/usr/bin/env bun
// Typecheck every workspace by running `tsc --noEmit` against each
// `tsconfig*.json` file found inside a workspace directory. Walks the
// `workspaces` glob patterns from the root `package.json`, expands them
// with tinyglobby, then runs one `tsc` invocation per tsconfig.
//
// Stops on first failure of an individual config but still reports a
// summary at the end with which ones passed and failed.

import path, { resolve } from "node:path";
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
  .sort()
  .map((config) => path.relative(ROOT, config));

if (configs.length === 0) {
  console.warn("No tsconfig files found.");
  process.exit(0);
}

console.log(`Typechecking ${configs.length} config(s):`);
for (const config of configs) console.log(`  - ${config}`);
console.log();

const tscPromises = [];
for (const config of configs) {
  const tscPromise = bunx(["tsc", "--noEmit", "-p", config])
    .then(() => {
      console.log(`✓ Passed: ${config}`);
    })
    .catch((e) => {
      console.error(`✗ Failed: ${config}`);
      throw e;
    });
  tscPromises.push(tscPromise);
}

const results = await Promise.allSettled(tscPromises);

const failures = results
  .map((result, i) => ({ config: configs[i], result }))
  .filter(({ result }) => result.status === "rejected");
console.log("=== Summary ===");
if (failures.length === 0) {
  console.log(`✓ All ${configs.length} tsconfig(s) passed`);
  process.exit(0);
}

console.error(`✗ ${failures.length} of ${configs.length} failed:`);
for (const config of failures) console.error(`  - ${config}`);
process.exit(1);
