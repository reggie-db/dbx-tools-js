// Workspace integrity check, run via `devkit verify`.
//
// Wraps pacwich's `verify`, which scans every workspace's source for
// imports of sibling workspace packages that aren't declared as a
// dependency in that workspace's `package.json` (an implicit workspace
// dependency). Such imports resolve locally through bun's hoisting but
// break for external npm consumers, who only get what the manifest
// declares - so we treat them as errors and fail the build.

import { consola } from "consola";
import { getProject } from "./project.js";
import { fail } from "./script.js";

/** Fail when any workspace imports a sibling it doesn't declare as a dependency. */
export async function verify(): Promise<void> {
  const project = await getProject();
  const result = await project.verify({ strict: true });

  for (const issue of [...result.errors, ...result.warnings]) {
    if (issue.level === "error") consola.error(issue.message);
    else consola.warn(issue.message);
  }

  if (!result.ok) {
    fail(
      `verify found ${result.errors.length} undeclared workspace ` +
        `dependenc${result.errors.length === 1 ? "y" : "ies"}`,
    );
  }

  consola.log(`verify: ${project.workspaces.length} workspace(s) OK`);
}
