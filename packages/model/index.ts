/**
 * `@dbx-tools/model` public surface.
 *
 * Bundles the package's Node-side Model Serving access (cached
 * `/serving-endpoints` listing plus fuzzy name resolution), the
 * workspace-aware {@link resolveModel} selector, and the server-only
 * offline fallback opinion (`FALLBACK_MODEL_IDS` / `modelsForClass`)
 * with a re-export of the pure `@dbx-tools/model-shared` surface
 * (capability tiers, the score profile, the endpoint descriptor, and
 * the tier classifier) so a single `from "@dbx-tools/model"` import
 * serves server-side consumers.
 *
 * Browser-side consumers should import `@dbx-tools/model-shared`
 * directly: the serving driver pulls in `WorkspaceClient` and AppKit's
 * `CacheManager` and is Node-only, whereas the re-exported surface is
 * pure (types + sync functions) and safe for any runtime.
 */

export * from "@dbx-tools/model-shared";
export * from "./src/classes.js";
export * from "./src/fallback.js";
export * from "./src/resolve.js";
export * from "./src/serving.js";
