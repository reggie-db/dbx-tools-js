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
export * from "@dbx-tools/appkit-mastra-shared";
export * from "@dbx-tools/model";
export { createWorkspace } from "./workspaces.js";
export * from "./agents.js";
export * from "./chart.js";
export * from "./config.js";
export {
  DatabricksWorkspaceFilesystem,
  type DatabricksMkdirsMode,
  type DatabricksWorkspaceFilesystemOptions,
  emptyFilesystem,
  isDbfsPath,
  isWorkspaceFilesPath,
  normalizeDatabricksBasePath,
  resolveDatabricksAbsolutePath,
  toDatabricksWorkspacePath,
} from "./filesystems.js";
export * from "./genie.js";
export * from "./mcp.js";
export * from "./plugin.js";
export {
  MASTRA_MODEL_OVERRIDE_KEY,
  extractModelOverride,
  type ModelOverrideRequest,
} from "./serving.js";
export {
  buildSummarizeTool,
  summarizeText,
  type SummarizeOptions,
} from "./summarize.js";
