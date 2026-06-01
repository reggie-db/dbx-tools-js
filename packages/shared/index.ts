/**
 * Shared helpers for AppKit plugins: typed sibling lookup, HTTP header
 * and cookie parsing, string case helpers, console log prefixes, and
 * project introspection.
 *
 * Each utility module is exposed as a namespace so consumers write
 * `httpUtils.parseCookies(req)` without colliding with similarly-named
 * helpers from other packages. Types come along with the namespace
 * (e.g. `httpUtils.HeaderInput`, `logUtils.Logger`).
 */
export * as commonUtils from "./src/common.js";
export * as httpUtils from "./src/http.js";
export * as logUtils from "./src/log.js";
export * as pluginUtils from "./src/plugin.js";
export * as projectUtils from "./src/project.js";
export * as stringUtils from "./src/string.js";
