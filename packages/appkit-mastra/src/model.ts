/**
 * Databricks Model Serving resolver for Mastra agents.
 *
 * Each agent step calls {@link buildModel} with the active
 * `RequestContext`. The user stamped by `MastraServer` carries an
 * AppKit `WorkspaceClient`; we ask it for the workspace host and a
 * fresh bearer header, then point Mastra's OpenAI-compatible provider
 * at `/serving-endpoints` on that host.
 *
 * This module only adds the Mastra-specific glue. The actual model
 * selection - listing the workspace catalogue and resolving an
 * explicit name / tier / fallback chain to a real endpoint id - lives
 * in `@dbx-tools/model` ({@link selectModel}) so non-Mastra consumers
 * (e.g. a job that just needs a model name) can reuse it. Here we
 * assemble the explicit ask from Mastra's request context (the
 * per-request override under {@link MASTRA_MODEL_OVERRIDE_KEY}, the
 * agent / plugin `modelId`, or `DATABRICKS_SERVING_ENDPOINT_NAME`),
 * pass the plugin's fuzzy / tier / fallback knobs through, and wrap
 * the resolved id in the OpenAI-compatible provider config Mastra
 * expects. Catalogue fetches fail loud: network / auth errors
 * propagate so callers see the real SDK message.
 */

import { type ModelTier, parseModelTier, selectModel } from "@dbx-tools/model";
import { commonUtils, logUtils, netUtils, stringUtils } from "@dbx-tools/shared";
import type { MastraModelConfig } from "@mastra/core/llm";
import type { RequestContext } from "@mastra/core/request-context";

import { MASTRA_USER_KEY, type MastraPluginConfig, type User } from "./config.js";
import { MASTRA_MODEL_OVERRIDE_KEY, resolveServingConfig } from "./serving.js";

export {
  classifyEndpoints,
  FALLBACK_MODEL_IDS,
  modelForTier,
  modelsForTier,
  ModelTier,
} from "@dbx-tools/model";

/** Optional overrides accepted by {@link buildModel}. */
export interface BuildModelOverrides {
  /**
   * Static model id from the agent / plugin config (string sugar on
   * `def.model` or `config.defaultModel`). Loses to the per-request
   * override but wins over env / tier / fallback.
   */
  modelId?: string;
  /**
   * Capability tier to resolve when no explicit model id is supplied.
   * Used by internal agents (e.g. the chart planner asks for
   * {@link ModelTier.Fast}) to express intent without pinning an
   * endpoint name; the live catalogue is classified and the top
   * available model in the tier is chosen, falling back to the
   * tier's static list when the workspace has none.
   */
  tier?: ModelTier;
}

/**
 * Resolve a `MastraModelConfig` for the current agent step. Runs
 * while `agent.stream` is inside the `asUser(req)` scope so tokens
 * are user-scoped; outside an active user context the workspace
 * client falls back to the service principal.
 */
export async function buildModel(
  config: MastraPluginConfig,
  requestContext: RequestContext,
  overrides: BuildModelOverrides = {},
): Promise<MastraModelConfig> {
  void setupFetchInterceptor();
  const user = requestContext.get(MASTRA_USER_KEY) as User;
  const clientConfig = user.executionContext.client.config;
  const host = (await clientConfig.getHost()).toString();
  const headers = new Headers();
  await clientConfig.authenticate(headers);
  // The OpenAI Node SDK appends paths like `/chat/completions` to whatever
  // URL we hand it. Drop the trailing slash so the resulting URL stays
  // well-formed (`/serving-endpoints/chat/completions`).
  const url = new URL("/serving-endpoints", host).toString().replace(/\/$/, "");

  const log = logUtils.logger(config);
  const serving = resolveServingConfig(config);
  const override = serving.allowOverride
    ? (requestContext.get(MASTRA_MODEL_OVERRIDE_KEY) as string | undefined)
    : undefined;

  // The override / agent default / env value can be either a concrete
  // endpoint name or a capability tier slug ("thinking" / "balanced" /
  // "fast"). A tier slug becomes a tier intent (let the live catalogue
  // pick the best model in that band); anything else is an explicit
  // name fuzzy-matched against the catalogue. An internal
  // `overrides.tier` (e.g. the chart planner) is the floor when nothing
  // was requested.
  const requested =
    override ?? overrides.modelId ?? process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
  const requestedTier = requested !== undefined ? parseModelTier(requested) : null;
  const explicit = requestedTier === null ? requested : undefined;
  const tier = requestedTier ?? overrides.tier;

  const { modelId, source } = await selectModel(user.executionContext.client, host, {
    ...(explicit !== undefined ? { explicit } : {}),
    fuzzy: serving.fuzzy,
    threshold: serving.threshold,
    ...(tier !== undefined ? { tier } : {}),
    fallbacks: serving.fallbacks,
    ttlMs: serving.ttlMs,
  });
  log.debug("model selected", { modelId, source, requested });

  return {
    providerId: config.providerId ?? "databricks",
    modelId,
    url,
    headers: Object.fromEntries(headers.entries()),
  };
}

