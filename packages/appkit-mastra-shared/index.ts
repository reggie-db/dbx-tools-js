/**
 * Wire-format types and URL helpers shipped by `@dbx-tools/appkit-mastra`'s
 * `clientConfig()` surface.
 *
 * Kept dependency-free (no `pg`, no `fastembed`, no Mastra runtime) so
 * the React client and any browser bundle can import these types
 * without dragging in server-only dependencies. The server-side plugin
 * publishes resolved paths through this contract; the client reads
 * them back via `usePluginClientConfig<MastraClientConfig>("mastra")`
 * and composes URLs with {@link chatUrl}.
 */
export * from "./src/genie.js";
export * from "./src/mastra.js";
export * from "./src/protocol.js";
