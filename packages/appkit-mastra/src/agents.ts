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

import { appkitUtils, logUtils, stringUtils } from "@dbx-tools/shared";
import type { AgentConfig, ToolsInput } from "@mastra/core/agent";
import { Agent } from "@mastra/core/agent";
import type { Tool } from "@mastra/core/tools";
import { createTool } from "@mastra/core/tools";
import type { PgVectorConfig, PostgresStoreConfig } from "@mastra/pg";

import { buildRenderDataTool } from "./chart.js";
import type { MastraPluginConfig } from "./config.js";
import { buildGenieToolkitProvider, resolveGenieSpaces } from "./genie.js";
import type { MemoryBuilder } from "./memory.js";
import { buildModel, FALLBACK_MODEL_IDS } from "./model.js";
import { ResultProcessor } from "./processor.js";
import { stripStaleChartsProcessor } from "./processors/strip-stale-charts.js";

/**
 * Tool record accepted by every Mastra `Agent.tools` field and by the
 * `tools(plugins)` callback on {@link MastraAgentDefinition}.
 *
 * Alias of Mastra's `ToolsInput`, so it already accepts:
 *
 * - Mastra tools built with {@link createTool} (or `new Tool(...)`)
 * - Mastra tools built with the AppKit-shaped {@link tool} wrapper
 *   below
 * - Vercel AI SDK tools (`tool({ ... })` from `ai`)
 * - Provider-defined tools (e.g. `openai.tools.webSearch(...)`)
 *
 * Existing tool libraries drop in as-is - nothing in this package
 * forces a rebuild.
 */
export type MastraTools = ToolsInput;

/** Re-export of Mastra's native `createTool` for full-feature access. */
export { createTool } from "@mastra/core/tools";

/**
 * AppKit-shaped tool factory. Lets users mix-and-match tools across
 * AppKit's `agents` plugin and `mastra` with a single import:
 *
 * ```ts
 * import { tool } from "@dbx-tools/appkit-mastra";
 * import { z } from "zod";
 *
 * get_weather: tool({
 *   description: "Weather",
 *   schema: z.object({ city: z.string() }),
 *   execute: async ({ city }) => `Sunny in ${city}`,
 * }),
 * ```
 *
 * Maps onto Mastra's `createTool`:
 *
 * - `description` -> `description` (required)
 * - `schema` -> `inputSchema` (optional)
 * - `execute(input)` -> `execute(input, ctx)` - Mastra already calls
 *   the first arg with the parsed inputs, so the body shape is
 *   identical. The Mastra `context` arg is forwarded as the second
 *   parameter when the caller declares it.
 * - `id`: optional. Defaults to a stable identifier derived from
 *   `description` (slugified, with a short hash suffix for
 *   uniqueness). Pass an explicit `id` when you need a stable string
 *   for tracing or MCP exposure.
 *
 * Reach for {@link createTool} when you need Mastra-only fields
 * (`outputSchema`, `suspendSchema`, `requireApproval`, `mcp`, etc.).
 */
export function tool(opts: AppKitToolOptions): Tool {
  const id = opts.id ?? deriveToolId(opts.description);
  return createTool({
    id,
    description: opts.description,
    ...(opts.schema ? { inputSchema: opts.schema as never } : {}),
    execute: opts.execute as never,
  });
}

/**
 * Input shape for the AppKit-style {@link tool} factory. A trimmed
 * subset of Mastra's `createTool` options that mirrors the
 * `@databricks/appkit/beta` `tool({ description, schema, execute })`
 * signature.
 *
 * Generics are intentionally absent - inference flows through the
 * caller's `schema` (typically a Zod object), and the `execute` body
 * destructures naturally from that. Reach for {@link createTool} when
 * you need the fully-typed input/output schemas wired explicitly.
 */
