/**
 * Mastra skill tools backed by the cached skills workspace.
 */

import { createSkillTools } from "@mastra/core/workspace";
import type { ToolsInput } from "@mastra/core/agent";

import { getSkillRuntime } from "./runtime.js";

/**
 * Return Mastra's `skill`, `skill_search`, and `skill_read` tools when
 * the `skills` plugin has primed the shared runtime at setup.
 *
 * Prefer {@link skillWorkspace} on the agent definition so Mastra injects
 * `<available_skills>` each turn and mounts the same tools at runtime.
 */
export function skillTools(): ToolsInput {
  const workspace = getSkillRuntime()?.workspace;
  const skills = workspace?.skills;
  if (!skills) return {};
  return createSkillTools(skills);
}
