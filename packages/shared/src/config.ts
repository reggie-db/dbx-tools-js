/**
 * Layered configuration resolution for local development.
 *
 * Default sources: `env`, then Databricks App `config.env` (from
 * {@link bundle}) and hard-coded `app.yaml` env entries (from
 * {@link appYaml}). Opt in to `cli` when a dev command wants flag
 * overrides.
 *
 * **Server-only** (`node:child_process`, bundle root discovery).
 */

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import { isDatabricksAppEnv, memoize } from "./common.js";
import { stat } from "./file.js";
import { logger } from "./log.js";
import { resolveProjectRoots } from "./project.js";
import { tokenize } from "./string.js";
import { sequence, type Sequence } from "./iterable.js";

const log = logger("config");

/** Parsed payload from `databricks bundle validate --output json`. */
export type BundleValidateJson = Record<string, unknown>;

/** A config file discovered on disk with its parsed contents. */
export interface ConfigFile {
  path: string;
  data: Record<string, unknown>;
}

/** Supported configuration sources, consulted in array order. */
export type ConfigSource = "explicit" | "cli" | "env" | "bundle";

const defaultConfigSources: ConfigSource[] = ["env", "bundle"];

const APP_YAML_NAMES = ["app.yaml", "app.yml"] as const;

const bundleValidateCache = new Map<string, BundleValidateJson | undefined>();

const normalizedString = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1));

const bundleAppEnvEntrySchema = z.object({
  name: normalizedString.optional(),
  value: z.string().optional(),
  value_from: normalizedString.optional(),
});

const bundleAppResourceSchema = z.object({
  name: normalizedString.optional(),
  sql_warehouse: z
    .object({
      id: normalizedString.optional(),
    })
    .optional(),
  genie_space: z
    .object({
      space_id: normalizedString.optional(),
    })
    .optional(),
  postgres: z
    .object({
      database: normalizedString.optional(),
      branch: normalizedString.optional(),
      endpoint: normalizedString.optional(),
    })
    .optional(),
});