export interface AppKitToolOptions {
  /** Optional stable identifier; auto-derived from `description` when omitted. */
  id?: string;
  /** Human-readable description shown to the model. Required. */
  description: string;
  /**
   * Optional input schema (any Standard Schema instance, e.g. Zod).
   * Maps to Mastra's `inputSchema`; passed through to the model
   * verbatim.
   */
  schema?: unknown;
  /**
   * Execute body. First arg is the parsed input (typed off `schema`
   * when supplied), second arg is the full Mastra execution context
   * (request context, abort signal, mastra instance) if you need it.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (input: any, context?: unknown) => unknown;
}

/**
 * Build a deterministic Mastra tool id from a description.
 * Delegates to {@link stringUtils.toUniqueSlug}: slug + always-on
 * 6-char FNV-1a base-32 suffix so two tools with the same leading
 * words don't collide in traces. Stable across runs.
 */
function deriveToolId(description: string): string {
  return stringUtils.toUniqueSlug(description, { fallbackPrefix: "tool" });
}

/**
 * Identity helper that brands a definition as a Mastra agent. Mirrors
 * AppKit's `createAgent(def)` so the registration shape matches:
 *
 * ```ts
 * const support = createAgent({
 *   instructions: "...",
 *   model: "databricks-claude-sonnet-4-6",
 *   tools(plugins) { return { ... }; },
 * });
 * ```
 *
 * Returns the definition unchanged - the wrapper exists only to anchor
 * type inference and to match the AppKit API surface.
 */
export function createAgent<T extends MastraAgentDefinition>(def: T): T {
  return def;
}

/**
 * Filter / rename options accepted by every plugin's `.toolkit()`
 * method. Mirrors AppKit's `ToolkitOptions` verbatim so options pass
 * through unchanged - the underlying AppKit plugin does the filtering
 * and we just adapt the resulting entries into Mastra tools.
 */
export interface ToolkitOptions {
  /**
   * Key prefix prepended to every tool name. AppKit's default is
   * `${pluginName}.` when omitted; pass an explicit `""` to drop it.
   */
  prefix?: string;
  /** Allowlist of local tool names. */
  only?: string[];
  /** Denylist of local tool names. */
  except?: string[];
  /** Remap specific local names to different keys. */
  rename?: Record<string, string>;
}

/**
 * Toolkit provider shape every entry in the {@link MastraPlugins} map
 * exposes. Identical to AppKit's `PluginToolkitProvider` - any AppKit
 * plugin that implements the standard `ToolProvider` interface
 * (`getAgentTools` + `executeAgentTool` + `toolkit`) is reachable
 * through this surface automatically.
 */
export interface MastraPluginToolkitProvider {
  /**
   * Returns a Mastra-shaped tools record adapted from the plugin's
   * agent tools. Each tool dispatches back through the plugin's
   * `executeAgentTool` so OBO auth and telemetry spans stay intact.
   */
  toolkit(opts?: ToolkitOptions): MastraTools;
}

/**
 * Plugin map handed to the function form of
 * {@link MastraAgentDefinition.tools}. Mirrors AppKit's `Plugins`
 * type exactly: a string-keyed record where every value exposes
 * `.toolkit(opts)`.
 *
 * Implemented as a runtime Proxy that auto-discovers any registered
 * AppKit plugin implementing the standard `ToolProvider` interface
 * (`analytics`, `files`, `lakebase`, `genie`, plus any third-party
 * plugin that does the same). Unknown names resolve to `undefined`
 * at runtime, so guard with `?.` and `?? {}` when spreading from a
 * plugin that may not be registered in every environment.
 *
 * @example
 * ```ts
 * createAgent({
 *   instructions: "...",
 *   tools(plugins) {
 *     return {
 *       ...plugins.analytics.toolkit(),
 *       ...plugins.files.toolkit({ only: ["uploads.read"] }),
 *       get_weather: tool({
 *         description: "Weather",
 *         schema: z.object({ city: z.string() }),
 *         execute: async ({ city }) => `Sunny in ${city}`,
 *       }),
 *     };
 *   },
 * });
 * ```
 */
export type MastraPlugins = Record<string, MastraPluginToolkitProvider>;

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
   * Per-agent semantic recall (PgVector) override. Cascades from
   * `config.memory`; the agent value wins when set.
   *
   * - `undefined` (default): inherit `config.memory`. When that's
   *   enabled, the agent **shares the plugin-level singleton `PgVector`
   *   instance** (cross-agent semantic recall across the same index).
   * - `false`: disable semantic recall for this agent only.
   * - `true`: enable using the shared singleton (same as default when
   *   plugin memory is enabled; useful to opt in when plugin disabled).
   * - {@link MastraMemoryConfig} object: dedicated `PgVector` for this
   *   agent (private recall index). Bypasses the shared singleton.
   */
  memory?: boolean | MastraMemoryConfigOverride;
  /**
   * Per-agent thread/message storage (`PostgresStore`) override.
   * Cascades from `config.storage`; the agent value wins when set.
   *
   * - `undefined` (default): inherit `config.storage`. When that's
   *   enabled, the agent gets its **own per-agent `PostgresStore`**
   *   keyed by `schemaName: "mastra_<agentId>"` so threads and
   *   messages stay isolated between agents in the same database.
   * - `false`: disable storage for this agent only (purely in-memory).
   * - `true`: enable with the per-agent default schema.
   * - {@link MastraStorageConfigOverride} object: dedicated
   *   `PostgresStore` config (custom schema, connection, etc.).
   */
  storage?: boolean | MastraStorageConfigOverride;
}

