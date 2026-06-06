/**
 * Polling-based Genie conversation runner exposed as an async
 * generator over the {@link GenieEvent} discriminated union.
 *
 * Mirrors the AppKit `genie` plugin's `streamSendMessage`
 * lifecycle end-to-end - start (or follow-up) a conversation,
 * poll the `/messages/{id}` endpoint until it reaches a terminal
 * status, optionally fetch the per-attachment SQL `data_array`
 * via `getMessageAttachmentQueryResult` - but exposes every
 * delta the raw wire reveals (status transitions, attachment
 * additions, statement ids, query descriptions / SQL, `thoughts[]`,
 * text and suggested-question attachments) rather than collapsing
 * everything into one final `message_result`.
 *
 * Designed for `AbortSignal`-cancelled SSE / streaming consumers:
 *
 *   const ac = new AbortController();
 *   for await (const event of streamGenie({ client, spaceId, question, signal: ac.signal })) {
 *     // forward `event` over SSE, log it, accumulate state, ...
 *     if (event.type === GenieEventType.TERMINAL) break;
 *   }
 *
 * Cancellation: when the caller's `signal` aborts (or the consumer
 * breaks out of the `for await`), every in-flight SDK call is
 * cancelled and the generator returns. Two internal AbortControllers
 * power this:
 *
 * - `mainController`: tied to the caller's `signal`. Drives the
 *   initial `startConversation` / `createMessage` request and every
 *   subsequent `getMessage` poll.
 * - `fetchController`: tied to `mainController.signal`. Drives the
 *   per-attachment `getMessageAttachmentQueryResult` calls. Kept
 *   separate so future code can abort the row fetches independently
 *   of the main poll loop (e.g. on terminal=FAILED, abandon any
 *   in-flight "on-next" fetches without waiting for them).
 *
 * Both signals are bridged to the SDK via the
 * {@link signalToCancellationToken} adapter and handed in through
 * a fresh `Context({ cancellationToken })` per call - which is the
 * SDK's documented cancellation hook (`api-client.ts` wires
 * `cancellationToken.onCancellationRequested` straight to the
 * underlying `fetch`'s `AbortController`).
 *
 * Polling cadence is caller-controlled (`pollIntervalMs`, default
 * 500ms) and runs straight against `WorkspaceClient.genie.getMessage`
 * instead of the SDK's built-in `Waiter`, so a single tick can't
 * merge multiple wire updates and thoughts / mid-stream attachments
 * don't get hidden behind coarser status callbacks.
 *
 * The caller passes in a constructed `WorkspaceClient` so auth
 * (PAT / OAuth / OBO) is whatever the consumer already wired up;
 * this package never touches `.databrickscfg` or env-var resolution
 * directly.
 */

import {
  Context,
  type CancellationToken,
  type WorkspaceClient,
} from "@databricks/sdk-experimental";

import {
  GenieEventType,
  isTerminalStatus,
  type GenieAttachment,
  type GenieEvent,
  type GenieEventOf,
  type GenieMessage,
  type GenieThought,
  type MessageError,
  type MessageStatus,
  type StatementResponse,
  type TerminalStatus,
} from "./protocol.js";

/**
 * Mode controlling when the runner fetches the actual SQL
 * `data_array` rows for query attachments.
 *
 * - `"on-next"`: as soon as a new `statement_id` is seen on a
 *   query attachment, kick off `getMessageAttachmentQueryResult`
 *   in the background. The corresponding `queryResult` event is
 *   yielded on the next loop turn after the fetch settles
 *   (interleaved with later `status` transitions). Lowest
 *   latency, but the warehouse may still be `PENDING_WAREHOUSE` /
 *   `EXECUTING_QUERY` and the fetch can error or return an empty
 *   result; failures yield `queryError`.
 * - `"on-complete"`: wait until the message reaches a terminal
 *   status, then fetch each query attachment serially after the
 *   `terminal` event. Mirrors the AppKit plugin's `emitQueryResults`.
 * - `"never"`: never fetch. Consumers can call
 *   `client.genie.getMessageAttachmentQueryResult` themselves
 *   if they want rows.
 */
