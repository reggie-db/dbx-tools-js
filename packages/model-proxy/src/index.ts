/**
 * `@dbx-tools/model-proxy` public surface.
 *
 * A local OpenAI-compatible proxy in front of Databricks Model Serving:
 * point any OpenAI client's base URL at the proxy, use loose / fuzzy model
 * names, and requests are resolved to real serving endpoints and signed
 * with a fresh Databricks token. Exposes the {@link DatabricksBackend}
 * (auth + resolution) and the HTTP server factories for programmatic use;
 * the `model-proxy` bin drives the same pieces from the command line.
 */

export * from "./backend.js";
export * from "./defaults.js";
export * from "./server.js";
