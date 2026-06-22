/**
 * Server-side networking entry point. Re-exports every browser-safe
 * URL helper from {@link ./net.browser.ts} verbatim so the `netUtils`
 * namespace exposes the same URL surface from either entry point;
 * server-only (node) helpers belong here.
 */

export * from "./net.browser.js";
