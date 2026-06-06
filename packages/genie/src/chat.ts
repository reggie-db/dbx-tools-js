/**
 * `@dbx-tools/genie` chat driver.
 *
 * Two layers ship from this file:
 *
 *   - {@link genieChatRun}: low-level async generator. Drives one
 *     or many turns of a Databricks Genie conversation and yields
 *     every poll-observed `GenieMessage` verbatim. Cancellation,
 *     conversation threading, distinct-filtering, and SDK quirks
 *     (Waiter stripping) all live here. Use directly when you want
 *     the raw stream.
 *   - {@link genieChat} / {@link GenieChat}: high-level handle.
 *     Wraps `genieChatRun` and emits semantic, deduplicated events
 *     so consumers can subscribe to the bits they care about
 *     without re-walking `GenieMessage.attachments[]` on every
 *     poll. Full event vocabulary:
 *
 *       - `message`: raw `GenieMessage` snapshot.
 *       - `status`: top-level status transition (e.g.
 *         `ASKING_AI` -> `PENDING_WAREHOUSE`).
 *       - `attachment`: new slot in `attachments[]`.
 *       - `thinking`: new reasoning step on a query attachment.
 *       - `text`: text-attachment content changed.
 *       - `query`: SQL was finalized on a query attachment.
 *       - `statement`: SQL submitted to a warehouse (statement
 *         id assigned).
 *       - `rows`: query row count changed.
 *       - `suggested_questions`: follow-up suggestions appeared.
 *       - `result`: turn reached a terminal status.
 *
 *     Errors propagate via `run()`'s promise rejection - there is
 *     no `"error"` event.
 *
 * Pick the layer that matches your consumer. Iterating UI / agent
 * code that wants every message verbatim should use
 * `genieChatRun`. Subscribers that want to react to "Genie is
 * thinking about X" or "Genie produced text Y" should use
 * `genieChat`.
 */

import { WorkspaceClient } from "@databricks/sdk-experimental";
import { apiUtils, commonUtils } from "@dbx-tools/shared";
import { GenieEventEmitter } from "./event.js";
import { isTerminalStatus, type GenieMessage } from "./protocol.js";

/* -------------------------- shared options -------------------------- */

