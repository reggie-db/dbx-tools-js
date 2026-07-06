/**
 * Build a Mastra {@link Workspace} backed by cached GitHub skill sources.
 */

import { LocalSkillSource, Workspace } from "@mastra/core/workspace";

import { resolveSkillsConfig, type SkillsPluginConfig } from "./config.js";
import { ensureSkillSources } from "./repo-cache.js";

/**
 * Download (or reuse) configured skill sources and return a Mastra
 * workspace whose skills surface spans every source tree.
 */
export async function buildSkillsWorkspace(
  config: SkillsPluginConfig,
): Promise<Workspace> {
  const resolved = resolveSkillsConfig(config);
  await ensureSkillSources(config);
  const source = new LocalSkillSource({ basePath: resolved.cacheDir });
  const workspace = new Workspace({
    id: resolved.workspaceId,
    name: resolved.workspaceName,
    skills: resolved.sources.map((s) => s.skillsRelPath),
    skillSource: source,
    checkSkillFileMtime: true,
  });
  await workspace.init();
  return workspace;
}
