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
 * populated `process.env` during their synchronous `setup()`. Lakebase
 * Postgres ({@link autoConfigureLakebase}) runs only when a `lakebase`
 * plugin is present in `config.plugins`.
 */

import {
  createApp as appkitCreateApp,
  getUsernameWithApiLookup,
} from "@databricks/appkit";
import { logUtils } from "@dbx-tools/shared";

import { provisionCacheSchema } from "./provision.js";
import {
  applyLakebaseToEnv,
  resolveLakebaseConnection,
  type LakebaseConnection,
  type LakebaseResolverInputs,
} from "./lakebase-resolver.js";

type CreateAppConfig = Parameters<typeof appkitCreateApp>[0];

const log = logUtils.logger("create-app");

const LAKEBASE_PLUGIN = "lakebase";

function usesPlugin(config: CreateAppConfig | undefined, name: string): boolean {
  return Boolean(config?.plugins?.some((entry) => entry.name === name));
}

async function autoConfigure(config?: CreateAppConfig): Promise<void> {
  if (usesPlugin(config, LAKEBASE_PLUGIN)) {
    await autoConfigureLakebase();
  }
}

/**
 * Resolve Lakebase Postgres connection info from config + env, write the
 * resolved values to `process.env`, and return the record. Call standalone
 * before `createApp` when not using this package's `createApp` wrapper.
 */
export async function autoConfigureLakebase(): Promise<LakebaseConnection> {
  const resolved = await resolveLakebaseConnection();
  applyLakebaseToEnv(resolved);
  const user = await getUsernameWithApiLookup({});
  if (user) process.env.PGUSER ??= user;
  log.info("env updated", { ...redactLakebaseConnection(resolved), user });
  await provisionCacheSchema(log, user);
  return resolved;
}

const create = async (config?: CreateAppConfig) => {
  await autoConfigure(config);
  return appkitCreateApp(config);
};

function redactLakebaseConnection(
  resolved: LakebaseConnection,
): Record<string, unknown> {
  return {
    project: resolved.project,
    branch: resolved.branch,
    endpoint: resolved.endpoint,
    database: resolved.database,
    host: resolved.host,
    port: resolved.port,
    sslMode: resolved.sslMode,
  };
}

/** Auto-configuring drop-in for AppKit's `createApp`. */
export const createApp = create as unknown as typeof appkitCreateApp;
