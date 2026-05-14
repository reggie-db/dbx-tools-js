// Helpers for working with the AppKit plugin context (`this.context` on
// any class that extends `Plugin` from `@databricks/appkit`).
//
// Why these live here instead of in `@databricks/appkit`: AppKit exposes
// `this.context.getPlugins()`, which returns
// `ReadonlyMap<string, BasePlugin>`, but provides no typed lookup
// helper. Every caller ends up writing the same
// `as InstanceType<ReturnType<typeof someFactory>["plugin"]>` cast.
// These wrappers absorb that boilerplate.
//
// API shape: pass the plugin's factory (`lakebase`, `serving`, `genie`,
// or any `toPlugin(...)` result) directly. TypeScript infers both the
// instance type (so `.exports()` resolves) and the registered name (so
// the runtime lookup works) from that single value. No `<T>` annotation
// or string literal needed at the call site.

// Minimal structural shape of `this.context`. We mirror only the method
// we touch instead of depending on AppKit's `PluginContext` type, which
// is not part of the package's `exports` map and therefore cannot be
// imported. Any compatible object (real `PluginContext`, mocks, tests)
// satisfies this shape.
export interface PluginContextLike {
  getPlugins(): ReadonlyMap<string, unknown>;
}

// Structural shape of an AppKit plugin factory (the result of
// `toPlugin(SomePluginClass)`). Calling it returns a `PluginData` tuple
// whose `plugin` field is the *class constructor* and whose `name`
// field carries the registered plugin name as a literal string.
//
// Defined structurally so we don't pull `@databricks/appkit` into this
// package as a runtime or type dependency. Any function returning the
// same shape (e.g. `lakebase`, `serving`, `genie`, or a user-defined
// `toPlugin(MyPlugin)`) satisfies the bound.
type PluginFactory = (
  ...args: never[]
) => {
  plugin: abstract new (...args: never[]) => unknown;
  name: string;
};

// Maps a plugin factory back to the *instance* type of its plugin
// class. Mirrors the inline pattern users would otherwise write:
// `InstanceType<ReturnType<typeof factory>["plugin"]>`.
type PluginInstanceOf<F extends PluginFactory> = InstanceType<
  ReturnType<F>["plugin"]
>;


/**
 * Look up a sibling plugin instance from the AppKit plugin context,
 * keyed off the factory's registered name and typed via its plugin
 * class.
 *
 * Returns `undefined` when the context is missing or the plugin is not
 * registered. For required siblings prefer {@link requirePlugin}.
 *
 * @example
 * ```ts
 * import { lakebase } from "@databricks/appkit";
 * import { pluginInstance } from "@dbx-tools/appkit-shared";
 *
 * const lake = pluginInstance(this.context, lakebase);
 * //    ^^ inferred as LakebasePlugin | undefined
 * lake?.exports().pool;
 * ```
 */
export function pluginInstance<F extends PluginFactory>(
  ctx: PluginContextLike | undefined,
  factory: F,
): PluginInstanceOf<F> | undefined {
  const name = factory().name;
  return ctx?.getPlugins().get(name) as PluginInstanceOf<F> | undefined;
}

/**
 * Like {@link pluginInstance} but throws when the plugin is not
 * registered. Use for siblings whose absence is a wiring bug rather
 * than a runtime condition (e.g. requiring `lakebase` when the caller
 * has `storage` / `memory` enabled).
 *
 * `caller` is prepended to the error message so cross-plugin failures
 * are easy to attribute in logs.
 *
 * @example
 * ```ts
 * import { lakebase } from "@databricks/appkit";
 * import { requirePlugin } from "@dbx-tools/appkit-shared";
 *
 * const pool = requirePlugin(this.context, lakebase, "mastra")
 *   .exports().pool;
 * ```
 */
export function requirePlugin<F extends PluginFactory>(
  ctx: PluginContextLike | undefined,
  factory: F,
  caller?: string,
): PluginInstanceOf<F> {
  const name = factory().name;
  const plugin = ctx?.getPlugins().get(name) as PluginInstanceOf<F> | undefined;
  if (!plugin) {
    const prefix = caller ? `${caller}: ` : "";
    throw new Error(`${prefix}required plugin not registered: ${name}`);
  }
  return plugin;
}

export interface PluginLike {
  name?: string;
}

// Structural shape of AppKit's `ITelemetry.getLogger()` return value
// (an OpenTelemetry `Logger` from `@opentelemetry/api-logs`). We mirror
// only `emit` so this package stays independent of any OTel package.
interface OtelLoggerLike {
  emit(record: { severityNumber?: number; body?: string; attributes?: Record<string, unknown> }): void;
}

