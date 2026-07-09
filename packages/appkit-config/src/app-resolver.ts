/**
 * Resolve Databricks App entries from bundle validate JSON.
 *
 * Generic bundle loading lives in `@dbx-tools/shared` (`configUtils`).
 * This module handles the App-specific `resources.apps.*.config.env`
 * shape, including `value_from` bindings against sibling app resources.
 */

import { z } from "zod";

const nonEmptyTrimmedString = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1));

const bundleAppEnvEntrySchema = z.object({
  name: nonEmptyTrimmedString.optional(),
  value: z.string().optional(),
  value_from: nonEmptyTrimmedString.optional(),
});

const bundleAppResourceSchema = z.object({
  name: nonEmptyTrimmedString.optional(),
  sql_warehouse: z
    .object({
      id: nonEmptyTrimmedString.optional(),
    })
    .optional(),
  genie_space: z
    .object({
      space_id: nonEmptyTrimmedString.optional(),
    })
    .optional(),
  postgres: z
    .object({
      database: nonEmptyTrimmedString.optional(),
      branch: nonEmptyTrimmedString.optional(),
    })
    .optional(),
});

const bundleAppSchema = z.object({
  config: z
    .object({
      env: z.array(bundleAppEnvEntrySchema).optional(),
    })
    .optional(),
  resources: z.array(bundleAppResourceSchema).optional(),
});

const bundleValidateAppsSchema = z.object({
  resources: z
    .object({
      apps: z.record(z.string(), bundleAppSchema).optional(),
    })
    .optional(),
});

/**
 * Flatten `resources.apps.<key>.config.env` into a `name -> value` map.
 * `value_from` entries resolve against the sibling `resources` array on
 * the app (warehouse id, Genie space id, postgres branch/database).
 *
 * @param data - `databricks bundle validate --output json` payload.
 * @param appKey - `resources.apps` key. When omitted, auto-picks only when
 *   the bundle defines exactly one app; returns `{}` when multiple apps
 *   exist and no key is provided.
 */
export function flattenAppEnv(data: unknown, appKey?: string): Record<string, string> {
  const parsed = bundleValidateAppsSchema.safeParse(data);
  if (!parsed.success) {
    return {};
  }

  const apps = parsed.data.resources?.apps;
  if (!apps) {
    return {};
  }

  const appKeys = Object.keys(apps);
  if (!appKey && appKeys.length > 1) {
    return {};
  }

  const key =
    appKey ?? appKeys.find((candidate) => apps[candidate]?.config?.env?.length);
  if (!key) {
    return {};
  }

  const app = apps[key];
  if (!app?.config?.env?.length) {
    return {};
  }

  const resourceByName = new Map(
    (app.resources ?? [])
      .filter((resource) => resource.name)
      .map((resource) => [resource.name!, resource]),
  );

  const out: Record<string, string> = {};
  for (const entry of app.config.env) {
    if (!entry.name) {
      continue;
    }
    if (entry.value) {
      out[entry.name] = entry.value;
      continue;
    }
    if (!entry.value_from) {
      continue;
    }
    const resource = resourceByName.get(entry.value_from);
    const resolved =
      resource?.sql_warehouse?.id ??
      resource?.genie_space?.space_id ??
      resource?.postgres?.database ??
      resource?.postgres?.branch;
    if (resolved) {
      out[entry.name] = resolved;
    }
  }
  return out;
}
