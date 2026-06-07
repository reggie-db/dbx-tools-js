/**
 * Server-side entry point for `@dbx-tools/shared`. Re-exports
 * everything from the browser-safe {@link ./index.client.ts} barrel
 * and adds the server-only namespaces:
 *   - `projectUtils` imports `node:fs` / `node:child_process` /
 *     `node:path` / `node:util`.
 *   - `apiUtils` / `appkitUtils` both import from `@databricks/appkit`,
 *     whose barrel transitively pulls in the typegen helpers and the
 *     `@ast-grep/napi` native binary. Keeping them out of the
 *     browser entry stops that whole subtree from being bundled
 *     for the client.
 *
 * Resolution: this file is the `import` / `default` target in the
 * package's `exports` map. Vite (and any other browser-aware
 * bundler that honors `exports.<entry>.browser`) picks
 * `index.client.ts` instead, so the node-only branches never ship
 * to the client. Add new browser-safe helpers to `index.client.ts`
 * to keep this file as the thin server-only delta.
 */

export * as appkitUtils from "./src/appkit.js";
export * as apiUtils from "./src/api.js";
export * as netUtils from "./src/net.js";
export * as projectUtils from "./src/project.js";

export * from "./index.client.js";
