/**
 * Wire-format contract for `@dbx-tools/appkit-email`: the email a model
 * drafts and the result of dispatching it (zod schemas + inferred
 * types). Pure and browser-safe - no `node:*` imports - so the
 * server-side sender, the Mastra tool, and the React approval UI all
 * validate and type against one definition.
 */
export * from "./src/protocol.js";