const bundleAppSchema = z.object({
  name: normalizedString.optional(),
  source_code_path: z.string().optional(),
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

const appYamlEnvEntrySchema = z.object({
  name: normalizedString,
  value: z.string().optional(),
  valueFrom: normalizedString.optional(),
});

const appYamlResourceSchema = z
  .object({
    name: normalizedString,
    sql_warehouse: z
      .object({
        id: normalizedString.optional(),
      })
      .optional(),
    genie_space: z
      .object({
        space_id: normalizedString.optional(),
      })
      .optional(),
    postgres: z
      .object({
        database: normalizedString.optional(),
        branch: normalizedString.optional(),
        endpoint: normalizedString.optional(),
      })
      .optional(),
  })
  .passthrough();

const appYamlSchema = z.object({
  env: z.array(appYamlEnvEntrySchema).optional(),
  resources: z.array(appYamlResourceSchema).optional(),
});

type BundleApp = z.infer<typeof bundleAppSchema>;

/** Single config map entry (string or repeated values, like headers). */
export type ConfigMapValue = string | string[] | undefined;

export interface ResolveConfigValueOptions {
  /**
   * Bundle validate JSON. Defaults to {@link bundle} (skipped inside a
   * Databricks App).
   */
  bundleData?: ConfigFile;
  /**
   * Parsed `app.yaml` contents. Defaults to {@link appYaml} (skipped
   * inside a Databricks App).
   */
  appData?: ConfigFile;
  /**
   * Sources to consult, first truthy string wins. Defaults to `env`,
   * then `bundle`.
   */
  sources?: ConfigSource[];
  /** Programmatic overrides. When set, `explicit` is appended to `sources` unless already listed. */
  explicit?: Record<string, ConfigMapValue>;
  /** CLI flag values (when `cli` is listed in `sources`). */
  cli?: Record<string, ConfigMapValue>;
}

let bundleDefault = memoize(() => loadBundle(process.cwd()));
let appYamlDefault = memoize(() => loadAppYaml(process.cwd()));

function envKeysForName(name: string): Sequence<string> {
  const trimmed = name.trim();
  if (!trimmed) {
    return sequence();
  }
  const keys = (function* () {
    const modifiers: (((value: string) => string) | null)[] = [
      null,
      () => trimmed.toUpperCase(),
      () => Array.from(tokenize(trimmed)).join("_").toUpperCase(),
    ];
    for (const modifier of modifiers) {
      yield modifier ? modifier(trimmed) : trimmed;
    }
  })();
  return sequence(keys, { cache: true }).filter(Boolean).distinct();
}

function readEnv(keys: Iterable<string>): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function readConfigMapValue(value: ConfigMapValue): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const trimmed = item?.trim();
      if (trimmed) {
        return trimmed;
      }
    }
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readMap(
  keys: Iterable<string>,
  map: Record<string, ConfigMapValue> | undefined,
): string | undefined {
  if (!map) {
    return undefined;
  }
  for (const key of keys) {
    const value = readConfigMapValue(map[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function readAppEnv(
  keys: Iterable<string>,
  envMap: Record<string, string>,
): string | undefined {
  for (const key of keys) {
    const value = envMap[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function parseYaml(text: string): unknown {
  return Bun.YAML.parse(text) as unknown;
}

function pickAppResourceId(apps: Record<string, BundleApp>): string | undefined {
  const keys = Object.keys(apps);
  return keys.length === 1 ? keys[0] : undefined;
}

/**
 * Flatten `env` entries from parsed `app.yaml` content. Literal `value`
 * entries are returned as-is; `valueFrom` entries resolve against the
 * sibling `resources` array when possible.
 */
export function flattenAppYamlEnv(data: unknown): Record<string, string> {
  const parsed = appYamlSchema.safeParse(data);
  if (!parsed.success || !parsed.data.env?.length) {
    return {};
  }

  const resourceByName = new Map(
    (parsed.data.resources ?? []).map((resource) => [resource.name, resource]),
  );

  const out: Record<string, string> = {};
  for (const entry of parsed.data.env) {
    if (entry.value?.trim()) {
      out[entry.name] = entry.value.trim();
      continue;
    }
    if (!entry.valueFrom) {
      continue;
    }
    const resource = resourceByName.get(entry.valueFrom);
    const resolved =
      resource?.sql_warehouse?.id ??
      resource?.genie_space?.space_id ??
      resource?.postgres?.endpoint ??
      resource?.postgres?.database ??
      resource?.postgres?.branch;
    if (resolved) {
      out[entry.name] = resolved;
    }
  }
  return out;
}

/**
 * Flatten `resources.apps.<key>.config.env` into a `name -> value` map.
 * Auto-picks the app only when the bundle defines exactly one.
 */
export function flattenAppEnv(data: unknown): Record<string, string> {
  const parsed = bundleValidateAppsSchema.safeParse(data);
  if (!parsed.success) {
    return {};
  }

  const apps = parsed.data.resources?.apps;
  if (!apps || Object.keys(apps).length === 0) {
    return {};
  }

  const key = pickAppResourceId(apps);
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
      resource?.postgres?.endpoint ??
      resource?.postgres?.database ??
      resource?.postgres?.branch;
    if (resolved) {
      out[entry.name] = resolved;
    }
  }
  return out;
}

async function validateBundle(root: string): Promise<BundleValidateJson | undefined> {
  const key = root;
  if (bundleValidateCache.has(key)) {
    return bundleValidateCache.get(key);
  }

  const args = ["bundle", "validate", "--output", "json"];
  try {
    const proc = spawnSync("databricks", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const text = proc.stdout?.trim();
    if (!text) {
      bundleValidateCache.set(key, undefined);
      return undefined;
    }
    const data = JSON.parse(text) as BundleValidateJson;
    bundleValidateCache.set(key, data);
    return data;
  } catch {
    bundleValidateCache.set(key, undefined);
    return undefined;
  }
}

async function loadBundle(cwd: string): Promise<ConfigFile | undefined> {
  const configFile = await resolveConfigFile(cwd, "databricks.yml");
  if (configFile) {
    const data = await validateBundle(dirname(configFile));
    if (data) {
      return { path: configFile, data };
    }
  }
  return undefined;
}

async function loadAppYaml(cwd: string): Promise<ConfigFile | undefined> {
  for (const fileName of APP_YAML_NAMES) {
    const configFile = await resolveConfigFile(cwd, fileName);
    if (!configFile) {
      continue;
    }
    try {
      const text = await readFile(configFile, "utf8");
      const data = parseYaml(text);
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        return undefined;
      }
      return { path: configFile, data: data as Record<string, unknown> };
    } catch {
      log.warn("failed to parse app yaml", { path: configFile });
    }
  }
  return undefined;
}

async function resolveConfigFile(cwd: string, configFile: string) {
  if (isDatabricksAppEnv()) {
    return undefined;
  }
  for await (const rootDir of resolveProjectRoots(cwd)) {
    const bundlePath = resolve(rootDir, configFile);
    if ((await stat(bundlePath))?.isFile()) {
      return bundlePath;
    }
  }
  return undefined;
}

/**
 * Locate the bundle root and run `databricks bundle validate --output json`.
 * When `cwd` is omitted or equals `process.cwd()`, the result is memoized
 * for the process lifetime. Returns `undefined` inside a Databricks App.
 */
export function bundle(cwd?: string): Promise<ConfigFile | undefined> {
  if (isDatabricksAppEnv()) {
    return Promise.resolve(undefined);
  }
  return cwd && resolve(cwd) !== process.cwd() ? loadBundle(cwd) : bundleDefault();
}

/**
 * Locate and parse `app.yaml` / `app.yml` from the bundle or project root.
 * When `cwd` is omitted or equals `process.cwd()`, the result is memoized
 * for the process lifetime. Returns `undefined` inside a Databricks App.
 */
export function appYaml(cwd?: string): Promise<ConfigFile | undefined> {
  if (isDatabricksAppEnv()) {
    return Promise.resolve(undefined);
  }
  return cwd && resolve(cwd) !== process.cwd() ? loadAppYaml(cwd) : appYamlDefault();
}

/**
 * Walk a dot-separated path through bundle validate JSON. When the
 * terminal node is a bundle variable object (`{ value: "..." }`), the
 * `value` field is returned.
 */
export function getBundlePath(
  data: BundleValidateJson,
  path: string,
): string | undefined {
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }

  let current: unknown = data;
  for (let i = 0; i < parts.length; i++) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    const record = current as Record<string, unknown>;
    const part = parts[i]!;
    const next = record[part];
    if (i === parts.length - 1) {
      if (typeof next === "string" && next) {
        return next;
      }
      if (typeof next === "object" && next !== null && "value" in next) {
        const value = (next as { value?: unknown }).value;
        return typeof value === "string" && value ? value : undefined;
      }
      return undefined;
    }
    current = next;
  }
  return undefined;
}

async function resolveAppEnvMap(
  options: ResolveConfigValueOptions,
): Promise<Record<string, string>> {
  const appData = options.appData ?? (await appYaml());
  const bundleData = options.bundleData ?? (await bundle());
  const fromYaml = appData ? flattenAppYamlEnv(appData.data) : {};
  const fromBundle = bundleData ? flattenAppEnv(bundleData.data) : {};
  return { ...fromYaml, ...fromBundle };
}

function resolveSources(options: ResolveConfigValueOptions): ConfigSource[] {
  const sources = [...(options.sources ?? defaultConfigSources)];
  if (options.explicit !== undefined && !sources.includes("explicit")) {
    sources.push("explicit");
  }
  return sources;
}

/**
 * Resolve a configuration string from the configured sources. Returns
 * the first non-empty value, or `undefined` when nothing matches.
 */
export async function resolveConfigValue(
  name: string,
  options: ResolveConfigValueOptions = {},
): Promise<string | undefined> {
  const keys = envKeysForName(name).toArray();
  if (keys.length === 0) return undefined;
  const sources = resolveSources(options);
  let appEnvMap: Record<string, string> | undefined;
  const values = (async function* () {
    for (const source of sources) {
      switch (source) {
        case "explicit": {
          yield readMap(keys, options.explicit);
          break;
        }
        case "cli": {
          yield readMap(keys, options.cli);
          break;
        }
        case "env": {
          yield readEnv(keys);
          break;
        }
        case "bundle": {
          if (appEnvMap === undefined) appEnvMap = await resolveAppEnvMap(options);
          yield readAppEnv(keys, appEnvMap);
          break;
        }
        default:
          throw new Error(`Unknown config source: ${source}`);
      }
    }
  })();
  for await (const value of values) {
    if (value) return value;
  }
  return undefined;
}

/**
 * Sources with `cli` included, in CLI-first order. Use for dev commands
 * that accept flag overrides.
 */
export function withCliSources(
  sources: ConfigSource[] = defaultConfigSources,
): ConfigSource[] {
  const rest = sources.filter((source) => source !== "cli" && source !== "explicit");
  return ["cli", "explicit", ...rest];
}