/** Options accepted by both {@link genieChatRun} and {@link genieChat}. */
export interface GenieChatOptions {
  /**
   * Seed conversation id. When set, the first turn appends to this
   * conversation (via `createMessage`) instead of opening a new
   * one. When unset, the first turn opens a new conversation; the
   * generator tracks the id internally and reuses it across every
   * subsequent turn pulled from `contents`.
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

/* ---------------------- low-level: genieChatRun --------------------- */

/**
 * Multi-turn chat against a Genie space, yielded as a stream of
 * `GenieMessage` snapshots. One turn per item pulled from
 * `contents` (a single `string`, an `Iterable<string>`, or an
 * `AsyncIterable<string>`).
 *
 * Conversation lifecycle:
 *
 *   - First turn: open a new conversation via
 *     `client.genie.startConversation`, or reuse
 *     `options.conversationId` if the caller seeded one.
 *   - Subsequent turns: append to the same conversation via
 *     `client.genie.createMessage`.
 *   - Within a turn: poll `client.genie.getMessage` every
 *     `options.pollIntervalMs` (default 500ms) until the message
 *     reaches a terminal status. The terminal message is yielded;
 *     then either the next input is pulled or the generator
 *     returns.
 *
 * Cancellation: a single internal `AbortController` covers the
 * whole run. `options.context` is tied into that controller so an
 * external abort tears down every in-flight SDK call AND the
 * inter-poll sleep. Breaking out of the `for await` does the same
 * via the `try / finally`.
 *
 * @example
 * for await (const m of genieChatRun(spaceId, "Top 5 stores?")) render(m);
 */
export async function* genieChatRun(
  space_id: string,
  contents: AsyncIterable<string> | Iterable<string> | string,
  options?: GenieChatOptions,
): AsyncGenerator<GenieMessage, void, void> {
  const controller = new AbortController();
  try {
    const client = await getWorkspaceClient(options);
    // Build the SDK Context ONCE per call. Building it inside the
    // poll producer would re-attach an abort listener to
    // `options.context` on every poll iteration (via
    // `apiUtils.toContext` -> `tieAbortSignal`), eventually
    // tripping Node's `MaxListenersExceededWarning`.
    const context = apiUtils.toContext(controller, options?.context);
    const items = typeof contents === "string" ? [contents] : contents;
    // Conversation id is shared across every turn in this run, so
    // it lives outside the per-turn loop. `let` so the poll
    // producer can write back the id Genie hands us on the first
    // turn; subsequent turns then take the `createMessage` branch
    // instead of opening a fresh conversation.
    let conversationId = options?.conversationId;
    for await (const content of items) {
      // Message id is per turn: each turn creates exactly one new
      // Genie message and then polls it to completion.
      let messageId: string | undefined;
      const pollProducer = async (
        ctx: commonUtils.PollContext<GenieMessage>,
      ): Promise<GenieMessage> => {
        if (!conversationId) {
          // First poll of the first turn: open the conversation.
          // Refuse to retry: if `startConversation` returned a
          // response without a `conversation_id`, retrying would
          // just open conversation after conversation.
          if (ctx.attempt > 0) {
            throw new Error(
              "Genie did not return a conversation id; refusing to retry",
            );
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
          // First poll of a follow-up turn: append to the existing
          // conversation. `client.genie.createMessage` returns a
          // `Waiter<GenieMessage>` (`{ ...message, wait: async () =>
          // ... }`). Strip `wait` here so downstream serializers
          // (e.g. yaml.stringify in poll-chat) don't choke on the
          // AsyncFunction value.
          const { wait: _wait, ...createResponse } =
            await client.genie.createMessage(
              { space_id, conversation_id: conversationId, content },
              context,
            );
          messageId = createResponse.message_id;
          return createResponse;
        }
        // Subsequent polls within a turn: re-fetch the current
        // message until its status becomes terminal.
        return await client.genie.getMessage(
          {
            space_id,
            conversation_id: conversationId,
            message_id: messageId,
          },
          context,
        );
      };
      const pollOptions: commonUtils.PollOptions<GenieMessage> = {
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
        // (or external abort) tears down promptly instead of
        // waiting out the interval.
        signal: controller.signal,
      };
      for await (const message of commonUtils.poll(pollProducer, pollOptions)) {
        yield message;
      }
    }
  } finally {
    // Cancels any still-pending SDK call and the inter-poll sleep
    // whether we're unwinding from a normal return, a consumer
    // break, or a thrown error. Idempotent.
    controller.abort();
  }
}

/* ----------------------- high-level: GenieChat ---------------------- */

/**
 * High-level chat handle. Wraps {@link genieChatRun} and pipes
 * every yielded snapshot into the inherited {@link GenieEventEmitter},
 * which derives semantic events (`status`, `attachment`,
 * `thinking`, `text`, `query`, `statement`, `rows`,
 * `suggested_questions`, `result`) plus the raw `message`. Use
 * the inherited `on` / `once` / `off` to subscribe.
 *
 * Single-shot: each `run()` consumes the constructor-supplied
 * `contents` once. To start another conversation, build a new
 * instance.
 *
 * @example
 * const chat = genieChat(spaceId, "Top 5 stores by revenue?");
 * chat.on("thinking", (e) => console.log("[thinking]", e.thought_type, e.text));
 * chat.on("text", (e) => console.log("[text]", e.text));
 * chat.once("result", (e) => console.log("[done]", e.status));
 * await chat.run();
 */
export class GenieChat extends GenieEventEmitter {
  constructor(
    public readonly space_id: string,
    private readonly contents: AsyncIterable<string> | Iterable<string> | string,
    private readonly options?: GenieChatOptions,
  ) {
    super();
  }

  /**
   * Drive the underlying {@link genieChatRun} to completion,
   * pushing every yielded snapshot into the inherited emitter.
   * Resolves when the input iterable is exhausted and the last
   * turn reaches a terminal status; rejects with the underlying
   * error if `genieChatRun` throws. There is no `"error"` event -
   * wrap the `await` in `try`/`catch` if you need to handle
   * failures.
   */
  async run(): Promise<void> {
    for await (const message of genieChatRun(
      this.space_id,
      this.contents,
      this.options,
    )) {
      this.push(message);
    }
  }
}

/** Factory for {@link GenieChat}. Identical to `new GenieChat(...)`. */
export function genieChat(
  space_id: string,
  contents: AsyncIterable<string> | Iterable<string> | string,
  options?: GenieChatOptions,
): GenieChat {
  return new GenieChat(space_id, contents, options);
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
