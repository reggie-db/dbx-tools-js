/**
 * Agent registration for the Mastra AppKit plugin.
 *
 * Mirrors the shape of the AppKit `agents` plugin (`config.agents` map
 * of {@link MastraAgentDefinition}, dual-form `tools` accepting a plain
 * record or a `(plugins) => tools` callback). Resolves each definition
 * into a Mastra `Agent` instance during plugin setup; user-supplied
 * tool callbacks are invoked exactly once with a typed
 * {@link MastraPlugins} map built from registered sibling plugins.
 *
 * When no agents are registered the plugin falls back to a single
 * built-in analyst so the bare `mastra()` call still mounts a working
 * `chatRoute` agent for demos.
 */

import { genie } from "@databricks/appkit";
import { logUtils, pluginUtils } from "@dbx-tools/appkit-shared";
import { Agent } from "@mastra/core/agent";
import type { AgentConfig, ToolsInput } from "@mastra/core/agent";
import type { Memory } from "@mastra/memory";

import type { MastraPluginConfig } from "./config.js";
import { buildGenieTools, type GenieExports } from "./genie.js";
import { buildModel } from "./model.js";

/** Per-agent tool record. Alias of Mastra's `ToolsInput`. */
export type MastraTools = ToolsInput;

/**
 * Typed plugin map handed to the function form of
 * {@link MastraAgentDefinition.tools}. Each entry exposes a
 * `.toolkit(opts)` method that returns a tools record ready to spread
 * into an agent's `tools` field.
 *
 * Entries are `undefined` when the matching AppKit plugin isn't
 * registered in `createApp({ plugins: [...] })`, mirroring AppKit's
 * "unknown name resolves to undefined" semantic. Guard with `?.` and
 * `?? {}` when spreading.
 *
 * @example
 * ```ts
 * mastra({
 *   agents: {
 *     analyst: {
 *       instructions: "...",
 *       tools(plugins) {
 *         return {
 *           ...(plugins.genie?.toolkit({ aliases: ["default"] }) ?? {}),
 *           custom: createTool({ ... }),
 *         };
 *       },
 *     },
 *   },
 * });
 * ```
 */
export interface MastraPlugins {
  /**
   * Wraps the AppKit `genie` plugin's exports. Pass the list of Genie
   * space aliases (as configured on `genie({ spaces: { ... } })`); each
   * alias becomes a `sendMessage`-style tool plus a shared
   * `genie_get_conversation` lookup. Returns `undefined` here when the
   * `genie` plugin isn't registered.
   */
  genie?: {
    toolkit(opts: { aliases: string[]; signal?: AbortSignal }): MastraTools;
  };
}

/** Function form of {@link MastraAgentDefinition.tools}. */
export type MastraToolsFn = (
  plugins: MastraPlugins,
) => MastraTools | Promise<MastraTools>;

/**
 * A code-defined Mastra agent. Mirrors the shape AppKit's `agents`
 * plugin uses for `AgentDefinition`. The registry key under
 * `config.agents` is what `chatRoute` matches on; `name` is purely
 * informational (defaults to the key).
 */
export interface MastraAgentDefinition {
  /** Display name used as `Agent.name`. Defaults to the registry key. */
  name?: string;
  /** Optional long-form description; surfaced as `Agent.description`. */
  description?: string;
  /** System prompt body. */
  instructions: string;
  /**
   * Per-agent model override.
   *
   * - `undefined` (default): falls back to the workspace
   *   `/serving-endpoints` resolver that {@link buildModel} configures
   *   from the per-request `WorkspaceClient`.
   * - `string`: shorthand for "use the default resolver but swap the
   *   `modelId`" (e.g. `"databricks-meta-llama-3-3-70b-instruct"`).
   * - Any other Mastra `DynamicArgument<MastraModelConfig>`: passed
   *   straight through to `Agent.model`. Use this when you need full
   *   control over auth or providerId.
   */
  model?: AgentConfig["model"] | string;
  /**
   * Per-agent tool record. Either a plain map or a callback that
   * receives the typed {@link MastraPlugins} sibling-plugin index and
   * returns a map. The callback runs exactly once at agent setup; the
   * result is cached for the agent's lifetime.
   */
  tools?: MastraTools | MastraToolsFn;
  /**
   * Per-agent memory override. Defaults to `true` (use the plugin-level
   * Mastra `Memory` when configured). Set `false` for a stateless
   * agent; ignored when the plugin has no memory configured.
   */
  memory?: boolean;
}

/** Output of {@link buildAgents}: resolved agents plus the default id. */
export interface BuiltAgents {
  agents: Record<string, Agent>;
  defaultAgentId: string;
}

/** Fallback agent id used when `config.agents` is omitted entirely. */
export const FALLBACK_AGENT_ID = "default";

const FALLBACK_AGENT_INSTRUCTIONS = `You are a data analyst. The user will ask questions about
business metrics and may share personal preferences you should remember across turns.

Rules:

1. Quote numbers exactly. Never invent data.
2. When the user states a preference or durable fact about themselves
   ("I'm in EU so use EUR", "always show me the SQL"), acknowledge that
   you will remember it.
3. If you don't have enough information to answer, ask a clarifying
   question instead of guessing.`;