/**
 * Distributive `Omit` so unions in `PostgresStoreConfig` /
 * `PgVectorConfig` keep their discriminants after the override types
 * strip `id`. The built-in `Omit` collapses unions to one shape with
 * common fields only, which loses the connection-style discriminants.
 */
type DistributiveOmit<T, K extends keyof never> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * `PostgresStoreConfig` minus `id` - per-agent overrides accept any
 * Mastra-supported storage shape. `id` is filled in automatically
 * from the agent registry key so traces stay stable.
 */
export type MastraStorageConfigOverride = DistributiveOmit<
  PostgresStoreConfig,
  "id"
> & { id?: string };

/**
 * `PgVectorConfig` minus `id` - per-agent overrides accept any
 * Mastra-supported vector shape. `id` is filled in automatically
 * from the agent registry key.
 */
export type MastraMemoryConfigOverride = DistributiveOmit<PgVectorConfig, "id"> & {
  id?: string;
};

/** Output of {@link buildAgents}: resolved agents plus the default id. */
export interface BuiltAgents {
  agents: Record<string, Agent>;
  defaultAgentId: string;
}

/** Fallback agent id used when `config.agents` is omitted entirely. */
export const FALLBACK_AGENT_ID = "default";

/**
 * Default per-turn step ceiling applied to every registered agent
 * when {@link MastraPluginConfig.agentMaxSteps} is unset. Sized to
 * fit a decomposed Genie turn (grounding + several `ask_genie`
 * calls + `prepare_chart` per dataset + the final-text reply) with
 * headroom for the model to chain a couple of follow-ups before
 * answering - well above Mastra's own `agent.generate` default of
 * 5, which would cut multi-step orchestration off mid-loop.
 */
export const DEFAULT_AGENT_MAX_STEPS = 25;

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
 * Style guardrails appended to every agent's `instructions` to curb
 * common LLM-isms (em dashes, emojis, sycophantic openers, excessive
 * hedging, throwaway closers). Appended rather than prepended so the
 * agent's role/context comes first; the model's recency bias then
 * helps the style rules dominate the response surface.
 *
 * Override globally via {@link MastraPluginConfig.styleInstructions}
 * (pass `false` to disable entirely, or a string to replace).
 */
