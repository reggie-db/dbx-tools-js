// scripts/typecheck.js

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));

const workspaces = packageJson.workspaces ?? [];

console.log(`Found ${workspaces.length} workspace patterns`);
console.log(workspaces);

function expandWorkspace(pattern) {
  if (!pattern.includes("*")) {
    const exists = fs.existsSync(pattern);
    console.log(`[workspace] ${pattern} ${exists ? "(found)" : "(missing)"}`);
    return exists ? [pattern] : [];
  }

  const base = pattern.slice(0, pattern.indexOf("*") - 1);

  console.log(`[workspace] Expanding ${pattern}`);

  if (!fs.existsSync(base)) {
    console.warn(`[workspace] Directory not found: ${base}`);
    return [];
  }

  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(base, d.name))
    .filter((dir) => {
      const hasTsconfig = fs.existsSync(path.join(dir, "tsconfig.json"));

      console.log(`  ${dir} ${hasTsconfig ? "(tsconfig found)" : "(skipped)"}`);

      return hasTsconfig;
    });
}

const projects = workspaces.flatMap(expandWorkspace);

console.log("\nProjects to typecheck:");
for (const project of projects) {
  console.log(`  - ${project}`);
}

console.log("");

for (const project of projects) {
  console.log(`\n=== Typechecking ${project} ===`);

  const result = spawnSync(
    process.platform === "win32" ? "bunx.cmd" : "bunx",
    ["tsc", "--noEmit", "-p", project],
    { stdio: "inherit" },
  );

  if (result.status !== 0) {
    console.error(`\n✗ Typecheck failed: ${project}`);
    process.exit(result.status ?? 1);
  }

  console.log(`✓ Passed: ${project}`);
}

console.log(`\n✓ All ${projects.length} projects passed`);
