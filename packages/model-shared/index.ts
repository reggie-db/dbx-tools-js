/**
 * `@dbx-tools/model-shared`: pure-types + sync-helpers surface of the
 * `@dbx-tools/model` package. Safe to import from browser bundles (no
 * `node:*`, no `WorkspaceClient`, no I/O).
 *
 * Bundles the capability-tier vocabulary, the Foundation Model API
 * score profile, the minimal serving-endpoint descriptor, and the
 * pure tier classifier. Live endpoint listing / fuzzy resolution lives
 * in `@dbx-tools/model` and pulls these types in; frontends only need
 * this package, and can reuse the classifier to bucket a `/models`
 * response or validate a tier request themselves.
 */

export * from "./src/classify.js";
export * from "./src/protocol.js";