export const DEFAULT_STYLE_INSTRUCTIONS = [
  "Output style:",
  "",
  "Use markdown formatting, including headings, lists, and code blocks.",
  "Avoid lists and headers for short replies.",
  "Plain prose.",
  "Use hyphens (-) only. Never use em dashes or en dashes.",
  "Never use emojis.",
  "Skip openers like 'Great question', 'Absolutely', and 'I'd be happy to help'.",
  "Skip closers like 'Let me know if you have any questions'.",
  "Skip self-disclaimers like 'I should mention' and 'It's important to note'.",
  "Answer directly.",
  "Do not include a preamble before the actual answer.",
  "Use lists and headers only when they clarify a multi-part answer.",
].join("\n");

/**
 * Resolve the style block to append to every agent's instructions.
 * Returns `null` when the caller opted out (`styleInstructions: false`).
 */
function resolveStyleInstructions(config: MastraPluginConfig): string | null {
  if (config.styleInstructions === false) return null;
  if (typeof config.styleInstructions === "string") {
    return config.styleInstructions;
  }

  return DEFAULT_STYLE_INSTRUCTIONS;
}

/**
 * Join an agent's bespoke instructions with the resolved style block.
 * Returns the bespoke text unchanged when the style block is disabled.
 */
function composeInstructions(agentInstructions: string, style: string | null): string {
  if (!style) return agentInstructions;
  return `${agentInstructions.trimEnd()}\n\n${style}`;
}

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
  context: appkitUtils.PluginContextLike | undefined;
  memoryBuilder?: MemoryBuilder;
  log: logUtils.Logger;
}): Promise<BuiltAgents> {
  const { config, context, memoryBuilder, log } = opts;
  const definitions = resolveDefinitions(config);
  const ids = Object.keys(definitions);
  const defaultAgentId = config.defaultAgent ?? ids[0] ?? FALLBACK_AGENT_ID;

  const plugins = buildPluginsMap(config, context);
  // System-default ambient tools every agent gets out of the box.
  // Currently just `render_data` for inline visualizations; the
  // user can shadow it by including a same-named tool in their own
  // `config.tools` or per-agent `tools`. Order in {@link resolveTools}
  // is `system -> user-ambient -> per-agent`, last write wins.
  const systemTools: MastraTools = {
    render_data: buildRenderDataTool(config),
  };
  const ambientTools = { ...systemTools, ...(config.tools ?? {}) };
  const style = resolveStyleInstructions(config);
  // Default-on protection against the model copying turn-scoped
  // chartIds from prior assistant tool results into the new
  // turn's `[chart:<id>]` markers. Opt out per-plugin via
  // `config.stripStaleCharts: false`.
  const outputProcessors = [new ResultProcessor()];
  const inputProcessors =
    config.stripStaleCharts === false ? [] : [stripStaleChartsProcessor];
  const agents: Record<string, Agent> = {};

  for (const [id, def] of Object.entries(definitions)) {
    const tools = await resolveTools(def.tools, plugins, ambientTools);
    const memory = memoryBuilder?.forAgent(id, def);
    agents[id] = new Agent({
      id,
      name: def.name ?? id,
      ...(def.description !== undefined ? { description: def.description } : {}),
      instructions: composeInstructions(def.instructions, style),
      model: resolveModel(config, def.model),
      defaultOptions: {
        maxSteps: config.agentMaxSteps ?? DEFAULT_AGENT_MAX_STEPS,
      },
      tools,
      ...(memory ? { memory } : {}),
      inputProcessors,
      outputProcessors,
    });
    // Surface the effective default model per agent so operators can
    // see at a glance which endpoint each agent points at without
    // having to fire a request and inspect a trace. The value is the
    // *static* default; per-request overrides (header / query /
    // body) and the workspace-catalogue fuzzy match still apply at
    // call time.
    log.info("agent registered", {
      id,
      name: def.name ?? id,
      defaultModel: describeAgentDefaultModel(config, def),
      tools: Object.keys(tools),
    });
  }

  if (!agents[defaultAgentId]) {
    throw new Error(
      `mastra: defaultAgent "${defaultAgentId}" not found in registered agents (${ids.join(", ") || "none"})`,
    );
  }

  log.info("agents ready", { ids, defaultAgentId });
  return { agents, defaultAgentId };
}

