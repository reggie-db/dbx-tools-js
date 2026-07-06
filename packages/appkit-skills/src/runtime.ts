/**
 * Process-wide skills runtime primed by the `skills` plugin at setup.
 */

import type { Workspace } from "@mastra/core/workspace";

export interface SkillRuntime {
  workspace: Workspace;
}

let runtime: SkillRuntime | undefined;

/** Return the shared runtime when the skills plugin has primed it. */
export function getSkillRuntime(): SkillRuntime | undefined {
  return runtime;
}

/** Called from the plugin during setup after the workspace is ready. */
export function primeSkillRuntime(workspace: Workspace): void {
  runtime = { workspace };
}

/** Clear the runtime (tests). */
export function resetSkillRuntime(): void {
  runtime = undefined;
}
