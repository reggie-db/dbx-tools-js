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
 * Node always uses `index.ts`. Don't import `./src/project.js` from
 * here, even transitively - that's the entire point of the split.
 *
 * Other utility namespaces are re-exported as-is. `common.ts` ships a
 * pure-JS FNV-1a `fnvHash` (no `node:crypto`) that `string.ts` uses
 * for slug suffixes, so the whole barrel is safe in the browser;
 * `http.ts` / `plugin.ts` / `log.ts` already had no node-only imports.
 *
 * `apiUtils` is intentionally **not** re-exported here. It wraps
 * `getExecutionContext()` and a fetch-time auth header callback, both
 * of which only make sense inside an AppKit server process. It lives
 * only on `index.ts` (the server entry).
 */
export * as commonUtils from "./src/common.js";
export * as httpUtils from "./src/http.js";
export * as logUtils from "./src/log.js";
export * as pluginUtils from "./src/plugin.js";
export * as stringUtils from "./src/string.js";