/**
 * Best-effort description of the *static* default model an agent will
 * resolve to at call time. Walks the same precedence ladder as
 * {@link resolveModel} / {@link buildModel}:
 *
 *   1. Per-agent `def.model` (string sugar -> the literal id;
 *      function / `DynamicArgument` -> `"<dynamic>"` because the
 *      resolver decides at call time).
 *   2. Plugin-level `config.defaultModel` (same rules).
 *   3. `DATABRICKS_SERVING_ENDPOINT_NAME` env var.
 *   4. First entry of `config.defaultModelFallbacks ?? FALLBACK_MODEL_IDS`.
 *
 * Used for the startup `agent registered` log so operators can see
 * which endpoint each agent points at by default. Per-request
 * overrides (`X-Mastra-Model` etc.) and the workspace-catalogue
 * fuzzy match are still applied at runtime.
 */
function describeAgentDefaultModel(
  config: MastraPluginConfig,
  def: MastraAgentDefinition,
): string {
  const effective = def.model ?? config.defaultModel;
  if (typeof effective === "string") return effective;
  if (effective !== undefined) return "<dynamic>";
  return (
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME ??
    config.defaultModelFallbacks?.[0] ??
    FALLBACK_MODEL_IDS[0]!
  );
}

/**
 * Normalize `config.agents` into a `Record<id, definition>`. Accepts
 * any of the three shapes documented on
 * {@link MastraPluginConfig.agents}:
 *
 * - Record - returned as-is when non-empty.
 * - Single definition (detected via the required `instructions`
 *   field) - keyed by `slugify(def.name)` or `FALLBACK_AGENT_ID`.
 * - Array - keyed by `slugify(def.name)` or `agent_${i}`; duplicate
 *   slugs fail loudly so users know to set explicit names.
 *
 * Omitted or empty inputs fall back to a single built-in analyst so
 * the bare `mastra()` call still mounts a working chat route.
 */
function resolveDefinitions(
  config: MastraPluginConfig,
): Record<string, MastraAgentDefinition> {
  const input = config.agents;
  if (!input) return fallbackDefinitions();

  if (Array.isArray(input)) {
    if (input.length === 0) return fallbackDefinitions();
    const out: Record<string, MastraAgentDefinition> = {};
    input.forEach((def, i) => {
      const key = deriveAgentKey(def, i);
      if (out[key]) {
        throw new Error(
          `mastra: duplicate agent id "${key}" derived from name "${def.name ?? ""}"; ` +
            `set unique \`name\`s on each definition`,
        );
      }
      out[key] = def;
    });
    return out;
  }

  // Single-definition shorthand: an agent always has `instructions: string`,
  // a record-of-agents never has that field directly.
  if (typeof (input as MastraAgentDefinition).instructions === "string") {
    const def = input as MastraAgentDefinition;
    const key = deriveAgentKey(def);
    return { [key]: def };
  }

  const record = input as Record<string, MastraAgentDefinition>;
  if (Object.keys(record).length === 0) return fallbackDefinitions();
  return record;
}

/** Derive a registry id from a definition's `name`, with a fallback. */
function deriveAgentKey(def: MastraAgentDefinition, index?: number): string {
  if (def.name) {
    const slug = stringUtils.toIdentifier(def.name);
    if (slug) return slug;
  }
  return index === undefined ? FALLBACK_AGENT_ID : `agent_${index}`;
}

