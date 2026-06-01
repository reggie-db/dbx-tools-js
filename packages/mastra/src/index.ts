/**
 * AppKit Mastra integration: {@link MastraPlugin} / {@link mastra},
 * plugin config types, agent registration helpers, Genie tool
 * builders, and dynamic Model Serving endpoint resolution.
 *
 * Client-side consumers should import URL helpers and the
 * {@link MastraClientConfig} type from `@dbx-tools/appkit-mastra/client`
 * instead - that subpath is pure (no pg / fastembed / Mastra deps) and
 * is the right surface for `usePluginClientConfig` consumers.
 */
export * from "./plugin.js";
export * from "./client.js";
export * from "./config.js";
export * from "./agents.js";
export * from "./genie.js";
export {
  clearServingEndpointsCache,
  extractModelOverride,
  listServingEndpoints,
  MASTRA_MODEL_OVERRIDE_KEY,
  MODEL_OVERRIDE_BODY_FIELDS,
  MODEL_OVERRIDE_HEADER,
  MODEL_OVERRIDE_QUERY,
  resolveModelId,
  type ResolvedModel,
  type ResolveModelOptions,
  type ServingEndpointSummary,
} from "./serving.js";
export {
  FALLBACK_MODEL_IDS,
  MODEL_CATALOG,
  modelForTier,
  modelsForTier,
  ModelTier,
} from "./model.js";
