/**
 * Server-side entry point for `@dbx-tools/appkit-shared`. Re-exports
 * everything from the browser-safe {@link ./index.client.ts} barrel
 * and adds `projectUtils`, which imports `node:fs` /
 * `node:child_process` / `node:path` / `node:util` and is therefore
 * server-only.
 *
 * Resolution: this file is the `import` / `default` target in the
 * package's `exports` map. Vite (and any other browser-aware
 * bundler that honors `exports.<entry>.browser`) picks
 * `index.client.ts` instead, so the node-only `projectUtils`
 * branch never ships to the client. Add new browser-safe helpers
 * to `index.client.ts` to keep this file as the thin server-only
 * delta.
 */
export * from "./index.client.js";
export * as projectUtils from "./src/project.js";
export * as apiUtils from "./src/api.js";
