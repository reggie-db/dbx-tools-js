// Build pipeline for the publishable workspace packages, run via
// `devkit build`.
//
// A gate runs before anything is compiled:
//   - codegen: regenerate the SDK-derived zod schemas.
//   - format: syncpack + prettier across the workspace.
//   - typecheck: workspace-wide `tsc --noEmit` (re-syncs the root
//     tsconfig references first).
//   - verify: workspace integrity check (no undeclared cross-workspace
//     imports).
//   - prune: drop every devDependency knip reports as unused from the
//     `package.json` that declared it (parses knip's JSON report
//     directly, no jq).
//
// Then every publishable package is compiled by handing pacwich a
// single inline `tsc -p tsconfig.build.json` (each invocation first
// wipes that package's own `dist/` and stale build cache), run across
// the packages in workspace dependency order so a package that
// consumes a sibling's `dist` builds after it. Packages without a
// `tsconfig.build.json` or marked `"private": true` are skipped:
// private packages (e.g. a demo) aren't shipped to npm and have their
// own build pipelines.

import { consola } from "consola";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { clean } from "./clean.js";
import { codegen } from "./codegen.js";
import { format } from "./format.js";
import {
  discoverPackages,
  type PackageJson,
  toAbsolute,
  toRelative,
  writeJson,
} from "./package.js";
import { fail, runScript } from "./script.js";
import { bunx } from "./shell.js";
import { verify } from "./verify.js";

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
 * Names of dependencies a package consumes through its `codegen.inputs`
 * (paths shaped like `node_modules/<pkg>/<rest>`). knip can't see these
 * - the dependency is referenced by a `package.json` field, not an
 * `import` - so the prune step must treat them as used or it would
 * delete the build input out from under codegen.
 */
function codegenReferencedDeps(meta: PackageJson): Set<string> {
  const inputs = (meta as { codegen?: { inputs?: string[] } }).codegen?.inputs ?? [];
  const names = new Set<string>();
  for (const input of inputs) {
    const source = input.split("=")[0] ?? "";
    const match = source.match(/^node_modules\/(@[^/]+\/[^/]+|[^/]+)\//);
    if (match) names.add(match[1]!);
  }
  return names;
}

/**
 * Run knip, parse its JSON report, and strip every devDependency it
 * flags as unused from the `package.json` that declared it. Deletes the
 * whole `devDependencies` block once it empties out (the repo keeps no
 * empty blocks). Returns the number of entries removed.
 */
async function pruneUnusedDevDependencies(): Promise<number> {
  // knip exits non-zero whenever it finds issues, so swallow the exit
  // code (`nothrow`) and read the JSON it still writes to stdout.
  const { stdout } = await bunx(["knip", "--reporter", "json"], {
    nothrow: true,
    quiet: true,
  });
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
    const keep = codegenReferencedDeps(meta);
    const dropped = [...names].filter((name) => {
      if (keep.has(name)) return false;
      if (!(name in devDeps)) return false;
      delete devDeps[name];
      return true;
    });
    if (dropped.length === 0) continue;
    if (Object.keys(devDeps).length === 0) delete meta.devDependencies;
    await writeJson(jsonPath, meta);
    removed += dropped.length;
    consola.log(`pruned ${dropped.sort().join(", ")} from ${toRelative(jsonPath)}`);
  }
  return removed;
}

/** Run the gate, then compile every publishable package in dependency order. */
export async function build(): Promise<void> {
  await codegen();
  await format();
  await verify();
  const removed = await pruneUnusedDevDependencies();
  consola.log(
    removed > 0
      ? `Removed ${removed} unused devDependenc${removed === 1 ? "y" : "ies"}.`
      : "No unused devDependencies found.",
  );

  // Every non-private package carrying a `tsconfig.build.json`. The
  // default `discoverPackages` filter already drops private workspaces,
  // so this leaves only what ships to npm.
  const targets = (await discoverPackages()).filter((pkg) =>
    existsSync(resolve(pkg.dir, "tsconfig.build.json")),
  );

  consola.log(`=== Building ${targets.length} package(s) ===`);

  // Wipe every package's build output first, so a stale
  // `tsconfig.build.tsbuildinfo` can't make tsc skip emit and leave an
  // empty `dist/`. Then let pacwich sequence the compile across the
  // targets, `dependencyOrder` holding each package until the siblings
  // it depends on have finished so a consumed `dist` always exists
  // first. `tsc` is run through `bun x --bun` so it resolves from
  // `node_modules` regardless of whether `node_modules/.bin` is on PATH.
  await clean();
  const summary = await runScript({
    script: "echo 'Building <workspaceName>' && bun x --bun tsc -p tsconfig.build.json",
    workspacePatterns: targets.map((pkg) => pkg.meta.name!),
    dependencyOrder: true,
  });

  if (!summary.allSuccess) {
    const failed = summary.scriptResults
      .filter((entry) => !entry.success && !entry.skipped)
      .map((entry) => entry.metadata.workspace.name);
    fail(`Build failed: ${failed.join(", ")}`);
  }

  consola.log(`Built ${summary.successCount} package(s).`);
}
