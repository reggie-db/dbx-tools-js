/**
 * Configuration for the skills plugin: one or more GitHub skill trees,
 * on-disk cache location, and refresh interval.
 */

import type { BasePluginConfig } from "@databricks/appkit";
import { homedir } from "node:os";
import { join } from "node:path";

import { defaultSourceId, parseGithubRef, type ParsedGithubRef } from "./parse-github.js";

/** Re-fetch cached checkouts after this many milliseconds (24 hours). */
export const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Default on-disk cache root when {@link SkillsPluginConfig.cacheDir} is unset. */
export const DEFAULT_CACHE_DIR = join(homedir(), ".cache", "dbx-tools", "skills");

/**
 * Structured GitHub skill source. Prefer pip-style strings
 * (`"owner/repo"`) on {@link SkillsPluginConfig.sources} instead.
 */
export interface SkillSourceConfig {
  id?: string;
  github?: string;
  url?: string;
  ref?: string;
  skillsSubdir?: string;
}

/**
 * Pip-style source: `owner/repo`, `owner/repo@branch`, or
 * `owner/repo#subdirectory=<path>`. Ref defaults to `main`; skills subdirectory is
 * auto-discovered when omitted.
 */
export type SkillSourceInput = string | SkillSourceConfig;

/** AppKit config accepted by the skills plugin. */
export interface SkillsPluginConfig extends BasePluginConfig {
  sources?: SkillSourceInput[];
  cacheDir?: string;
  ttlMs?: number;
  workspaceId?: string;
  workspaceName?: string;
}

/** Resolved source after parsing and defaults. */
export interface ResolvedSkillSource extends ParsedGithubRef {
  id: string;
  cacheRoot: string;
  skillsRelPath: string;
  /** Set when the user pinned `skillsSubdir` / `#subdir` in config. */
  pinnedSkillsSubdir?: string;
  /** Resolved skills root; updated after cache download / load. */
  skillsSubdir: string;
}

/** Resolved plugin settings. */
export interface ResolvedSkillsConfig {
  cacheDir: string;
  ttlMs: number;
  workspaceId: string;
  workspaceName: string;
  sources: ResolvedSkillSource[];
}

function normalizeSourceInput(input: SkillSourceInput): SkillSourceConfig {
  if (typeof input === "string") {
    return { github: input };
  }
  return input;
}

function resolveSourceInput(
  input: SkillSourceInput,
  cacheDir: string,
): ResolvedSkillSource {
  const normalized = normalizeSourceInput(input);
  const github = normalized.github ?? normalized.url;
  if (!github) {
    throw new Error('Each skill source requires "github" or "url"');
  }
  const parsed = parseGithubRef(github, {
    ref: normalized.ref,
    skillsSubdir: normalized.skillsSubdir,
  });
  const id = normalized.id ?? defaultSourceId(parsed.owner, parsed.name);
  const cacheRoot = join(cacheDir, id);
  const pinnedSkillsSubdir = parsed.skillsSubdir ?? normalized.skillsSubdir;
  const skillsSubdir = pinnedSkillsSubdir ?? ".";
  const skillsRelPath = join(id, "repo", skillsSubdir);
  return {
    ...parsed,
    id,
    cacheRoot,
    pinnedSkillsSubdir,
    skillsSubdir,
    skillsRelPath,
  };
}

/** Apply plugin defaults and parse every configured source. */
export function resolveSkillsConfig(
  config: SkillsPluginConfig = {},
): ResolvedSkillsConfig {
  if (!config.sources?.length) {
    throw new Error('skills plugin requires at least one entry in "sources"');
  }
  const cacheDir = config.cacheDir ?? DEFAULT_CACHE_DIR;
  return {
    cacheDir,
    ttlMs: config.ttlMs ?? DEFAULT_CACHE_TTL_MS,
    workspaceId: config.workspaceId ?? "skills",
    workspaceName: config.workspaceName ?? "Skills",
    sources: config.sources.map((source) => resolveSourceInput(source, cacheDir)),
  };
}

/** Update a source's skills path after subdir discovery or cache load. */
export function applySkillsSubdir(source: ResolvedSkillSource, skillsSubdir: string): void {
  source.skillsSubdir = skillsSubdir;
  source.skillsRelPath = join(source.id, "repo", skillsSubdir);
}
