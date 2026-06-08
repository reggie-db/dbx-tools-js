/**
 * `@dbx-tools/genie-shared`: pure-types + sync-helpers surface of
 * the `@dbx-tools/genie` package. Safe to import from browser
 * bundles (no `node:*`, no `WorkspaceClient`, no I/O).
 *
 * What lives here:
 *
 *   - {@link ./src/protocol.js}: wire-format zod schemas + types
 *     extending the generated `@dbx-tools/sdk-shared` Genie shapes
 *     (`GenieMessageSchema`, `GenieAttachmentSchema`,
 *     `GenieQueryAttachmentSchema`, `GenieThoughtSchema`,
 *     `MessageStatusSchema`, ...) plus the high-level event
 *     vocabulary the `genieEventChat` driver emits
 *     (`GenieChatEvent`, `GenieChatLocation`, per-variant payload
 *     interfaces) and terminal-status / attachment-discriminator
 *     helpers (`TERMINAL_STATUSES`, `isTerminalStatus`,
 *     `detectAttachmentType`, `tagAttachment`).
 *   - {@link ./src/event.js}: pure sync detectors
 *     (`detectStatus`, `detectThinking`, `detectAttachmentAdded`,
 *     `detectText`, `detectQuery`, `detectStatement`,
 *     `detectRows`, `detectSuggestedQuestions`) and the
 *     `eventsFromMessage` orchestrator generator. Used by
 *     `genieEventChat` server-side; also reusable from the
 *     browser when consumers want to derive UI events from
 *     `GenieMessage` snapshots themselves.
 *
 * Server-only chat driving (`genieChat`, `genieEventChat`) lives
 * in `@dbx-tools/genie` and pulls these types in. Frontends only
 * need this package.
 */

export * from "./src/event.js";
export * from "./src/protocol.js";
