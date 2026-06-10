/**
 * `createApp` wrapper: runs dbx-tools auto-configuration, then delegates
 * to AppKit's own `createApp` with the exact same arguments.
 *
 * Drop it in as a one-for-one replacement for `@databricks/appkit`'s
 * `createApp` - same parameters, same return type, full plugin-export
 * inference preserved:
 *
 * ```ts
 * import { createApp } from "@dbx-tools/appkit-config";
 * import { lakebase, server } from "@databricks/appkit";
 *
 * await createApp({ plugins: [server(), lakebase()] });
 * ```
 *
 * Auto-configuration runs BEFORE delegating so plugins see a fully
 * populated `process.env` during their synchronous `setup()`. Each step
 * is gated on a signal so apps that don't use a given capability pay
 * nothing (and trigger no side effects):
 *
 * - Lakebase Postgres ({@link autopg}): runs only when a `lakebase`
 *   plugin is present in `config.plugins`. Resolves project / branch /
 *   endpoint / database / host and writes the `PG*` / `LAKEBASE_*` env
 *   vars the plugin reads. Skipped entirely otherwise, so it never
 *   provisions or auto-creates a Lakebase project for apps that don't
 *   ask for one.
 *
 * The package is intentionally broader than Postgres: future auto-config
 * steps for other capabilities slot into {@link autoConfigure} behind
 * their own plugin/env signal.
 */

import { createApp as appkitCreateApp } from "@databricks/appkit";

import { autopg } from "./autopg.js";

/** Config accepted by AppKit's `createApp` (and therefore by ours). */
type CreateAppConfig = Parameters<typeof appkitCreateApp>[0];

/** AppKit plugin name whose presence triggers Lakebase auto-config. */
const LAKEBASE_PLUGIN = "lakebase";

/**
 * True when `config.plugins` contains a plugin registered under `name`.
 * `PluginData` always carries its registration `name`, so this is a
 * cheap, reliable signal without instantiating anything.
 */
function usesPlugin(config: CreateAppConfig, name: string): boolean {
  return Boolean(config?.plugins?.some((entry) => entry.name === name));
}

/**
 * Run every applicable auto-config step for the given app config. Steps
 * are independent and self-gating; add new ones here as the package
 * grows beyond Postgres.
 */
async function autoConfigure(config: CreateAppConfig): Promise<void> {
  if (usesPlugin(config, LAKEBASE_PLUGIN)) {
    await autopg();
  }
}

const create = async (config?: CreateAppConfig) => {
  await autoConfigure(config);
  return appkitCreateApp(config);
};

/**
 * Auto-configuring drop-in for AppKit's `createApp`. Mirrors its
 * signature exactly (including per-plugin export inference on the
 * returned `PluginMap`) and delegates to it after {@link autoConfigure}.
 *
 * The cast restores the source generic that `Parameters`/delegation
 * erase; the runtime behaviour is just "auto-configure, then call the
 * real `createApp` with the untouched arguments".
 */
export const createApp = create as unknown as typeof appkitCreateApp;
