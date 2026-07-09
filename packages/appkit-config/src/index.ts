/**
 * `@dbx-tools/appkit-config` - auto-configuration helpers for AppKit
 * apps. The headline export is {@link createApp}: a drop-in replacement
 * for `@databricks/appkit`'s `createApp` that resolves and applies the
 * environment each enabled capability needs, then delegates to the real
 * `createApp` unchanged.
 *
 * ```ts
 * import { createApp } from "@dbx-tools/appkit-config";
 * import { lakebase, server } from "@databricks/appkit";
 *
 * // Resolves Lakebase env vars (because `lakebase()` is present),
 * // then hands the same config to AppKit's createApp.
 * await createApp({ plugins: [server(), lakebase()] });
 * ```
 *
 * Lakebase Postgres ({@link autoConfigureLakebase}) and local config
 * resolution from env plus bundle validate JSON ({@link resolveConfigValue}).
 */
export * from "./config-value.js";
export * from "./create-app.js";
export * from "./lakebase-resolver.js";
export * from "./pgaddress.js";
export * from "./provision.js";
