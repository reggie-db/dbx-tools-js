/**
 * Browser-safe entry point for `@dbx-tools/shared`. Mirrors
 * the server-side {@link ./index.ts} barrel except `projectUtils` is
 * absent - it imports `node:fs` / `node:child_process` / `node:path` /
 * `node:util` at module load, which Vite stubs for browsers and which
 * blows up at the first property access from the stub.
 *
 * Resolution: the package's `exports` map points the `browser`
 * condition at this file. Vite (and any other browser-aware bundler
 * that honors `exports.<entry>.browser`) picks it up automatically;
 * Node always uses `index.ts`. Don't import `./project.js` from
 * here, even transitively - that's the entire point of the split.
 *
 * Other utility namespaces are re-exported as-is. `common.ts` ships a
 * pure-JS FNV-1a `fnvHash` (no `node:crypto`) that `string.ts` uses
 * for slug suffixes, so the whole barrel is safe in the browser;
 * `http.ts` / `log.ts` already had no node-only imports.
 *
 * `apiUtils` and `appkitUtils` are intentionally **not** re-exported
 * here. Both import from `@databricks/appkit`, whose main barrel
 * re-exports server-only typegen helpers
 * (`extractServingEndpoints`, the `appKit*TypesPlugin` Vite plugins)
 * that transitively load `@ast-grep/napi`'s native `.node` binary.
 * Letting either land in the browser bundle drags the entire appkit
 * tree (including ast-grep) into the client. They live only on
 * `index.ts` (the server entry).
 */
export * as commonUtils from "./common.js";
export * as httpUtils from "./http.js";
export * as logUtils from "./log.js";
export * as netUtils from "./net.browser.js";
export * as stringUtils from "./string.js";
