/**
 * `@dbx-tools/genie` public surface.
 *
 * Bundles the package's Node-side drivers (live chat plus space
 * metadata / curated-question lookup) with a re-export of the pure
 * `@dbx-tools/genie-shared` wire vocabulary so a single
 * `from "@dbx-tools/genie"` import serves server-side consumers
 * that need both the live driver and the protocol types.
 *
 * Browser-side consumers should import `@dbx-tools/genie-shared`
 * directly: the chat driver pulls in `WorkspaceClient` and is
 * Node-only, whereas the re-exported protocol surface is pure
 * (types + sync functions) and safe for any runtime.
 */

export * from "@dbx-tools/genie-shared";
export * from "./chat.js";
export * from "./space.js";
