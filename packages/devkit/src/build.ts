// Build pipeline for the publishable workspace packages, run via
// `devkit build`.
//
// Every publishable (non-private) package is compiled by the single
// shared `tsdown.config.ts` at the repo root - there is no per-package
// bundler config or per-package `build` script. The config reads each
// package's own `package.json` (entries from its `exports`, externals
// from its deps) using the build cwd, so the same file drives every
// package. tsdown's `clean: true` wipes each `dist/` before emit, so no
// separate clean step is needed.
//
// Builds are independent: every bare import (workspace siblings
// included) is externalized, so a package never inlines a sibling's
// `dist` and build order does not matter. We still ask pacwich for
// dependency order so logs read top-down from leaves to roots.

import { consola } from "consola";
import { discoverPackages, toAbsolute } from "./package.js";
import { fail, runScript } from "./script.js";

/** Compile every publishable package with the shared tsdown config. */
export async function build(): Promise<void> {
  const targets = await discoverPackages();
  if (targets.length === 0) fail("No publishable packages found under packages/");

  // Absolute so the inline command resolves the same config from every
  // package cwd; tsdown then derives entries/externals from that cwd.
  const configPath = toAbsolute("tsdown.config.ts");

  consola.log(`=== Building ${targets.length} package(s) ===`);
  const summary = await runScript({
    script: `bun x --bun tsdown --config ${configPath}`,
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
