#!/usr/bin/env bun
// Build pipeline for the publishable workspace packages, run via
// `bun run build`.
//
// A gate runs before anything is compiled:
//   - codegen: regenerate the SDK-derived zod schemas.
//   - format: syncpack + prettier across the workspace.
//   - typecheck: workspace-wide `tsc --noEmit` (its `pretypecheck` hook
//     re-syncs the root tsconfig references first).
//   - prune: drop every devDependency knip reports as unused from the
//     `package.json` that declared it (parses knip's JSON report
//     directly, no jq).
//
// Then each publishable package is compiled with
// `tsc -p tsconfig.build.json`, emitting `.js` + `.d.ts` into
// `packages/<pkg>/dist/`. Packages without a `tsconfig.build.json` or
// marked `"private": true` are skipped: private packages (e.g. the
// demo) aren't shipped to npm and have their own build pipelines.

import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  bunx,
  discoverPackages,
  execScript,
  fail,
  type PackageJson,
  toAbsolute,
  toRelative,
  type WorkspacePackage,
  writeJson,
} from "./util.js";

/**
 * Shape of the bits of knip's `--reporter json` output we consume. Each
 * issue is attributed to a file (a workspace `package.json` for
 * dependency issues); `devDependencies` lists the unused entries.
 */
interface KnipIssue {
  file: string;
  devDependencies?: ReadonlyArray<{ name: string }>;
}

interface KnipReport {
  issues?: ReadonlyArray<KnipIssue>;
}

/**
 * Run knip, parse its JSON report, and strip every devDependency it
 * flags as unused from the `package.json` that declared it. Deletes the
 * whole `devDependencies` block once it empties out (the repo keeps no
 * empty blocks). Returns the number of entries removed.
 */
async function pruneUnusedDevDependencies(): Promise<number> {
  // knip exits non-zero whenever it finds issues, so swallow the exit
  // code (`disableCheck`) and read the JSON it still writes to stdout.
  const stdout = await bunx(["knip", "--reporter", "json"], { disableCheck: true });
  if (!stdout) return 0;
  let report: KnipReport;
  try {
    report = JSON.parse(stdout) as KnipReport;
  } catch {
    throw new Error(`knip did not emit valid JSON:\n${stdout}`);
  }

  // Collapse the report into { package.json path -> unused devDep names }.
  const unusedByFile = new Map<string, Set<string>>();
  for (const issue of report.issues ?? []) {
    const names = (issue.devDependencies ?? []).map((dep) => dep.name);
    if (names.length === 0) continue;
    const jsonPath = toAbsolute(issue.file);
    const existing = unusedByFile.get(jsonPath) ?? new Set<string>();
    for (const name of names) existing.add(name);
    unusedByFile.set(jsonPath, existing);
  }

  let removed = 0;
  for (const [jsonPath, names] of unusedByFile) {
    const meta = (await Bun.file(jsonPath).json()) as PackageJson;
    const devDeps = meta.devDependencies as Record<string, string> | undefined;
    if (!devDeps) continue;
    const dropped = [...names].filter((name) => {
      if (!(name in devDeps)) return false;
      delete devDeps[name];
      return true;
    });
    if (dropped.length === 0) continue;
    if (Object.keys(devDeps).length === 0) delete meta.devDependencies;
    await writeJson(jsonPath, meta);
    removed += dropped.length;
    console.log(`pruned ${dropped.sort().join(", ")} from ${toRelative(jsonPath)}`);
  }
  return removed;
}

await execScript("codegen");
await execScript("format");
await execScript("typecheck");
const removed = await pruneUnusedDevDependencies();
console.log(
  removed > 0
    ? `Removed ${removed} unused devDependenc${removed === 1 ? "y" : "ies"}.`
    : "No unused devDependencies found.",
);

async function prepareBuildEntry(
  pkg: WorkspacePackage,
): Promise<readonly [WorkspacePackage, string] | undefined> {
  const tsconfig = await pkg.tsconfig();

  if (!tsconfig) return undefined;
  await rm(resolve(pkg.dir, "dist"), {
    recursive: true,
    force: true,
  });

  return [pkg, tsconfig] as const;
}

const packageEntries = (
  await Promise.all((await discoverPackages()).map(prepareBuildEntry))
).filter((entry): entry is readonly [WorkspacePackage, string] => entry !== undefined);

console.log(`=== Building ${packageEntries.length} package(s) ===`);

for (const [pkg] of packageEntries) {
  console.log(pkg.slug);
}

for (const [pkg, tsconfig] of packageEntries) {
  console.log(`\n=== Building ${pkg.slug} ===`);

  try {
    await bunx(["tsc", "-p", tsconfig], {
      cwd: pkg.dir,
      stdout: "inherit",
      stderr: "inherit",
    });

    console.log(`Built: ${pkg.slug}`);
  } catch {
    fail(`Build failed: ${pkg.slug}`);
  }
}

if (packageEntries.length > 0) {
  console.log(`\nBuilt ${packageEntries.length} package(s).`);
}
