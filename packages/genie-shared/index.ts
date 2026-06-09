/**
 * `@dbx-tools/genie-shared`: pure-types + sync-helpers surface of
 * the `@dbx-tools/genie` package. Safe to import from browser
 * bundles (no `node:*`, no `WorkspaceClient`, no I/O).
 *
 * Bundles the Genie wire-format schemas and types (extending the
 * generated `@dbx-tools/sdk-shared` Genie shapes), the high-level
 * event vocabulary the `genieEventChat` driver emits, and the
 * pure detectors that derive those events from `GenieMessage`
 * snapshots. Live chat driving lives in `@dbx-tools/genie` and
 * pulls these types in; frontends only need this package, and can
 * reuse the detectors to derive UI events from snapshots
 * themselves.
 */

export * from "./src/event.js";
export * from "./src/protocol.js";
