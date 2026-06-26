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
 * Today the package covers Lakebase Postgres discovery ({@link autopg},
 * still callable standalone), but it is scoped to grow: additional
 * capability auto-config slots in behind its own plugin/env signal in
 * `createApp` without changing the call site.
 */
export * from "./autopg.js";
export * from "./create-app.js";
export * from "./pgaddress.js";
export * from "./provision.js";
export * from "./resolver.js";