export type GenieFetchRowsMode = "on-next" | "on-complete" | "never";

/** Options accepted by {@link streamGenie}. */
export interface RunGenieOptions {
  /** Caller-owned SDK client; the service never constructs one. */
  client: WorkspaceClient;
  /** Genie space the conversation lives in. */
  spaceId: string;
  /** Natural-language question to send. */
  question: string;
  /**
   * Optional conversation id. Omit on the first turn (the service
   * issues `startConversation`); pass to follow up on an existing
   * thread (the service issues `createMessage`).
   */
  conversationId?: string;
  /**
   * Poll cadence against `getMessage`. Default 500ms. Set higher
   * for chatty UIs that don't need sub-second updates; the
   * absolute floor below which Genie has been observed to dedupe
   * server-side is around 250ms.
   */
  pollIntervalMs?: number;
  /**
   * Caller cancellation. Aborting this signal cancels every
   * in-flight SDK call and returns from the generator. The
   * generator's `finally` also fires on consumer `break` / `throw`,
   * so an unaborted signal isn't required for clean shutdown.
   */
  signal?: AbortSignal;
  /** When to fetch rows. Default `"on-complete"`. */
  fetchRows?: GenieFetchRowsMode;
}

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_FETCH_ROWS: GenieFetchRowsMode = "on-complete";

/* ------------------------- helpers (internal) ------------------------- */

/**
 * Adapt a WHATWG `AbortSignal` to the Databricks SDK's
 * `CancellationToken` interface. The SDK's `api-client.ts`
 * internally creates an `AbortController` and wires
 * `cancellationToken.onCancellationRequested` to it, so this
 * adapter is the one-line bridge from "platform-standard
 * cancellation" to "the SDK aborts the fetch on your behalf".
 *
 * Kept private for now: the genie package is the only consumer in
 * the workspace. Lift to `@dbx-tools/shared` (`apiUtils`) the
 * moment a second package needs SDK-call cancellation.
 */
