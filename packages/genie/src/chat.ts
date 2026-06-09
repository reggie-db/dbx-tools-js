/**
 * `@dbx-tools/genie` chat driver.
 *
 * Drives a single turn against a Genie space from one `content`
 * string; multi-turn conversations are the caller's job (thread
 * the `conversation_id` returned on each `GenieMessage` back into
 * the next turn's `options.conversationId`).
 *
 * Two layers serve two kinds of consumer. The low-level layer
 * yields every poll-observed `GenieMessage` verbatim and owns the
 * messy parts - cancellation, conversation seeding,
 * distinct-filtering, and SDK quirks (Waiter stripping); reach for
 * it when you want the raw stream. The high-level layer wraps it
 * and emits semantic, deduplicated `{ type, payload }` events
 * (see {@link GenieChatEvent}), always closing a successful turn
 * with a terminal `result` event carrying the final
 * `GenieMessage`; errors propagate by throwing, with no `error`
 * variant. Iterating UI / agent code that wants every message
 * verbatim takes the low-level stream; subscribers reacting to
 * "Genie is thinking about X" or "Genie produced text Y" take the
 * event layer.
 */

import { WorkspaceClient } from "@databricks/sdk-experimental";
import {
  eventsFromMessage,
  isTerminalStatus,
  type GenieChatEvent,
  type GenieMessage,
} from "@dbx-tools/genie-shared";
import { apiUtils, commonUtils } from "@dbx-tools/shared";

/* -------------------------- shared options -------------------------- */

/** Options accepted by both {@link genieChat} and {@link genieEventChat}. */
export interface GenieChatOptions {
  /**
   * Seed conversation id. When set, this turn appends to the
   * existing conversation (via `createMessage`) instead of opening
   * a new one. Use it to thread a multi-turn conversation: read
   * `conversation_id` off the prior turn's terminal `GenieMessage`
   * (or the `result` event's `payload.conversation_id`) and pass
   * it into the next call.
   */
  conversationId?: string;
  /**
   * Explicit `WorkspaceClient`. Defaults to AppKit's per-request
   * execution-context client when AppKit is installed and we're
   * inside a request; falls back to a fresh `new WorkspaceClient({})`
   * (env-var auth) otherwise.
   */
  workspaceClient?: WorkspaceClient;
  /** Poll cadence in milliseconds between successive `getMessage` calls (default 500). */
  pollIntervalMs?: number;
  /**
   * External cancellation. Accepts a WHATWG `AbortSignal` or a
   * fully-built SDK `Context` (see `apiUtils.ContextLike`).
   * Aborting it cancels every in-flight SDK call and the next
   * inter-poll sleep.
   */
  context?: apiUtils.ContextLike;
}

/* ----------------------- low-level: genieChat ----------------------- */

/**
 * One turn against a Genie space, yielded as a stream of
 * `GenieMessage` snapshots.
 *
 * Turn lifecycle:
 *
 *   - No `options.conversationId`: open a new conversation via
 *     `client.genie.startConversation`. The opened conversation id
 *     surfaces on every yielded `GenieMessage` (`.conversation_id`)
 *     so the caller can thread it into a follow-up call.
 *   - With `options.conversationId`: append to that conversation
 *     via `client.genie.createMessage`.
 *   - In both cases, after the create/start the driver polls
 *     `client.genie.getMessage` every `options.pollIntervalMs`
 *     (default 500ms) until the message reaches a terminal
 *     status, then yields the terminal snapshot and returns.
 *
 * Cancellation: a single internal `AbortController` covers the
 * whole turn. `options.context` is tied into that controller so an
 * external abort tears down every in-flight SDK call AND the
 * inter-poll sleep. Breaking out of the `for await` does the same
 * via the `try / finally`.
 *
 * @example
 * // Single turn.
 * for await (const m of genieChat(spaceId, "Top 5 stores?")) {
 *   render(m);
 * }
 *
 * @example
 * // Multi-turn: caller threads the conversation id.
 * let conversationId: string | undefined;
 * for (const question of questions) {
 *   for await (const m of genieChat(spaceId, question, { conversationId })) {
 *     conversationId = m.conversation_id ?? conversationId;
 *     render(m);
 *   }
 * }
 */