/**
 * Resolve every entry in `config.agents` into a Mastra `Agent`
 * instance. When `config.agents` is omitted the plugin registers a
 * single built-in `default` analyst so the bare `mastra()` call still
 * yields a working agent.
 *
 * Per-agent tool callbacks are invoked once with a typed
 * {@link MastraPlugins} index built from registered sibling plugins
 * (currently `genie`; extend `MastraPlugins` to surface more).
 *
 * @throws when `config.defaultAgent` is set to an id that isn't in the
 *   resolved registry; this is a wiring bug, not a runtime condition.
 */
export async function buildAgents(opts: {
  config: MastraPluginConfig;
  context: pluginUtils.PluginContextLike | undefined;
  memory?: Memory;
  log: logUtils.Logger;
}): Promise<BuiltAgents> {
  const { config, context, memory, log } = opts;
  const definitions = resolveDefinitions(config);
  const ids = Object.keys(definitions);
  const defaultAgentId = config.defaultAgent ?? ids[0] ?? FALLBACK_AGENT_ID;

  const plugins = buildPluginsMap(context);
  const ambientTools = config.tools ?? {};
  const agents: Record<string, Agent> = {};

  for (const [id, def] of Object.entries(definitions)) {
    const tools = await resolveTools(def.tools, plugins, ambientTools, id);
    const useMemory = def.memory ?? true;
    agents[id] = new Agent({
      id,
      name: def.name ?? id,
      ...(def.description !== undefined ? { description: def.description } : {}),
      instructions: def.instructions,
      model: resolveModel(config, def.model),
      tools,
      ...(useMemory && memory ? { memory } : {}),
    });
  }

  if (!agents[defaultAgentId]) {
    throw new Error(
      `mastra: defaultAgent "${defaultAgentId}" not found in registered agents (${ids.join(", ") || "none"})`,
    );
  }

  log.info("agents registered", { ids, defaultAgentId });
  return { agents, defaultAgentId };
}

/**
 * Pick the agent definitions to build: `config.agents` when set,
 * otherwise a single built-in analyst keyed `default`. An empty
 * `config.agents = {}` is treated as "use the default" rather than
 * erroring so a user can `agents: {}` while iterating without losing
 * their chat route.
 */
function resolveDefinitions(
  config: MastraPluginConfig,
): Record<string, MastraAgentDefinition> {
  if (config.agents && Object.keys(config.agents).length > 0) {
    return config.agents;
  }
  return {
    [FALLBACK_AGENT_ID]: {
      name: "Default Agent",
      instructions: FALLBACK_AGENT_INSTRUCTIONS,
    },
  };
}

/**
 * Adapt an `AgentDefinition.model` override into the
 * `DynamicArgument<MastraModelConfig>` Mastra's `Agent` expects.
 *
 * - `undefined`: pure default resolver.
 * - `string`: shorthand for "default resolver, swap modelId".
 * - other: passed through (callers retain full control).
 */
function resolveModel(
  config: MastraPluginConfig,
  override: MastraAgentDefinition["model"],
): AgentConfig["model"] {
  if (override === undefined) {
    return ({ requestContext }) => buildModel(config, requestContext);
  }
  if (typeof override === "string") {
    const modelId = override;
    return async ({ requestContext }) => {
      // `buildModel` always returns an OpenAICompatibleConfig today
      // (providerId / modelId / url / headers). Narrowing it out of
      // `MastraModelConfig`'s union of string-id and class instances
      // takes more types than it's worth - cast for the spread.
      const base = (await buildModel(config, requestContext)) as Record<
        string,
        unknown
      >;
      return { ...base, modelId } as ReturnType<typeof buildModel> extends Promise<
        infer T
      >
        ? T
        : never;
    };
  }
  return override;
}

/**
 * Resolve a definition's `tools` field to a flat `MastraTools` record,
 * merging in plugin-level ambient tools (per-agent tools win on key
 * collision). A thrown callback fails registration with a useful
 * "agent X tools(plugins) callback threw" wrapper instead of leaking
 * the raw stack.
 */
async function resolveTools(
  defTools: MastraAgentDefinition["tools"],
  plugins: MastraPlugins,
  ambientTools: MastraTools,
  agentId: string,
): Promise<MastraTools> {
  if (!defTools) return { ...ambientTools };
  let resolved: MastraTools;
  if (typeof defTools === "function") {
    try {
      resolved = await defTools(plugins);
    } catch (err) {
      throw new Error(
        `mastra: agent "${agentId}" tools(plugins) callback threw: ${(err as Error).message}`,
        { cause: err },
      );
    }
  } else {
    resolved = defTools;
  }
  return { ...ambientTools, ...resolved };
}

/**
 * Build the typed {@link MastraPlugins} index passed to the function
 * form of `MastraAgentDefinition.tools`. Each known plugin contributes
 * a `.toolkit(opts)` method that wraps its existing public API into a
 * Mastra-shaped tools record; missing plugins map to `undefined` so
 * the agent callback can guard with `?.`.
 */
function buildPluginsMap(
  context: pluginUtils.PluginContextLike | undefined,
): MastraPlugins {
  const map: MastraPlugins = {};
  const geniePlugin = pluginUtils.pluginInstance(context, genie);
  if (geniePlugin) {
    const exports = geniePlugin.exports() as GenieExports;
    map.genie = {
      toolkit: ({ aliases, signal }) => buildGenieTools({ aliases, exports, signal }),
    };
  }
  return map;
}
