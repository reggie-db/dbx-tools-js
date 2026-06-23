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
export * from "./src/config.js";
export * from "./src/email-html.js";
export * from "./src/markdown.js";
export * from "./src/outbox.js";
export * from "./src/plugin.js";
export * from "./src/sender.js";
export * from "./src/tool.js";
export * from "./src/transport.js";
