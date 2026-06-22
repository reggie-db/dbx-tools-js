/**
 * Wire-format types, embed-marker grammar, and shared route segments
 * for `@dbx-tools/appkit-mastra`'s `clientConfig()` surface.
 *
 * Kept dependency-free (no `pg`, no `fastembed`, no Mastra runtime) so
 * the React client and any browser bundle can import these without
 * dragging in server-only dependencies. The server-side plugin
 * publishes its `basePath` through this contract; the browser client
 * (`MastraPluginClient` in `@dbx-tools/appkit-mastra-ui`) reads it back
 * via `usePluginClientConfig<MastraClientConfig>("mastra")` and derives
 * every route from `basePath` + {@link MASTRA_ROUTES}.
 */
export * from "@dbx-tools/model-shared";
export * from "./src/marker.js";
export * from "./src/protocol.js";
export * from "./src/routes.js";