/** Built-in fallback registry used when `agents` is omitted / empty. */
function fallbackDefinitions(): Record<string, MastraAgentDefinition> {
  return {
    [FALLBACK_AGENT_ID]: {
      name: "Default Agent",
      instructions: FALLBACK_AGENT_INSTRUCTIONS,
    },
  };
}

/**
 * Pick the effective model spec for an agent. Fallback ladder, in
 * order:
 *
 *   1. Per-agent `def.model` (string sugar or `DynamicArgument`).
 *   2. Plugin-level `config.defaultModel` (string sugar or
 *      `DynamicArgument`) - mirrors AppKit's `agents({ defaultModel })`.
 *   3. The auto-resolver that mints user-scoped tokens against
 *      `/serving-endpoints` via {@link buildModel}.
 *
 * String values are treated as `modelId` sugar and threaded through
 * `buildModel`'s override hook so the runtime fuzzy matcher and the
 * per-request `X-Mastra-Model` override layer on top of the static
 * choice. Non-string `DynamicArgument`s are passed through verbatim;
 * callers that need full control over `providerId` / `headers` /
 * `modelId` bypass the resolver pipeline entirely.
 */
function resolveModel(
  config: MastraPluginConfig,
  override: MastraAgentDefinition["model"],
): AgentConfig["model"] {
  const effective = override ?? config.defaultModel;
  if (effective === undefined) {
    return ({ requestContext }) => buildModel(config, requestContext);
  }
  if (typeof effective === "string") {
    const modelId = effective;
    return ({ requestContext }) => buildModel(config, requestContext, { modelId });
  }
  return effective;
}

/**
 * Resolve a definition's `tools` field to a flat `MastraTools` record,
 * merging in plugin-level ambient tools (per-agent tools win on key
 * collision). Callback errors propagate verbatim so the original stack
 * survives - the caller already knows which agent was registering.
 */
async function resolveTools(
  defTools: MastraAgentDefinition["tools"],
  plugins: MastraPlugins,
  ambientTools: MastraTools,
): Promise<MastraTools> {
  if (!defTools) return { ...ambientTools };
  const resolved = typeof defTools === "function" ? await defTools(plugins) : defTools;
  return { ...ambientTools, ...resolved };
}

/**
 * Build the {@link MastraPlugins} runtime proxy handed to
 * `tools(plugins)` callbacks.
 *
 * Implemented as a `Proxy` over the AppKit plugin context so
 * `plugins.<name>` resolves at first access. Any sibling plugin that
 * implements AppKit's standard `ToolProvider` interface
 * (`toolkit(opts?)` + `executeAgentTool(name, args, signal?)`) is
 * auto-adapted into Mastra tools. Unknown names return `undefined`,
 * matching AppKit's `Plugins` semantics so `plugins.foo?.toolkit()`
 * remains safe in environments where `foo` isn't registered.
 *
 * `genie` is special-cased to swap the generic AppKit toolkit (which
 * runs `executeAgentTool` and only emits a single final `tool-result`
 * chunk per call) for the streaming-aware tools built by
 * {@link buildGenieProvider}. The streaming variant forwards each
 * Genie wire event (status, SQL, row counts, errors) out through the
 * Mastra `ctx.writer`, so the UI gets `tool-output` chunks in real
 * time instead of staring at a spinner for the full Genie round-trip.
 */
function buildPluginsMap(
  config: MastraPluginConfig,
  context: appkitUtils.PluginContextLike | undefined,
): MastraPlugins {
  const cache = new Map<string, MastraPluginToolkitProvider | null>();
  return new Proxy({} as MastraPlugins, {
    get(_target, propName) {
      if (typeof propName !== "string") return undefined;
      if (cache.has(propName)) return cache.get(propName) ?? undefined;
      const provider = resolveProvider(config, context, propName);
      cache.set(propName, provider);
      return provider ?? undefined;
    },
  });
}

