/**
 * AppKit plugin that caches GitHub-hosted Agent Skills repositories and
 * exposes them to Mastra agents via {@link skillWorkspace}.
 */

import { Plugin, toPlugin, type PluginManifest } from "@databricks/appkit";
import { commonUtils, logUtils } from "@dbx-tools/shared";
import { join } from "node:path";

import { resolveSkillsConfig, type SkillsPluginConfig } from "./config.js";
import { ensureSkillSources } from "./repo-cache.js";
import { primeSkillRuntime } from "./runtime.js";
import { buildSkillsWorkspace } from "./workspace.js";

/**
 * AppKit plugin (registered name: `skills`) that mirrors one or more
 * GitHub skill trees into a local Mastra skills surface.
 */
export class SkillsPlugin extends Plugin<SkillsPluginConfig> {
  static manifest = {
    name: "skills",
    displayName: "Agent Skills",
    description:
      "Caches GitHub-hosted Agent Skills repositories for Mastra " +
      "(skill, skill_search, skill_read) via skillWorkspace().",
    stability: "beta",
    resources: {
      required: [],
      optional: [],
    },
  } satisfies PluginManifest<"skills">;

  private log = logUtils.logger(this);
  private skillPaths: string[] = [];
  private refreshPromise: Promise<void> | undefined;

  override async setup(): Promise<void> {
    await this.refreshSkills(true);
  }

  override exports() {
    return {
      /** Absolute paths to each source's skills root directory. */
      skillPaths: (): readonly string[] => this.skillPaths,
      /** Absolute path to a source's repository checkout, when cached. */
      repoPath: (id: string): string | undefined => {
        const source = resolveSkillsConfig(this.config).sources.find((s) => s.id === id);
        if (!source) return undefined;
        return join(source.cacheRoot, "repo");
      },
      refreshSkills: (): Promise<void> => this.refreshSkills(false),
    };
  }

  private async refreshSkills(force: boolean): Promise<void> {
    if (this.refreshPromise) {
      await this.refreshPromise;
      if (!force) return;
    }
    this.refreshPromise = this.#refreshSkills(force);
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = undefined;
    }
  }

  async #refreshSkills(force: boolean): Promise<void> {
    const resolved = resolveSkillsConfig(this.config);
    try {
      await ensureSkillSources(this.config);
      const workspace = await buildSkillsWorkspace(this.config);
      if (!force) {
        await workspace.skills?.maybeRefresh();
      }
      primeSkillRuntime(workspace);
      this.skillPaths = resolved.sources.map((s) =>
        join(resolved.cacheDir, s.skillsRelPath),
      );
      const skills = await workspace.skills?.list();
      this.log.info("skills:ready", {
        sources: resolved.sources.map((s) => ({
          id: s.id,
          repo: `${s.owner}/${s.name}`,
          ref: s.ref,
          skillsSubdir: s.skillsSubdir,
        })),
        count: skills?.length ?? 0,
      });
    } catch (err) {
      this.log.error("skills:failed", { error: commonUtils.errorMessage(err) });
      throw err;
    }
  }
}

/** AppKit plugin factory (`skills()`). */
export const skills = toPlugin(SkillsPlugin);
