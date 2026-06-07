/**
 * `@dbx-tools/genie` public surface.
 *
 *   - {@link genieChat}: low-level async generator. Yields every
 *     poll-observed `GenieMessage` for a single turn against a
 *     Genie space. Multi-turn conversations are driven by the
 *     caller (thread the `conversation_id` off each yielded
 *     message into the next call's `options.conversationId`).
 *   - {@link genieEventChat}: high-level async generator. Drives
 *     `genieChat` and yields a strongly-typed
 *     {@link GenieChatEvent} stream of flat `{type, ...fields}`
 *     records (`message`, `status`, `attachment`, `thinking`,
 *     `text`, `query`, `statement`, `rows`,
 *     `suggested_questions`, `result`). The final yield for any
 *     terminal turn is always `{ type: "result", ... }`.
 *
 * Wire-format types, the {@link GenieChatEvent} discriminated
 * union, per-event detectors (`detectStatus`, `detectThinking`,
 * `detectAttachmentAdded`, `detectText`, `detectQuery`,
 * `detectStatement`, `detectRows`, `detectSuggestedQuestions`),
 * the `eventsFromMessage` sync generator, and terminal-status
 * helpers all live in `@dbx-tools/genie-shared` and are
 * re-exported here so a single `from "@dbx-tools/genie"` import
 * works for server-side consumers. Browser-side consumers should
 * import from `@dbx-tools/genie-shared` directly to avoid pulling
 * in the Node-only `chat.ts` runtime.
 *
 * Browser safety: `chat.ts` pulls in `WorkspaceClient` and is
 * Node-only; the re-exports from `@dbx-tools/genie-shared` are
 * pure (types + sync functions) and safe for any runtime.
 */

export * from "./src/chat.js";
export * from "@dbx-tools/genie-shared";
