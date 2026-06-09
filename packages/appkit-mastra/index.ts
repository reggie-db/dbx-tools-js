/**
 * Server-side entry point for the AppKit Mastra integration. Mounts
 * the plugin via {@link mastra} and re-exports the full server surface
 * (config, agent wiring, Genie and chart tooling, and dynamic Model
 * Serving resolution) so apps build agent backends from one import.
 *
 * Client-side consumers should import URL helpers and the
 * {@link MastraClientConfig} type from `@dbx-tools/appkit-mastra-shared`
 * instead - that package is pure (no pg / fastembed / Mastra deps) and
 * is the right surface for browser bundles and `usePluginClientConfig`
 * consumers.
 */
export * from "./src/plugin.js";
export * from "@dbx-tools/appkit-mastra-shared";
export * from "./src/config.js";
export * from "./src/agents.js";
export * from "./src/chart.js";
export * from "./src/genie.js";
export * from "./src/tools/email.js";
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
} from "./src/serving.js";
export {
  FALLBACK_MODEL_IDS,
  MODEL_CATALOG,
  modelForTier,
  modelsForTier,
  ModelTier,
} from "./src/model.js";
