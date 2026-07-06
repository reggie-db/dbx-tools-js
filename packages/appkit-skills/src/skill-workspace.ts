/**
 * Mastra workspace resolver for agents using cached skill sources.
 */

import type { Workspace } from "@mastra/core/workspace";

import { getSkillRuntime } from "./runtime.js";

/**
 * Return the Mastra {@link Workspace} primed by `skills()` at plugin
 * setup, or `undefined` when the plugin is not registered.
 *
 * Pass as `workspace` on {@link createAgent} (function form) so
 * resolution happens at agent registration, after caches are populated.
 */
export function skillWorkspace(): Workspace | undefined {
  return getSkillRuntime()?.workspace;
}
