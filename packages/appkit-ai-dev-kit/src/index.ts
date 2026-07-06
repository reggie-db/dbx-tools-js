export {
  DEFAULT_CACHE_TTL_MS,
  getSkillRuntime,
  primeSkillRuntime,
  resetSkillRuntime,
  skillTools,
  skillWorkspace,
  skills,
  type ResolvedSkillSource,
  type SkillSourceConfig,
  type SkillsPluginConfig,
} from "@dbx-tools/appkit-skills";

export {
  DEFAULT_AI_DEV_KIT_REF,
  DEFAULT_AI_DEV_KIT_REPO,
  DEFAULT_AI_DEV_KIT_SOURCE,
  DEFAULT_CACHE_DIR,
  DEFAULT_SKILLS_SUBDIR,
  aiDevKit,
  buildAiDevKitWorkspace,
  ensureAiDevKitRepo,
  resolveAiDevKitConfig,
  skillsDirectory,
  type AiDevKitPluginConfig,
} from "./preset.js";

/** @deprecated Use {@link resolveAiDevKitConfig}. */
export { resolveAiDevKitConfig as resolveAiDevKitCacheOptions } from "./preset.js";

/** @deprecated Use {@link skills} from `@dbx-tools/appkit-skills`. */
export { SkillsPlugin as AiDevKitPlugin } from "@dbx-tools/appkit-skills";