function signalToCancellationToken(signal: AbortSignal): CancellationToken {
  return {
    get isCancellationRequested() {
      return signal.aborted;
    },
    onCancellationRequested(cb) {
      if (signal.aborted) {
        cb(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => cb(signal.reason), { once: true });
    },
  };
}

/** Build a fresh SDK `Context` carrying a cancellation token derived from `signal`. */
function ctxFor(signal: AbortSignal): Context {
  return new Context({ cancellationToken: signalToCancellationToken(signal) });
}

/**
 * Tie a child `AbortController` to a parent signal. The child
 * aborts whenever the parent aborts; aborting the child does not
 * affect the parent (so a fetch-level cancel doesn't tear down the
 * main poll loop).
 */
function tieController(child: AbortController, parent: AbortSignal): void {
  if (parent.aborted) {
    child.abort(parent.reason);
    return;
  }
  parent.addEventListener("abort", () => child.abort(parent.reason), {
    once: true,
  });
}

/**
 * `setTimeout`-backed sleep that resolves early on abort. Lets the
 * poll loop hot-exit without waiting out the full poll interval.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Stable internal key for an attachment. Uses the wire's
 * `attachment_id` when present, falls back to a synthetic
 * `__idx_<n>__` based on the array index so two anonymous
 * attachments at different positions don't collide.
 */
function attachmentKey(att: GenieAttachment, index: number): string {
  return att.attachment_id ?? `__idx_${index}__`;
}

/**
 * Per-attachment scratch tracking last-seen scalar fields plus a
 * fingerprint set for thoughts. Used by {@link dispatchDeltas} to
 * dedupe diff events without re-walking the entire prior message.
 */
interface AttachmentScratch {
  statementId?: string;
  description?: string;
  sql?: string;
  text?: string;
  suggestedQuestionsKey?: string;
  rowCount?: number;
  thoughtKeys: Set<string>;
}

/**
 * Mutable accreted state carried across `dispatchDeltas` invocations.
 * Kept inside the {@link streamGenie} closure - the generator owns
 * it for the lifetime of one conversation turn.
 */
interface RunState {
  lastStatus: MessageStatus | undefined;
  attachments: Map<string, GenieAttachment>;
  statementIds: Set<string>;
  thoughts: Map<string, GenieThought[]>;
  errorKey: string | undefined;
  scratch: Map<string, AttachmentScratch>;
}

function newScratch(): AttachmentScratch {
  return { thoughtKeys: new Set<string>() };
}

function getScratch(state: RunState, key: string): AttachmentScratch {
  let s = state.scratch.get(key);
  if (!s) {
    s = newScratch();
    state.scratch.set(key, s);
  }
  return s;
}

/**
 * Walk one polled `GenieMessage` and yield every delta event the
 * payload implies (raw, updated, status, attachment, statement_id,
 * description, sql, thought, text, suggested_questions, row_count,
 * message_error). Pure generator: no I/O, no side effects beyond
 * mutating the shared {@link RunState} for dedupe scratch.
 *
 * Background row fetches are NOT kicked off here - the outer
 * generator inspects each yielded `statementId` event and triggers
 * the fetch as a side effect when `fetchRows === "on-next"`.
 * Keeping I/O out of this helper makes the event-shape logic
 * self-contained and easy to test in isolation.
 */
function* dispatchDeltas(
  current: GenieMessage,
  prev: GenieMessage | undefined,
  state: RunState,
): Generator<GenieEvent> {
  yield { type: GenieEventType.RAW, message: current };

  if (prev && JSON.stringify(prev) !== JSON.stringify(current)) {
    yield { type: GenieEventType.UPDATED, message: current, prev };
  }

  if (current.status && current.status !== state.lastStatus) {
    const prevStatus = state.lastStatus;
    state.lastStatus = current.status;
    yield {
      type: GenieEventType.STATUS,
      message: current,
      status: current.status,
      prev: prevStatus,
    };
  }

  const attachments = current.attachments ?? [];
  for (let i = 0; i < attachments.length; i++) {
    const attachment = attachments[i]!;
    const key = attachmentKey(attachment, i);
    // Only set the public-facing attachmentId field when the wire
    // actually carries one. Consumers wanting to address an
    // anonymous attachment can correlate by `index` from the
    // `attachment` event.
    const publicId = attachment.attachment_id;

    if (!state.attachments.has(key)) {
      yield {
        type: GenieEventType.ATTACHMENT,
        message: current,
        attachment,
        index: i,
      };
    }
    state.attachments.set(key, attachment);
    const local = getScratch(state, key);

    // Query attachments: statement id, sql, description, thoughts, row count.
    const query = attachment.query;
    if (query) {
      if (query.statement_id && query.statement_id !== local.statementId) {
        local.statementId = query.statement_id;
        state.statementIds.add(query.statement_id);
        yield {
          type: GenieEventType.STATEMENT_ID,
          message: current,
          statementId: query.statement_id,
          ...(publicId ? { attachmentId: publicId } : {}),
        };
      }
      if (query.description && query.description !== local.description) {
        local.description = query.description;
        yield {
          type: GenieEventType.DESCRIPTION,
          message: current,
          description: query.description,
          ...(publicId ? { attachmentId: publicId } : {}),
          ...(query.statement_id ? { statementId: query.statement_id } : {}),
        };
      }
      if (query.query && query.query !== local.sql) {
        local.sql = query.query;
        yield {
          type: GenieEventType.SQL,
          message: current,
          sql: query.query,
          ...(publicId ? { attachmentId: publicId } : {}),
          ...(query.statement_id ? { statementId: query.statement_id } : {}),
        };
      }
      for (const thought of query.thoughts ?? []) {
        // Dedupe key folds in type + content; a thought that
        // mutates (`DATA_SOURCING` -> `DESCRIPTION` with new
        // content, observed in the wild) emits a fresh event.
        const tKey = `${thought.thought_type}::${thought.content}`;
        if (local.thoughtKeys.has(tKey)) continue;
        local.thoughtKeys.add(tKey);
        const bucket = state.thoughts.get(key) ?? [];
        bucket.push(thought);
        state.thoughts.set(key, bucket);
        yield {
          type: GenieEventType.THOUGHT,
          message: current,
          thought,
          ...(publicId ? { attachmentId: publicId } : {}),
          ...(query.statement_id ? { statementId: query.statement_id } : {}),
        };
      }
      const meta = query.query_result_metadata;
      if (meta && typeof meta.row_count === "number" && meta.row_count !== local.rowCount) {
        const prevRowCount = local.rowCount;
        local.rowCount = meta.row_count;
        yield {
          type: GenieEventType.ROW_COUNT,
          message: current,
          rowCount: meta.row_count,
          prev: prevRowCount,
          ...(publicId ? { attachmentId: publicId } : {}),
          ...(query.statement_id ? { statementId: query.statement_id } : {}),
        };
      }
    }

    // Text attachments: emit only when content changes (Genie
    // sometimes resends the same `text` block on a follow-up poll
    // without otherwise mutating the payload). Surface the SDK's
    // `purpose` field (e.g. `FOLLOW_UP_QUESTION`) so consumers can
    // route the main reply vs. a follow-up prompt separately.
    const text = attachment.text;
    if (text?.content && text.content !== local.text) {
      local.text = text.content;
      yield {
        type: GenieEventType.TEXT,
        message: current,
        content: text.content,
        ...(publicId ? { attachmentId: publicId } : {}),
        ...(text.purpose ? { purpose: text.purpose } : {}),
      };
    }

    // Suggested-questions: collapse the array into a single dedupe
    // key so an unchanged list doesn't refire when other attachments
    // evolve around it.
    const suggested = attachment.suggested_questions;
    const questions = suggested?.questions;
    if (questions && questions.length > 0) {
      const qKey = questions.join("\n");
      if (qKey !== local.suggestedQuestionsKey) {
        local.suggestedQuestionsKey = qKey;
        yield {
          type: GenieEventType.SUGGESTED_QUESTIONS,
          message: current,
          questions,
          ...(publicId ? { attachmentId: publicId } : {}),
        };
      }
    }
  }

  // Message-level error. Surfaced under `messageError` (not
  // `error`) so consumers that pipe through Node's EventEmitter
  // semantics don't trip the reserved-name behavior for unlistened
  // `error` events.
  const err = current.error as MessageError | undefined;
  if (err?.error) {
    const eKey = `${err.type ?? ""}::${err.error}`;
    if (eKey !== state.errorKey) {
      state.errorKey = eKey;
      yield {
        type: GenieEventType.MESSAGE_ERROR,
        message: current,
        error: err.error,
        ...(err.type ? { errorType: err.type } : {}),
      };
    }
  }
}

/**
 * Issue the right initial call - `createMessage` when continuing
 * an existing conversation, `startConversation` otherwise - and
 * return the in-flight `GenieMessage` from the response.
 *
 * The SDK's `Waiter<C, P>` is just `C & { wait(...) }`, so the
 * response is directly indexable: `startConversation` yields a
 * `GenieStartConversationResponse`-shaped waiter and `createMessage`
 * yields a `GenieMessage`-shaped waiter. We never call `.wait()`
 * on either - the poll loop drives status updates against
 * `getMessage` at our own cadence.
 */
async function issueInitialRequest(
  opts: RunGenieOptions,
  context: Context,
): Promise<GenieMessage> {
  if (opts.conversationId) {
    const waiter = await opts.client.genie.createMessage(
      {
        space_id: opts.spaceId,
        conversation_id: opts.conversationId,
        content: opts.question,
      },
      context,
    );
    return ensureConversationId(waiter as GenieMessage, opts.conversationId);
  }
  const waiter = await opts.client.genie.startConversation(
    { space_id: opts.spaceId, content: opts.question },
    context,
  );
  if (!waiter.message) {
    throw new Error("Genie startConversation returned no initial message");
  }
  if (!waiter.conversation_id) {
    throw new Error("Genie startConversation returned no conversation_id");
  }
  return ensureConversationId(waiter.message as GenieMessage, waiter.conversation_id);
}

/** Backfill `conversation_id` on the initial message if the SDK omitted it. */
function ensureConversationId(msg: GenieMessage, conversationId: string): GenieMessage {
  if (msg.conversation_id) return msg;
  return { ...msg, conversation_id: conversationId };
}

/* --------------------------- public surface --------------------------- */

/**
 * Drive one Genie conversation turn as an async iterable of
 * {@link GenieEvent}s.
 *
 * The generator yields every event a Genie run can emit in wire
 * order (see {@link GenieEventType}) and returns the final
 * `GenieMessage` once the message reaches a terminal status. If
 * the caller's signal aborts, the generator returns early after
 * cancelling every in-flight SDK call.
 *
 * @example
 *
 *   const ac = new AbortController();
 *   const gen = streamGenie({ client, spaceId, question: "Top stores by revenue?", signal: ac.signal });
 *   for await (const event of gen) {
 *     if (event.type === GenieEventType.STATUS) console.log(event.status);
 *     if (event.type === GenieEventType.TERMINAL) break;
 *   }
 */
export async function* streamGenie(
  opts: RunGenieOptions,
): AsyncGenerator<GenieEvent, GenieMessage | undefined> {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const fetchRows = opts.fetchRows ?? DEFAULT_FETCH_ROWS;

  // Two controllers, both tied to the caller's signal. The main
  // controller covers the poll loop + initial request; the fetch
  // controller covers row-data fetches. Keeping them separate lets
  // a future tweak (e.g. abandon row fetches on terminal=FAILED)
  // cancel just the fetches without tearing down the main poll.
  const mainController = new AbortController();
  if (opts.signal) tieController(mainController, opts.signal);
  const fetchController = new AbortController();
  tieController(fetchController, mainController.signal);

  const state: RunState = {
    lastStatus: undefined,
    attachments: new Map<string, GenieAttachment>(),
    statementIds: new Set<string>(),
    thoughts: new Map<string, GenieThought[]>(),
    errorKey: undefined,
    scratch: new Map<string, AttachmentScratch>(),
  };

  // Background "on-next" row fetches push results here. The main
  // loop drains the buffer between polls; the post-loop step
  // drains anything still queued after terminal.
  const queryBuffer: Array<
    GenieEventOf<GenieEventType.QUERY_RESULT> | GenieEventOf<GenieEventType.QUERY_ERROR>
  > = [];
  const inFlightFetches: Promise<unknown>[] = [];

  // Kick off a single attachment row fetch in the background. Pushes
  // either a `queryResult` or `queryError` event onto `queryBuffer`
  // when it settles. Never throws - the caller doesn't await it.
  const kickoffFetch = (
    attachmentId: string,
    statementId: string,
    snapshot: GenieMessage,
    conversationId: string,
    messageId: string,
  ): void => {
    const p = (async () => {
      try {
        const data = (await opts.client.genie.getMessageAttachmentQueryResult(
          {
            space_id: opts.spaceId,
            conversation_id: conversationId,
            message_id: messageId,
            attachment_id: attachmentId,
          },
          ctxFor(fetchController.signal),
        )) as StatementResponse;
        queryBuffer.push({
          type: GenieEventType.QUERY_RESULT,
          message: snapshot,
          statementId,
          attachmentId,
          data,
        });
      } catch (err) {
        queryBuffer.push({
          type: GenieEventType.QUERY_ERROR,
          message: snapshot,
          statementId,
          attachmentId,
          error: err,
        });
      }
    })();
    inFlightFetches.push(p);
  };

  let finalMessage: GenieMessage | undefined;

  try {
    // 1. Start (or follow up).
    const initialMessage = await issueInitialRequest(opts, ctxFor(mainController.signal));
    const conversationId = initialMessage.conversation_id;
    const messageId = initialMessage.message_id;
    if (!conversationId) throw new Error("Genie returned no conversation_id");
    if (!messageId) throw new Error("Genie returned no message_id");

    // 2. Yield events from the first payload + register any
    // "on-next" fetches it implies.
    let prev: GenieMessage | undefined;
    for (const event of dispatchDeltas(initialMessage, prev, state)) {
      if (
        fetchRows === "on-next" &&
        event.type === GenieEventType.STATEMENT_ID &&
        event.attachmentId
      ) {
        kickoffFetch(event.attachmentId, event.statementId, event.message, conversationId, messageId);
      }
      yield event;
    }
    prev = initialMessage;

    // 3. Poll until terminal. Buffered "on-next" fetch
    // results are drained between polls so they interleave with
    // status / attachment events at roughly real-time cadence.
    while (!isTerminalStatus(state.lastStatus) && !mainController.signal.aborted) {
      while (queryBuffer.length > 0) yield queryBuffer.shift()!;

      await sleep(pollIntervalMs, mainController.signal);
      if (mainController.signal.aborted) break;

      const current = (await opts.client.genie.getMessage(
        {
          space_id: opts.spaceId,
          conversation_id: conversationId,
          message_id: messageId,
        },
        ctxFor(mainController.signal),
      )) as GenieMessage;

      for (const event of dispatchDeltas(current, prev, state)) {
        if (
          fetchRows === "on-next" &&
          event.type === GenieEventType.STATEMENT_ID &&
          event.attachmentId
        ) {
          kickoffFetch(
            event.attachmentId,
            event.statementId,
            event.message,
            conversationId,
            messageId,
          );
        }
        yield event;
      }
      prev = current;
    }

    if (mainController.signal.aborted) {
      // Bail before yielding terminal / draining fetches; the
      // `finally` below handles cleanup.
      return undefined;
    }

    // 4. Terminal event.
    finalMessage = prev!;
    const terminalStatus = state.lastStatus as TerminalStatus;
    yield {
      type: GenieEventType.TERMINAL,
      message: finalMessage,
      status: terminalStatus,
    };

    // 5. Drain anything that landed in the buffer while we were
    // emitting the terminal event.
    while (queryBuffer.length > 0) yield queryBuffer.shift()!;

    // 6. "on-complete" fetches: walk every query attachment with a
    // real `attachment_id` + `statement_id` and surface its rows
    // serially after the terminal event.
    if (fetchRows === "on-complete" && terminalStatus === "COMPLETED") {
      for (const attachment of state.attachments.values()) {
        const aid = attachment.attachment_id;
        const sid = attachment.query?.statement_id;
        if (!aid || !sid) continue;
        try {
          const data = (await opts.client.genie.getMessageAttachmentQueryResult(
            {
              space_id: opts.spaceId,
              conversation_id: conversationId,
              message_id: messageId,
              attachment_id: aid,
            },
            ctxFor(fetchController.signal),
          )) as StatementResponse;
          yield {
            type: GenieEventType.QUERY_RESULT,
            message: finalMessage,
            statementId: sid,
            attachmentId: aid,
            data,
          };
        } catch (err) {
          yield {
            type: GenieEventType.QUERY_ERROR,
            message: finalMessage,
            statementId: sid,
            attachmentId: aid,
            error: err,
          };
        }
      }
    }

    // 7. Wait for any "on-next" fetches still running and
    // drain the buffer one last time. `allSettled` so a single
    // failed fetch doesn't reject the generator.
    if (inFlightFetches.length > 0) {
      await Promise.allSettled(inFlightFetches);
    }
    while (queryBuffer.length > 0) yield queryBuffer.shift()!;

    return finalMessage;
  } finally {
    // Consumer break / throw / return / signal abort - kill every
    // in-flight HTTP call. Fetches go first so abandoned row
    // fetches don't keep the process alive after the main poll
    // controller has already aborted.
    fetchController.abort("streamGenie cleanup");
    mainController.abort("streamGenie cleanup");
  }
}