/** Path prefix that identifies a Databricks Model Serving REST call. */
const SERVING_ENDPOINTS_PATH_PREFIX = "/serving-endpoints/";

/**
 * OpenAI-flavoured chat message shape we need to mutate. We do not
 * import the OpenAI / AI SDK types because both packages keep these
 * fields under internal namespaces; the wire payload is the contract
 * here and it's stable enough to inline.
 */
interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_calls?: Array<{ id: string; type: string; function: unknown }>;
  tool_call_id?: string;
}

/**
 * Install a single shared `globalThis.fetch` wrapper for every POST to
 * `/serving-endpoints/...`. The wrapper does two things:
 *
 *   1. Rewrites the outgoing `messages` array to repair Mastra/AI SDK
 *      stream-replay quirks that Databricks-hosted Claude rejects (see
 *      {@link sanitizeServingMessages}).
 *   2. At `LOG_LEVEL=debug`, dumps the (post-sanitize) JSON body so
 *      4xx debugging doesn't have to fight AI SDK's `[Array]`
 *      formatter.
 *
 * Safe to call from any hot path: {@link commonUtils.memoize} ensures
 * the wrapper is installed at most once per process, so subsequent
 * calls collapse to a single cached promise even when
 * {@link buildModel} fires on every agent step.
 */
const setupFetchInterceptor = commonUtils.memoize((): void => {
  const log = logUtils.logger("mastra/llm");
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input, init) => {
    const url = netUtils.urlBuilder(input);
    if (
      !url ||
      !url.pathname.startsWith(SERVING_ENDPOINTS_PATH_PREFIX) ||
      typeof init?.body !== "string"
    ) {
      return original(input, init);
    }
    const rewritten = rewriteServingBody(init.body);
    if (rewritten !== init.body) {
      init = { ...init, body: rewritten };
    }
    try {
      log.debug("POST", { url: url.toString(), body: JSON.parse(rewritten) });
    } catch {
      log.debug("POST", { url: url.toString(), bodyType: "non-JSON" });
    }
    return original(input, init);
  }) as typeof globalThis.fetch;
});

/**
 * Parse, sanitize, and re-serialize a `/serving-endpoints/...` POST
 * body. Returns the original string verbatim when the body is not
 * JSON, has no `messages`, or no rewrite was needed; this lets the
 * caller skip the allocation of a new `init` object in the common
 * pass-through case.
 */
function rewriteServingBody(body: string): string {
  let parsed: { messages?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (!Array.isArray(parsed.messages)) return body;
  const changed = sanitizeServingMessages(parsed.messages as ChatMessage[]);
  return changed ? JSON.stringify(parsed) : body;
}

/**
 * Repair a Mastra/AI SDK message replay that Databricks-hosted Claude
 * rejects with `"This model does not support assistant message
 * prefill. The conversation must end with a user message."`.
 *
 * The bug pattern: when an assistant turn streams text *and* a
 * `tool_call`, the AI SDK persists them as two separate assistant
 * entries (text-only and tool-call-only). On the next agent step the
 * tool-call entry is replayed *before* the tool result and the
 * text entry is replayed *after* it, so the conversation ends with a
 * trailing assistant text message. Anthropic interprets that as a
 * prefill request and rejects it on Databricks (the upstream Bedrock
 * route disallows prefill).
 *
 * Fix: when the last message is an assistant text with no `tool_calls`
 * and the chain immediately before it is `assistant(tool_calls=...)`
 * followed only by `tool(...)` results, fold the trailing text back
 * into the `content` of that opening assistant and drop the duplicate.
 * The result is the canonical OpenAI shape
 * `[..., user, assistant(text + tool_calls), tool(...)]` which both
 * Databricks Claude and every other endpoint accept.
 *
 * Mutates `messages` in place; returns `true` when something changed
 * so the caller knows whether to re-serialize.
 */
function sanitizeServingMessages(messages: ChatMessage[]): boolean {
  if (messages.length < 2) return false;
  const last = messages[messages.length - 1];
  if (
    !last ||
    last.role !== "assistant" ||
    (last.tool_calls && last.tool_calls.length > 0)
  ) {
    return false;
  }

  // Walk back through any contiguous tool-result messages to find the
  // assistant turn that opened this tool sequence.
  let i = messages.length - 2;
  while (i >= 0 && messages[i]?.role === "tool") i--;
  if (i < 0) return false;
  const opener = messages[i];
  if (
    !opener ||
    opener.role !== "assistant" ||
    !opener.tool_calls ||
    opener.tool_calls.length === 0
  ) {
    return false;
  }

  // `trimToNull` collapses the `typeof string && trimmed` dance and
  // drops blank fragments before the `\n\n` join below, so the merge
  // never introduces stray leading / trailing whitespace.
  const merged = [
    stringUtils.trimToNull(opener.content),
    stringUtils.trimToNull(last.content),
  ]
    .filter((s): s is string => s !== null)
    .join("\n\n");
  opener.content = merged;
  messages.pop();
  return true;
}
