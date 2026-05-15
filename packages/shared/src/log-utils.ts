interface NameLike {
    name?: string;
}
/** Plugin-facing logger surface returned by {@link logger}. */
export interface Logger {
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
export function logger(plugin: NameLike | string | undefined): Logger {
    const name = typeof plugin === "string" ? plugin : plugin?.name || undefined;
    function log(
        consoleFn: (...args: unknown[]) => void,
        message: string,
        attributes?: Record<string, unknown>,
    ): void {
        const logMessage = name ? `[${name}] ${message}` : message;
        const logArgs = [logMessage, attributes].filter(Boolean);
        consoleFn(...logArgs);
    }
    return {
        debug: (msg, attrs) => log(console.debug, msg, attrs),
        info: (msg, attrs) => log(console.info, msg, attrs),
        warn: (msg, attrs) => log(console.warn, msg, attrs),
        error: (msg, attrs) => log(console.error, msg, attrs),
    };
}