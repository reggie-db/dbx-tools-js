/**
 * Server-side entry point for `@dbx-tools/appkit-email`. Bundles the
 * SMTP runtime, the approval-gated `send_email` Mastra tool, the
 * on-behalf-of sender derivation, and the AppKit `email` plugin, plus a
 * re-export of the pure `@dbx-tools/appkit-email-shared` contract so a
 * single server-side import covers both the wire types and the logic.
 *
 * Browser consumers (e.g. the approval UI) should import the contract
 * from `@dbx-tools/appkit-email-shared` directly - this entry pulls in
 * nodemailer and AppKit server APIs and is Node-only.
 */
export * from "@dbx-tools/appkit-email-shared";
export * from "./config.js";
export * from "./email-html.js";
export * from "./markdown.js";
export * from "./outbox.js";
export * from "./plugin.js";
export * from "./sender.js";
export * from "./tool.js";
export * from "./transport.js";