export async function* genieChat(
  space_id: string,
  content: string,
  options?: GenieChatOptions,
): AsyncGenerator<GenieMessage, void, void> {
  const controller = new AbortController();
  try {
    const client = await getWorkspaceClient(options);
    // Build the SDK Context ONCE. Building it inside the poll
    // producer would re-attach an abort listener to
    // `options.context` on every poll iteration (via
    // `apiUtils.toContext` -> `tieAbortSignal`), eventually
    // tripping Node's `MaxListenersExceededWarning`.
    const context = apiUtils.toContext(controller, options?.context);
    let conversationId = options?.conversationId;
    let messageId: string | undefined;

    const pollProducer = async (
      ctx: commonUtils.PollContext<GenieMessage>,
    ): Promise<GenieMessage> => {
      if (!conversationId) {
        // First poll: open the conversation. Refuse to retry: if
        // `startConversation` returned a response without a
        // `conversation_id`, retrying would just open conversation
        // after conversation.
        if (ctx.attempt > 0) {
          throw new Error("Genie did not return a conversation id; refusing to retry");
        }
        const startResponse = await client.genie.startConversation(
          { space_id, content },
          context,
        );
        conversationId = startResponse.conversation_id;
        messageId = startResponse.message_id;
        return startResponse.message!;
      }
      if (!messageId) {
        // First poll of a follow-up turn: append to the seeded
        // conversation. `client.genie.createMessage` returns a
        // `Waiter<GenieMessage>` (`{ ...message, wait: async () =>
        // ... }`). Strip `wait` here so downstream serializers
        // (e.g. yaml.stringify in poll-chat) don't choke on the
        // AsyncFunction value.
        const { wait: _wait, ...createResponse } = await client.genie.createMessage(
          { space_id, conversation_id: conversationId, content },
          context,
        );
        messageId = createResponse.message_id;
        return createResponse;
      }
      // Subsequent polls: re-fetch the current message until its
      // status becomes terminal.
      return await client.genie.getMessage(
        {
          space_id,
          conversation_id: conversationId,
          message_id: messageId,
        },
        context,
      );
    };

    yield* commonUtils.poll(pollProducer, {
      intervalMs: options?.pollIntervalMs ?? 500,
      // Skip yielding identical consecutive snapshots; Genie
      // often returns the exact same payload twice during quiet
      // periods. `poll` does a deep equal on the previous yield.
      filter: "distinct",
      // Stop after the terminal message is yielded. `poll` checks
      // the predicate AFTER yielding, so the terminal message
      // still reaches the consumer.
      predicate: (m) => !isTerminalStatus(m.status),
      // Wake the inter-poll sleep on abort so a `for await` break
      // (or external abort) tears down promptly instead of waiting
      // out the interval.
      signal: controller.signal,
    });
  } finally {
    // Cancels any still-pending SDK call and the inter-poll sleep
    // whether we're unwinding from a normal return, a consumer
    // break, or a thrown error. Idempotent.
    controller.abort();
  }
}

/* ---------------------- high-level: genieEventChat ------------------ */

