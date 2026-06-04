import type { NameLike } from "./common.js";

/** Plugin-facing logger surface returned by {@link logger}. */
export interface Logger {
  debug(message: string, attributes?: Record<string, unknown>): void;
  info(message: string, attributes?: Record<string, unknown>): void;
  warn(message: string, attributes?: Record<string, unknown>): void;
  error(message: string, attributes?: Record<string, unknown>): void;
}

/**
 * Severity ordering. A log call below the active threshold is
 * discarded entirely (no string formatting, no console call). The
 * threshold is read on every call from `process.env.LOG_LEVEL`,
 * case-insensitive, defaulting to `info` when unset / empty /
 * unrecognised. Set `LOG_LEVEL=debug` for verbose dev output,
 * `LOG_LEVEL=warn` to silence info chatter in production, etc.
 *
 * Lazy on purpose: looking up `process.env.LOG_LEVEL` per call
 * costs nothing meaningful, and it lets test runners (and other
 * embedders) flip the level after `log.ts` has already been
 * imported, without restarting the process or reaching into
 * private state.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const DEFAULT_LEVEL: LogLevel = "info";

/**
 * Read the active threshold from `process.env.LOG_LEVEL`. Recognises
 * any case (`DEBUG`, `Debug`, `debug`), trims whitespace, falls back
 * to {@link DEFAULT_LEVEL} when unset / empty / unrecognised.
 *
 * Browser-safe: `process` is undefined in browser bundles unless a
 * polyfill or build-time replace is set up, so we guard the access.
 * In a Vite app, set `LOG_LEVEL` via `define` config or just leave
 * it - the default `info` is sane for production browser code.
 */
function activeLevel(): LogLevel {
  const env = typeof process !== "undefined" ? process.env : undefined;
  const raw = env?.LOG_LEVEL?.toLowerCase().trim();
  if (raw && Object.prototype.hasOwnProperty.call(LEVEL_RANK, raw)) {
    return raw as LogLevel;
  }
  return DEFAULT_LEVEL;
}

/** True when calls at `level` should reach the console. */
function shouldEmit(level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[activeLevel()];
}

const LOGGER_NAME_REGEX = /^(?:[a-z][a-z0-9+.-]*:\/\/)?.*\/([^/.]+)(?:\.[^/]+)?$/i;

function extractLoggerName(
  loggerName: NameLike | string | undefined,
): string | undefined {
  if (!loggerName) return undefined;
  else if (typeof loggerName === "string") {
    const match = loggerName.match(LOGGER_NAME_REGEX);
    return match?.[1] ?? loggerName;
  } else {
    return extractLoggerName(loggerName?.name);
  }
}

/**
 * Build a per-plugin logger that writes to `console` with an optional
 * `[plugin-name]` prefix derived from `plugin.name` or the string you pass in.
 *
 * Calls below `process.env.LOG_LEVEL` are discarded before any
 * string work happens, so leaving `log.debug({...heavy details})`
 * in production code is free as long as `LOG_LEVEL` is `info` or
 * higher. Default level is `info`.
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
export function logger(loggerName: NameLike | string | undefined): Logger {
  const name = extractLoggerName(loggerName);
  function log(
    level: LogLevel,
    consoleFn: (...args: unknown[]) => void,
    message: string,
    attributes?: Record<string, unknown>,
  ): void {
    if (!shouldEmit(level)) return;
    const logMessage = name ? `[${name}] ${message}` : message;
    const logArgs = [logMessage, attributes].filter(Boolean);
    consoleFn(...logArgs);
  }
  return {
    debug: (msg, attrs) => log("debug", console.debug, msg, attrs),
    info: (msg, attrs) => log("info", console.info, msg, attrs),
    warn: (msg, attrs) => log("warn", console.warn, msg, attrs),
    error: (msg, attrs) => log("error", console.error, msg, attrs),
  };
}
