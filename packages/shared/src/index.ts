/**
 * Shared helpers for AppKit plugins: typed sibling lookup, HTTP header
 * and cookie parsing, string case helpers, and console log prefixes.
 *
 * Each utility module is re-exported as a namespace so consumers can write
 * `httpUtils.parseCookies(req)` without colliding with similarly-named
 * helpers from other packages. Types come along with the namespace (e.g.
 * `httpUtils.HeaderInput`, `logUtils.Logger`).
 */
export * from "./common.js";
export * as commonUtils from "./common.js";
export * as pluginUtils from "./plugin.js";
export * as stringUtils from "./string.js";
export * as logUtils from "./log.js";
export * as httpUtils from "./http.js";
