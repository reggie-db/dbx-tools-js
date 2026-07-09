/**
 * Layered configuration resolution for local development.
 *
 * Default sources: `env`, then a Databricks Asset Bundle resolved via
 * `databricks bundle validate --output json` (never hand-parsed
 * `databricks.yml`). Opt in to `cli` when a dev command wants flag
 * overrides.
 *
 * **Server-only** (`node:child_process`, bundle root discovery).
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";

import { isDatabricksAppEnv } from "./common.js";
import { stat } from "./file.js";
import { logger } from "./log.js";
import { resolveProjectRoots } from "./project.js";
import { tokenize } from "./string.js";

const log = logger("config");

/** Parsed payload from `databricks bundle validate --output json`. */
export type BundleValidateJson = Record<string, unknown>;

/** Supported configuration sources, consulted in array order. */
export type ConfigSource = "explicit" | "cli" | "env" | "bundle";

const defaultConfigSources: ConfigSource[] = ["env", "bundle"];

const bundleCache = new Map<string, BundleValidateJson | undefined>();

export interface LoadBundleConfigOptions {
  /** Directory to start bundle discovery from. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Bundle root override (must contain `databricks.yml`). */
  root?: string;
  /** Passed through as `databricks bundle validate --target`. */
  target?: string;
  /** `databricks` CLI binary. Defaults to `"databricks"`. */
  databricksCli?: string;
  /**
   * When `true`, run bundle validate even inside a Databricks App.
   * Defaults to `false` (skipped in app runtime).
   */
  allowDatabaricksAppEnv?: boolean;
}

export interface ResolveConfigValueOptions extends LoadBundleConfigOptions {
  /**
   * Pre-loaded bundle validate JSON. When set, skips spawning the CLI.
   */
  bundleData?: BundleValidateJson;
  /**
   * Sources to consult, first truthy string wins. Defaults to `env`,
   * then `bundle`.
   */
  sources?: ConfigSource[];
  /**
   * Dot path in bundle validate JSON. Defaults to `variables.{name}`.
   */
  bundlePath?: string;
  /** Programmatic overrides (when `explicit` is listed in `sources`). */
  explicit?: Record<string, string | undefined>;
  /** CLI flag values (when `cli` is listed in `sources`). */
  cli?: Record<string, string | undefined>;
  /**
   * Optional extra bundle env map (for example flattened app
   * `config.env`). Keys are matched with the same rules as `process.env`.
   */
  bundleEnv?: (data: BundleValidateJson) => Record<string, string>;
}

function cacheKey(root: string, target?: string): string {
  return `${root}\0${target ?? ""}`;
}

async function findBundleRootUpward(startDir: string): Promise<string | undefined> {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = resolve(dir, "databricks.yml");
    const fileStat = await stat(candidate);
    if (fileStat?.isFile()) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

function envKeysForName(name: string): string[] {
  const keys = new Set<string>();
  const trimmed = name.trim();
  if (!trimmed) {
    return [];
  }
  keys.add(trimmed);
  keys.add(trimmed.toUpperCase());
  const tokenized = Array.from(tokenize(trimmed)).join("_").toUpperCase();
  if (tokenized) {
    keys.add(tokenized);
  }
  return [...keys];
}

function readEnv(name: string): string | undefined {
  for (const key of envKeysForName(name)) {
    const value = process.env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function readMap(
  name: string,
  map: Record<string, string | undefined> | undefined,
): string | undefined {
  if (!map) {
    return undefined;
  }
  for (const key of envKeysForName(name)) {
    const value = map[key]?.trim();
    if (value) {
      return value;
    }
  }
  const direct = map[name]?.trim();
  return direct || undefined;
}

function readBundle(
  name: string,
  data: BundleValidateJson,
  bundlePath: string | undefined,
  bundleEnv: Record<string, string> | undefined,
): string | undefined {
  const fromPath = getBundlePath(data, bundlePath ?? `variables.${name}`);
  if (fromPath) {
    return fromPath;
  }
  if (!bundleEnv) {
    return undefined;
  }
  for (const key of envKeysForName(name)) {
    const value = bundleEnv[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

/**
 * Locate a bundle root by consulting {@link resolveProjectRoots} and
 * walking upward from each candidate for `databricks.yml`.
 */
export async function findBundleRoot(cwd?: string): Promise<string | undefined> {
  const seen = new Set<string>();
  for await (const rootDir of resolveProjectRoots(cwd)) {
    const normalized = resolve(rootDir);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    const found = await findBundleRootUpward(normalized);
    if (found) {
      log.info("resolved bundle root", { root: found, from: normalized });
      return found;
    }
  }
  log.info("bundle root not found", { cwd: cwd ? resolve(cwd) : process.cwd() });
  return undefined;
}

/** Drop cached bundle validate output. Intended for tests. */
export function clearBundleConfigCache(): void {
  bundleCache.clear();
}

/**
 * Run `databricks bundle validate --output json` from the bundle root.
 * The CLI prints warnings to stderr but still emits JSON on stdout even
 * when validation fails. Results are cached per `(root, target)`.
 */
export async function loadBundleConfig(
  options: LoadBundleConfigOptions = {},
): Promise<BundleValidateJson | undefined> {
  if (isDatabricksAppEnv() && !options.allowDatabaricksAppEnv) {
    return undefined;
  }

  const root = options.root ?? (await findBundleRoot(options.cwd));
  if (!root) {
    return undefined;
  }

  const key = cacheKey(root, options.target);
  if (bundleCache.has(key)) {
    return bundleCache.get(key);
  }

  const cli = options.databricksCli ?? "databricks";
  const args = ["bundle", "validate", "--output", "json"];
  if (options.target) {
    args.push("--target", options.target);
  }

  try {
    const proc = spawnSync(cli, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const text = proc.stdout?.trim();
    if (!text) {
      bundleCache.set(key, undefined);
      return undefined;
    }
    const data = JSON.parse(text) as BundleValidateJson;
    bundleCache.set(key, data);
    return data;
  } catch {
    bundleCache.set(key, undefined);
    return undefined;
  }
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

/**
 * Resolve a configuration string from the configured sources. Returns
 * the first non-empty value, or `undefined` when nothing matches.
 */
export async function resolveConfigValue(
  name: string,
  options: ResolveConfigValueOptions = {},
): Promise<string | undefined> {
  const trimmed = name.trim();
  if (!trimmed) {
    return undefined;
  }

  const sources = options.sources ?? defaultConfigSources;
  let bundleData: BundleValidateJson | undefined = options.bundleData;

  for (const source of sources) {
    switch (source) {
      case "explicit": {
        const value = readMap(trimmed, options.explicit);
        if (value) {
          return value;
        }
        break;
      }
      case "cli": {
        const value = readMap(trimmed, options.cli);
        if (value) {
          return value;
        }
        break;
      }
      case "env": {
        const value = readEnv(trimmed);
        if (value) {
          return value;
        }
        break;
      }
      case "bundle": {
        if (!bundleData) {
          bundleData = await loadBundleConfig(options);
        }
        if (bundleData) {
          const bundleEnv = options.bundleEnv?.(bundleData);
          const value = readBundle(trimmed, bundleData, options.bundlePath, bundleEnv);
          if (value) {
            return value;
          }
        }
        break;
      }
      default:
        throw new Error(`Unknown config source: ${source}`);
    }
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
