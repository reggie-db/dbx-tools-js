/**
 * `@dbx-tools/appkit-autopg` - top-level Lakebase Postgres auto-
 * discovery helper. Resolves project / branch / endpoint / database /
 * host from env vars and the Databricks REST API, then writes the
 * standard `PGHOST` / `PGDATABASE` / `LAKEBASE_ENDPOINT` env vars so
 * the AppKit `lakebase` plugin can connect without manual wiring.
 *
 * ```ts
 * import { autopg } from "@dbx-tools/appkit-autopg";
 * import { createApp, lakebase, server } from "@databricks/appkit";
 *
 * await autopg();
 * await createApp({ plugins: [lakebase(), server()] });
 * ```
 */
export * from "./src/address.js";
export * from "./src/autopg.js";
export * from "./src/provision.js";
export * from "./src/resolver.js";