/**
 * One turn against a Genie space, yielded as a typed
 * {@link GenieChatEvent} stream. Drives {@link genieChat}
 * underneath and decorates each snapshot with the derived events
 * the field-level diff produced. Stream order:
 *
 *   1. `{ type: "message", message }` - the raw `GenieMessage`,
 *      once per poll yield.
 *   2. `{ type: "question", content, message_id, ... }` fires
 *      exactly once, on the FIRST `message` yield. We read
 *      `content` and `message_id` straight off the snapshot so
 *      every downstream event for this turn shares the same
 *      `message_id` (the question included) - subscribers can
 *      group everything for one Genie call under that one key.
 *   3. Any of `status` / `attachment` / `thinking` / `text` /
 *      `query` / `statement` / `rows` / `suggested_questions` the
 *      diff against the prior snapshot produced.
 *   4. On the terminal snapshot, `{ type: "result", ... }` as
 *      the final yield.
 *
 * Errors propagate by the generator throwing - there's no
 * `"error"` variant. Wrap the `for await` in `try/catch` if you
 * need to handle failures.
 *
 * @example
 * for await (const event of genieEventChat(spaceId, "Top stores?")) {
 *   switch (event.type) {
 *     case "thinking":
 *       console.log("[thinking]", event.thought_type, event.text);
 *       break;
 *     case "text":
 *       console.log("[text]", event.text);
 *       break;
 *     case "result":
 *       console.log("[done]", event.status);
 *       break;
 *   }
 * }
 */
export async function* genieEventChat(
  space_id: string,
  content: string,
  options?: GenieChatOptions,
): AsyncGenerator<GenieChatEvent, void, void> {
  // Diff source for the current turn. Always `undefined` on the
  // first snapshot so the initial status / attachments emit
  // fresh; updated to the most recent snapshot after each yield.
  let previous: GenieMessage | undefined;
  // The `question` event is deferred to the first `message` yield
  // so it can carry the assigned `message_id` (subscribers use it
  // as the grouping key for every event in this turn). The first
  // snapshot is the earliest point that id exists.
  let questionEmitted = false;
  for await (const rawMessage of genieChat(space_id, content, options)) {
    // Normalize `message_id` from the legacy `id` field when Genie's
    // wire response only populates one of them. The SDK schema marks
    // both as required, but in practice the `startConversation` /
    // `createMessage` inner `message` payload sometimes ships only
    // `id` while the new `message_id` field lands undefined. Every
    // downstream event detector keys grouping off `message_id`; the
    // fallback keeps one Genie turn's events from splitting across
    // an anon group + the real-id group when subscribers bucket by
    // `message_id` (see `summarizeProgress` in the demo UI).
    const message: GenieMessage = rawMessage.message_id
      ? rawMessage
      : { ...rawMessage, message_id: rawMessage.id };
    yield {
      type: "message",
      space_id: message.space_id,
      message_id: message.message_id,
      message,
    };
    if (!questionEmitted) {
      yield {
        type: "question",
        space_id: message.space_id,
        ...(message.conversation_id
          ? { conversation_id: message.conversation_id }
          : {}),
        ...(message.message_id ? { message_id: message.message_id } : {}),
        content: message.content,
      };
      questionEmitted = true;
    }
    yield* eventsFromMessage(message, previous, message.space_id);
    if (isTerminalStatus(message.status)) {
      yield {
        type: "result",
        space_id: message.space_id,
        conversation_id: message.conversation_id,
        message_id: message.message_id,
        status: message.status,
        message,
      };
    }
    previous = message;
  }
}

/* ---------------------- workspace client helper --------------------- */

/**
 * Resolve a `WorkspaceClient` in this preference order:
 *
 *   1. Caller-supplied `options.workspaceClient`.
 *   2. AppKit's per-request execution-context client, when AppKit
 *      is installed AND we're inside a request scope.
 *   3. Fresh `new WorkspaceClient({})` (env-var auth via
 *      `DATABRICKS_CONFIG_PROFILE` / `DATABRICKS_HOST` /
 *      `DATABRICKS_TOKEN`).
 *
 * AppKit is loaded lazily so this package stays usable in
 * non-AppKit environments (e.g. the `poll-chat` smoke test).
 */
async function getWorkspaceClient(
  options?: GenieChatOptions,
): Promise<WorkspaceClient> {
  if (options?.workspaceClient) return options.workspaceClient;
  const appkit = await getAppKit();
  if (appkit) {
    try {
      return appkit.getExecutionContext().client;
    } catch {
      // Not inside an AppKit request context; fall through to env.
    }
  }
  return new WorkspaceClient({});
}

async function getAppKit() {
  try {
    return await import("@databricks/appkit");
  } catch {
    return undefined;
  }
}