/**
 * Pick the right {@link MastraPluginToolkitProvider} for a sibling
 * plugin lookup. Returns the Genie agent-backed adapter when
 * the caller asks for `genie` AND at least one space is reachable
 * via {@link resolveGenieSpaces} (the explicit
 * `config.genieSpaces`, the registered AppKit `genie()` plugin's
 * `spaces` config, or the `DATABRICKS_GENIE_SPACE_ID` env var).
 * Falls back to the generic AppKit `ToolProvider` adapter for
 * every other plugin name. `config` is threaded through so the
 * Genie agent inherits the same model resolver / fallback
 * ladder the calling agents use.
 *
 * The Genie agent talks to Genie directly via `@dbx-tools/genie`
 * (`genieEventChat`) and the workspace
 * `statementExecution.getStatement` API. AppKit's stock `genie`
 * plugin is honored only for its resource manifest and `spaces`
 * config so existing `app.yaml` configs and `genie({ spaces })`
 * wiring keep working without change.
 */
function resolveProvider(
  config: MastraPluginConfig,
  context: appkitUtils.PluginContextLike | undefined,
  propName: string,
): MastraPluginToolkitProvider | null {
  if (propName === "genie") {
    const spaces = resolveGenieSpaces(config, context);
    if (Object.keys(spaces).length === 0) return null;
    return buildGenieToolkitProvider({
      spaces,
      config,
    }) as MastraPluginToolkitProvider;
  }
  const plugin = context?.getPlugins().get(propName);
  return adaptPluginToolkit(plugin);
}

/**
 * AppKit `ToolProvider` shape we duck-type against any registered
 * plugin. Defined structurally to avoid coupling to AppKit's internal
 * type module layout.
 */
interface AppKitToolkitProvider {
  toolkit?: (opts?: ToolkitOptions) => Record<string, AppKitToolkitEntry>;
  executeAgentTool?: (
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

/** Single entry returned by an AppKit plugin's `.toolkit(opts)` call. */
interface AppKitToolkitEntry {
  pluginName: string;
  localName: string;
  def: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

/**
 * Adapt an AppKit `ToolProvider` plugin instance into a
 * {@link MastraPluginToolkitProvider}. Returns `null` for any plugin
 * that doesn't implement both `toolkit` and `executeAgentTool` (e.g.
 * `server`, `lakebase` when used only as a Postgres pool, etc.).
 */
function adaptPluginToolkit(plugin: unknown): MastraPluginToolkitProvider | null {
  if (!plugin || typeof plugin !== "object") return null;
  const p = plugin as AppKitToolkitProvider;
  if (typeof p.toolkit !== "function" || typeof p.executeAgentTool !== "function") {
    return null;
  }
  return {
    toolkit(opts?: ToolkitOptions): MastraTools {
      const entries = p.toolkit!(opts);
      const tools: MastraTools = {};
      for (const [key, entry] of Object.entries(entries)) {
        tools[key] = toolkitEntryToMastraTool(entry, p);
      }
      return tools;
    },
  };
}

/**
 * Wrap a single {@link AppKitToolkitEntry} as a Mastra tool whose
 * `execute` dispatches back through `plugin.executeAgentTool(...)` so
 * AppKit's OBO auth (`asUser`) and telemetry spans stay intact. JSON
 * Schema parameters pass through unchanged - Mastra's `PublicSchema`
 * accepts `JSONSchema7` directly via `@mastra/schema-compat`.
 */
function toolkitEntryToMastraTool(
  entry: AppKitToolkitEntry,
  plugin: AppKitToolkitProvider,
): Tool {
  return createTool({
    id: `${entry.pluginName}__${entry.localName}`,
    description: entry.def.description,
    ...(entry.def.parameters ? { inputSchema: entry.def.parameters as never } : {}),
    execute: async (input: unknown, context: unknown) => {
      const signal = (context as { abortSignal?: AbortSignal } | undefined)
        ?.abortSignal;
      return plugin.executeAgentTool!(entry.localName, input, signal);
    },
  });
}
