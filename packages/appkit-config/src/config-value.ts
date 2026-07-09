/**
 * AppKit configuration resolution for local development.
 *
 * Wraps `@dbx-tools/shared` `configUtils.resolveConfigValue` and also
 * reads flattened Databricks App `config.env` entries from bundle validate
 * JSON when the bundle source runs (see `app-resolver.ts`). Bundle
 * validate is skipped inside a deployed Databricks App via
 * `configUtils.loadBundleConfig`.
 */

import {
  configUtils,
  type BundleValidateJson,
  type ConfigSource,
  type LoadBundleConfigOptions,
} from "@dbx-tools/shared";

import { flattenAppEnv } from "./app-resolver.js";

export type { BundleValidateJson, ConfigSource, LoadBundleConfigOptions };

export interface ResolveConfigValueOptions
  extends configUtils.ResolveConfigValueOptions {
  /**
   * When `bundle` is enabled, also read flattened app `config.env`
   * entries. `true` auto-picks only when the bundle defines exactly one
   * app; a string selects a specific `resources.apps` key. Pass `false`
   * to skip app env flattening.
   */
  bundleAppEnv?: boolean | string;
}

/**
 * Resolve a configuration string. Default sources: `env`, then bundle
 * validate JSON (including app `config.env` when
 * {@link ResolveConfigValueOptions.bundleAppEnv} is not `false` and the
 * bundle has at most one app).
 */
export async function resolveConfigValue(
  name: string,
  options: ResolveConfigValueOptions = {},
): Promise<string | undefined> {
  const { bundleAppEnv = true, ...rest } = options;
  const bundleEnv =
    bundleAppEnv === false
      ? rest.bundleEnv
      : (data: BundleValidateJson) => {
          const appKey = typeof bundleAppEnv === "string" ? bundleAppEnv : undefined;
          return {
            ...flattenAppEnv(data, appKey),
            ...rest.bundleEnv?.(data),
          };
        };
  return configUtils.resolveConfigValue(name, { ...rest, bundleEnv });
}

/** Sources with `cli` first for dev commands that accept flag overrides. */
export const withCliSources = configUtils.withCliSources;
