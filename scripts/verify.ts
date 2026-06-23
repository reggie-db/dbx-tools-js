#!/usr/bin/env bun
// Workspace integrity check, run via `bun run verify` and as part of
// the `bun run build` gate.
//
// Wraps pacwich's `verify`, which scans every workspace's source for
// imports of sibling workspace packages that aren't declared as a
// dependency in that workspace's `package.json` (an implicit workspace
// dependency). Such imports resolve locally through bun's hoisting but
// break for external npm consumers, who only get what the manifest
// declares - so we treat them as errors and fail the build.

import { getProject } from "./project.js";
import { fail } from "./script.js";

const project = await getProject();
const result = await project.verify({ strict: true });

for (const issue of [...result.errors, ...result.warnings]) {
  console.log(`${issue.level === "error" ? "✗" : "!"} ${issue.message}`);
}

if (!result.ok) {
  fail(
    `verify found ${result.errors.length} undeclared workspace ` +
      `dependenc${result.errors.length === 1 ? "y" : "ies"}`,
  );
}

console.log(`verify: ${project.workspaces.length} workspace(s) OK`);
