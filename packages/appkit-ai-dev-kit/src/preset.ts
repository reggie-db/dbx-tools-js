/**
 * Preset configuration for the Field Engineering AI Dev Kit skills tree.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import {
  buildSkillsWorkspace,
  ensureCachedSource,
  resolveSkillsConfig,
  skills,
  type SkillSourceInput,
  type SkillsPluginConfig,
} from "@dbx-tools/appkit-skills";

/** Default upstream repository (`owner/name`). */
export const DEFAULT_AI_DEV_KIT_REPO = "databricks-solutions/ai-dev-kit";

/** Default git ref to download (`main`). */
export const DEFAULT_AI_DEV_KIT_REF = "main";

/** Skills directory inside the repository checkout. */
export const DEFAULT_SKILLS_SUBDIR = "databricks-skills";

/** Default on-disk cache root for the AI Dev Kit preset. */
export const DEFAULT_CACHE_DIR = join(homedir(), ".cache", "dbx-tools", "ai-dev-kit");

/** Default pip-style AI Dev Kit source. */
export const DEFAULT_AI_DEV_KIT_SOURCE =
  `${DEFAULT_AI_DEV_KIT_REPO}#subdirectory=${DEFAULT_SKILLS_SUBDIR}`;

function pipSource(
  repo: string,
  ref?: string,
  skillsSubdir?: string,
): string {
  let source = repo;
  if (ref) source += `@${ref}`;
  if (skillsSubdir) source += `#subdirectory=${skillsSubdir}`;
  return source;
}

/**
 * Legacy config shape for {@link aiDevKit}. Accepts either `sources` or the
 * older single-repo `repo` / `ref` / `skillsSubdir` fields.
 */
export type AiDevKitPluginConfig = Omit<SkillsPluginConfig, "sources"> & {
  sources?: SkillSourceInput[];
  repo?: string;
  ref?: string;
  skillsSubdir?: string;
};

/** Resolve {@link aiDevKit} config into a generic {@link SkillsPluginConfig}. */
export function resolveAiDevKitConfig(
  config: AiDevKitPluginConfig = {},
): SkillsPluginConfig {
  const {
    repo,
    ref,
    skillsSubdir,
    sources,
    cacheDir,
    workspaceId,
    workspaceName,
    ttlMs,
  } = config;
  return {
    cacheDir: cacheDir ?? DEFAULT_CACHE_DIR,
    workspaceId: workspaceId ?? "ai-dev-kit",
    workspaceName: workspaceName ?? "Databricks AI Dev Kit",
    ttlMs,
    sources:
      sources ??
      [
        repo || ref || skillsSubdir
          ? pipSource(repo ?? DEFAULT_AI_DEV_KIT_REPO, ref, skillsSubdir)
          : DEFAULT_AI_DEV_KIT_SOURCE,
      ],
  };
}

/** AppKit plugin preset for the AI Dev Kit skills repository. */
export function aiDevKit(config: AiDevKitPluginConfig = {}) {
  return skills(resolveAiDevKitConfig(config));
}

/** @deprecated Use {@link buildSkillsWorkspace} from `@dbx-tools/appkit-skills`. */
export async function buildAiDevKitWorkspace(config: AiDevKitPluginConfig = {}) {
  return buildSkillsWorkspace(resolveAiDevKitConfig(config));
}

/** @deprecated Use {@link ensureSkillSources} from `@dbx-tools/appkit-skills`. */
export async function ensureAiDevKitRepo(config: AiDevKitPluginConfig = {}) {
  const resolved = resolveSkillsConfig(resolveAiDevKitConfig(config));
  const source = resolved.sources[0];
  if (!source) throw new Error("ai-dev-kit preset requires at least one source");
  await ensureCachedSource(source, resolved.ttlMs);
  return join(source.cacheRoot, "repo");
}

/** Absolute path to the skills directory inside a cached repository root. */
export function skillsDirectory(repoPath: string, skillsSubdir: string): string {
  return join(repoPath, skillsSubdir);
}
