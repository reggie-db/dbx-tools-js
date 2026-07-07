// Workspace integrity check, run via `dbxtools verify`.
//
// By default this is a no-op. Pass `workspaceDeps: true` (CLI:
// `--workspace-deps`) to run pacwich's implicit-workspace-dependency
// scan: imports of sibling workspace packages that aren't declared in
// the importing workspace's `package.json`. Those resolve locally
// through hoisting but can break for external npm consumers.

import { consola } from "consola";
import { getProject } from "./project.js";
import { fail } from "./script.js";

/** Options for {@link verify}. */
export interface VerifyOptions {
  /**
   * When true, fail on imports of sibling workspace packages not declared
   * as dependencies. Off by default.
   */
  workspaceDeps?: boolean;
}

/** Workspace verify pass (optional implicit-dependency scan). */
export async function verify(options: VerifyOptions = {}): Promise<void> {
  const project = await getProject();

  if (!options.workspaceDeps) {
    consola.log(
      `verify: ${project.workspaces.length} workspace(s) OK (skipped workspace dependency scan; pass --workspace-deps to enable)`,
    );
    return;
  }

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