// Structural shape of AppKit's `ITelemetry`. We touch only `getLogger`,
// which is the documented entry point for plugin logs.
interface PluginTelemetryLike {
  getLogger(options?: { name?: string; includePrefix?: boolean }): OtelLoggerLike;
}


// OpenTelemetry SeverityNumber constants (from the OTel logs spec).
// Hardcoded so this module avoids importing `@opentelemetry/api-logs`.
const SEVERITY_DEBUG = 5;
const SEVERITY_INFO = 9;
const SEVERITY_WARN = 13;
const SEVERITY_ERROR = 17;

// Minimal ambient declaration so this package does not need `@types/node`
// or the DOM lib just to call the global `console`.
declare const console: {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

/** Plugin-facing logger surface returned by {@link pluginLogger}. */
export interface PluginLogger {
  debug(message: string, attributes?: Record<string, unknown>): void;
  info(message: string, attributes?: Record<string, unknown>): void;
  warn(message: string, attributes?: Record<string, unknown>): void;
  error(message: string, attributes?: Record<string, unknown>): void;
}

/**
 * Build a per-plugin logger that routes through AppKit's `ITelemetry`
 * (the established pattern on `this.telemetry`) and mirrors to `console`
 * with a `[plugin-name]` prefix so dev output stays visible without
 * configuring an OTel logs exporter.
 *
 * Pass `this` from inside any class extending `Plugin`; both `name` and
 * `telemetry` are read off the instance via runtime duck typing (the
 * argument is `unknown` so TypeScript's `protected` visibility on
 * `Plugin.telemetry` doesn't block the call site). If `telemetry` is
 * missing (e.g. before `attachContext` runs, or in tests), the helper
 * falls back to console-only logging so calls never throw.
 *
 * @example
 * ```ts
 * import { pluginLogger } from "@dbx-tools/appkit-shared";
 *
 * class MyPlugin extends Plugin {
 *   private log = pluginLogger(this);
 *
 *   override async setup() {
 *     this.log.info("starting");
 *     this.log.warn("missing optional config", { reason: "no env var" });
 *   }
 * }
 * ```
 */
export function pluginLogger(plugin: PluginLike): PluginLogger {
  const bag = (plugin ?? {}) as { name?: unknown; telemetry?: unknown };
  const name = typeof bag.name === "string" && bag.name ? bag.name : "plugin";
  const telemetry = bag.telemetry as PluginTelemetryLike | undefined;
  const otel = telemetry?.getLogger?.({ name });

  function log(
    severity: number,
    consoleFn: (...args: unknown[]) => void,
    message: string,
    attributes?: Record<string, unknown>,
  ): void {
    otel?.emit({ severityNumber: severity, body: message, attributes });
    if (attributes) consoleFn(`[${name}] ${message}`, attributes);
    else consoleFn(`[${name}] ${message}`);
  }

  return {
    debug: (msg, attrs) => log(SEVERITY_DEBUG, console.debug, msg, attrs),
    info: (msg, attrs) => log(SEVERITY_INFO, console.info, msg, attrs),
    warn: (msg, attrs) => log(SEVERITY_WARN, console.warn, msg, attrs),
    error: (msg, attrs) => log(SEVERITY_ERROR, console.error, msg, attrs),
  };
}

/**
 * Minimal `Cookie` header parser. Avoids pulling in `cookie-parser` for
 * the two cookies this plugin owns. Decodes percent-encoded values and
 * returns a flat name -> value map.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    const raw = part.slice(eq + 1).trim();
    out[name] = decodeURIComponent(raw);
  }
  return out;
}

export function tokenize(
  distinct = false,
  ...values: any[]
): string[] {
  const parts = values.flatMap(value => {
    if (value == null) {
      return [];
    }

    return String(value)
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[^a-zA-Z0-9]+/)
      .filter(Boolean);
  });

  return distinct ? [...new Set(parts)] : parts;
}

export function toUnderscoreCase(
  distinct = false,
  ...values: any[]
): string {
  return tokenize(distinct, ...values)
    .map(part => part.toLowerCase())
    .join("_");
}

export function toKebabCase(
  distinct = false,
  ...values: any[]
): string {
  return tokenize(distinct, ...values)
    .map(part => part.toLowerCase())
    .join("-");
}

export function toCamelCase(
  distinct = false,
  ...values: any[]
): string {
  const parts = tokenize(distinct, ...values);

  if (parts.length === 0) {
    return "";
  }

  return (
    parts[0].toLowerCase() +
    parts
      .slice(1)
      .map(
        part =>
          part.charAt(0).toUpperCase() +
          part.slice(1).toLowerCase(),
      )
      .join("")
  );
}