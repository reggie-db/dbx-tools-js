// scripts/typecheck.ts

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

interface PackageJson {
  workspaces?: string[];
}

const packageJson = JSON.parse(
  fs.readFileSync(path.resolve("package.json"), "utf8"),
) as PackageJson;

const workspaces: string[] = packageJson.workspaces ?? [];

console.log(`Found ${workspaces.length} workspace patterns`);
console.log(workspaces);

function findTsconfigs(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith("tsconfig") &&
        entry.name.endsWith(".json"),
    )
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

function expandWorkspace(pattern: string): string[] {
  if (!pattern.includes("*")) {
    const tsconfigs = findTsconfigs(pattern);

    console.log(
      `[workspace] ${pattern} ${
        tsconfigs.length ? `(${tsconfigs.length} tsconfig(s))` : "(no tsconfigs)"
      }`,
    );

    return tsconfigs;
  }

  const starIndex = pattern.indexOf("*");
  const base = pattern.substring(0, starIndex - 1);

  console.log(`[workspace] Expanding ${pattern}`);

  if (!fs.existsSync(base)) {
    console.warn(`[workspace] Directory not found: ${base}`);
    return [];
  }

  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const dir = path.join(base, entry.name);
      const tsconfigs = findTsconfigs(dir);

      console.log(
        `  ${dir} ${
          tsconfigs.length ? `(${tsconfigs.length} tsconfig(s))` : "(skipped)"
        }`,
      );

      return tsconfigs;
    });
}

const configs: string[] = workspaces.flatMap(expandWorkspace);

console.log("\nConfigs to typecheck:");

for (const config of configs) {
  console.log(`  - ${config}`);
}

if (configs.length === 0) {
  console.warn("\nNo tsconfig files found.");
  process.exit(0);
}

const failures: string[] = [];

for (const config of configs) {
  console.log(`\n=== Typechecking ${config} ===`);

  const result = spawnSync(
    process.platform === "win32" ? "bunx.cmd" : "bunx",
    ["tsc", "--noEmit", "-p", config],
    {
      stdio: "inherit",
    },
  );

  if (result.status !== 0) {
    failures.push(config);
    console.error(`✗ Failed: ${config}`);
  } else {
    console.log(`✓ Passed: ${config}`);
  }
}

console.log("\n=== Summary ===");

if (failures.length === 0) {
  console.log(`✓ All ${configs.length} tsconfig(s) passed`);
  process.exit(0);
}

console.error(`✗ ${failures.length} of ${configs.length} failed:\n`);

for (const config of failures) {
  console.error(`  - ${config}`);
}

process.exit(1);
