import type { NameLike } from "./common.js";

/** Plugin-facing logger surface returned by {@link logger}. */
export interface Logger {
  debug(message: string, attributes?: Record<string, unknown>): void;
  info(message: string, attributes?: Record<string, unknown>): void;
  warn(message: string, attributes?: Record<string, unknown>): void;
  error(message: string, attributes?: Record<string, unknown>): void;
}

/**
 * Build a per-plugin logger that writes to `console` with an optional
 * `[plugin-name]` prefix derived from `plugin.name` or the string you pass in.
 *
 * @example
 * ```ts
 * import { logUtils } from "@dbx-tools/appkit-shared";
 *
 * class MyPlugin extends Plugin {
 *   private log = logUtils.logger(this);
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
