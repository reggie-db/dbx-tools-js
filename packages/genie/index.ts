/**
 * `@dbx-tools/genie` public surface.
 *
 *   - {@link genieChat} / {@link GenieChat}: high-level chat handle
 *     with a typed event surface (`status`, `attachment`,
 *     `thinking`, `text`, `query`, `statement`, `rows`,
 *     `suggested_questions`, `result`, plus raw `message`). Wraps
 *     the iterator with deduplicated, semantic events.
 *   - {@link genieChatRun}: low-level async generator that drives
 *     one or many turns and yields every poll-observed
 *     `GenieMessage` verbatim. Use when you want the raw stream
 *     and don't need the event surface.
 *   - {@link emitChatEvents} + per-event detectors (`detectStatus`,
 *     `detectThinking`, `detectAttachmentAdded`, `detectText`,
 *     `detectQuery`, `detectStatement`, `detectRows`,
 *     `detectSuggestedQuestions`): pure typed `{ type, detect }`
 *     objects for consumers that want to derive events from
 *     snapshots themselves (custom dispatch surface, unit testing,
 *     alternative transports).
 *   - Wire-format types derived structurally from
 *     `@databricks/sdk-experimental` (`apis/dashboards`), widened
 *     with `thoughts[]` and `auto_regenerate_count` which Genie
 *     returns on the wire but the SDK doesn't currently type.
 *   - Terminal-status helpers (`TERMINAL_STATUSES`,
 *     `isTerminalStatus`) and the attachment-type helper
 *     (`detectAttachmentType`).
 *
 * Browser safety: `./src/protocol.js` and `./src/event.js` are
 * pure (types + functions, no Node-only imports), safe for any
 * runtime. `./src/chat.js` pulls in `WorkspaceClient` and
 * `node:events`, Node-only.
 */

export * from "./src/chat.js";
export * from "./src/event.js";
export * from "./src/protocol.js";
