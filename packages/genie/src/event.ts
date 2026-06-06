/**
 * Pure event-detection for `GenieChat`. Given two `GenieMessage`
 * snapshots (current + prior) and the surrounding `space_id`,
 * derive the semantic deltas (status transitions, new
 * attachments, new thoughts, SQL emission, warehouse submission,
 * row-count progress, follow-up suggestions, text deltas) and
 * push them through a typed emit callback.
 *
 * Architecture:
 *
 *   - Each detector is built with {@link eventDetector}, which
 *     takes the event name as a literal string and a `detect`
 *     callback. TS infers `T extends keyof GenieChatEventMap`
 *     from the literal, looks up its scope in
 *     {@link DetectorScope}, and resolves `detect`'s parameter
 *     list (message vs per-attachment) and return type
 *     (`DetectorResult<T>`) accordingly. Pass an unknown name
 *     (`"status2"`) and the call fails to compile; pass a payload
 *     shape that doesn't match the named event and the return
 *     fails to compile.
 *   - {@link emitChatEvents}: orchestrator. Walks the snapshot
 *     diff and dispatches each detector's output through a
 *     generic `dispatch` helper that ties `type` to payload via
 *     `EmitChatEvent`'s generic signature. We follow the Mastra
 *     / ai-sdk convention of `type` as the event discriminator.
 *   - Private helpers (`matchPrevAttachment`, `thoughtKey`):
 *     diff plumbing shared across detectors.
 *
 * The module is intentionally pure: no `EventEmitter`, no `this`,
 * no I/O, no module-level mutable state. Consumers can wire up an
 * alternative transport (RxJS subject, async iterable, jest spy)
 * by passing their own `EmitChatEvent` callback to
 * `emitChatEvents`.
 *
 * The `message` and `result` events are NOT derived here - they
 * belong to the chat-lifecycle layer (`chat.ts`) because they
 * track per-yield / per-turn-completion semantics rather than a
 * field-level snapshot diff.
 */

import { EventEmitter } from "node:events";
import {
  detectAttachmentType,
  isTerminalStatus,
  type GenieAttachment,
  type GenieChatEventMap,
  type GenieChatLocation,
  type GenieMessage,
  type GenieThought,
  type ResultEvent,
} from "./protocol.js";

/* ----------------------------- contract ---------------------------- */

/**
 * Typed event-emit callback. Bound to `EventEmitter.emit` inside
 * `GenieChat` but kept abstract here for testability and to let
 * consumers plug in alternative transports.
 */
export type EmitChatEvent = <T extends keyof GenieChatEventMap>(
  type: T,
  payload: GenieChatEventMap[T],
) => void;

/**
 * What a single detector call returns: zero (`undefined`), one
 * (payload), or many (`payload[]`) events of the same type. The
 * orchestrator flattens the variants before emit.
 */
export type DetectorResult<T extends keyof GenieChatEventMap> =
  | GenieChatEventMap[T]
  | GenieChatEventMap[T][]
  | undefined;

/**
 * Where in the wire shape a given event is derived from. Drives
 * which arguments `detect` receives. `"message"` events watch
 * `GenieMessage` itself; `"attachment"` events watch one slot of
 * `message.attachments[]`. `"lifecycle"` events (`message`,
 * `result`) are emitted by `chat.ts` directly and can't be built
 * with {@link eventDetector} - they have no diff signature.
 */
export interface DetectorScope {
  // Message-scoped: top-level field diff on `GenieMessage`.
  status: "message";
  // Per-attachment: field diff on one `GenieAttachment` slot.
  attachment: "attachment";
  thinking: "attachment";
  text: "attachment";
  query: "attachment";
  statement: "attachment";
  rows: "attachment";
  suggested_questions: "attachment";
  // Lifecycle: not derived via diff, handled by `chat.ts`.
  message: "lifecycle";
  result: "lifecycle";
}

/**
 * `detect` callback signature for a given event type. Resolved
 * from {@link DetectorScope}: `"message"` events get the top-level
 * snapshot triple, `"attachment"` events get the per-slot quad,
 * `"lifecycle"` events resolve to `never` (no diff-based detector
 * exists for them).
 */
export type DetectFn<T extends keyof GenieChatEventMap> =
  DetectorScope[T] extends "message"
    ? (
        current: GenieMessage,
        previous: GenieMessage | undefined,
        space_id: string,
      ) => DetectorResult<T>
    : DetectorScope[T] extends "attachment"
      ? (
          current: GenieAttachment,
          previous: GenieAttachment | undefined,
          location: GenieChatLocation,
          index: number,
        ) => DetectorResult<T>
      : never;

/**
 * Typed detector for one event in {@link GenieChatEventMap}. The
 * `type` field is the event name; `detect`'s signature is picked
 * from {@link DetectorScope} based on `T`.
 */
export interface EventDetector<T extends keyof GenieChatEventMap> {
  readonly type: T;
  detect: DetectFn<T>;
}

/* ----------------------- detector factory ----------------------- */

/**
 * Build an {@link EventDetector}. Pass the event name as the
 * literal first arg and the matching `detect` callback as the
 * second. TS infers `T` from the literal, narrows `detect`'s
 * signature accordingly, and types the return as
 * `EventDetector<T>`.
 *
 * Build-time guarantees:
 *
 *   - `eventDetector("status2", ...)` fails - the name isn't in
 *     `GenieChatEventMap`.
 *   - `eventDetector("status", attachmentArgsCallback)` fails -
 *     `"status"` is message-scoped, so `detect` must take
 *     `(GenieMessage, GenieMessage | undefined, string)`.
 *   - Returning a `ThinkingEvent`-shaped payload from a `"status"`
 *     detector fails - the return type is constrained to
 *     `DetectorResult<"status">`.
 *
 * Lifecycle event names (`"message"`, `"result"`) resolve `detect`
 * to `never` and won't compile, which is intentional: those have
 * no diff signature and are emitted directly by `chat.ts`.
 */
export function eventDetector<T extends keyof GenieChatEventMap>(
  type: T,
  detect: DetectFn<T>,
): EventDetector<T> {
  return { type, detect };
}

/* ---------------------------- detectors ---------------------------- */

/** Top-level `message.status` transitioned. */
export const detectStatus = eventDetector(
  "status",
  (current, previous, space_id) => {
    if (!current.status || current.status === previous?.status) return;
    return {
      status: current.status,
      previous_status: previous?.status,
      space_id,
      conversation_id: current.conversation_id,
      message_id: current.message_id,
    };
  },
);

/** First time we see an attachment slot. */
export const detectAttachmentAdded = eventDetector(
  "attachment",
  (current, previous, location, index) => {
    if (previous) return;
    return {
      ...location,
      index,
      type: detectAttachmentType(current),
    };
  },
);

/**
 * One emit per new `(thought_type, content)` tuple on a query
 * attachment. Value-based set diff: Genie can mutate existing
 * thought slots in place (e.g. re-typing index 0 from
 * `DATA_SOURCING` to `DESCRIPTION` while re-appending the
 * original at index 1), so positional / append-only diff would
 * miss re-types and double-count re-orders.
 */
export const detectThinking = eventDetector(
  "thinking",
  (current, previous, location) => {
    const currThoughts = current.query?.thoughts ?? [];
    if (currThoughts.length === 0) return;
    const seen = new Set((previous?.query?.thoughts ?? []).map(thoughtKey));
    const out: GenieChatEventMap["thinking"][] = [];
    for (const t of currThoughts) {
      const key = thoughtKey(t);
      if (seen.has(key)) continue;
      // Defensive: dedupe within a single snapshot in case Genie
      // ever ships the same thought twice in one `thoughts[]`.
      seen.add(key);
      out.push({ ...location, text: t.content, thought_type: t.thought_type });
    }
    return out;
  },
);

/** Text-attachment `content` appeared or changed. */
export const detectText = eventDetector(
  "text",
  (current, previous, location) => {
    const curr = current.text?.content;
    const prev = previous?.text?.content;
    if (curr === undefined || curr === prev) return;
    return { ...location, text: curr };
  },
);

/** SQL transitioned undefined -> string, or changed. */
export const detectQuery = eventDetector(
  "query",
  (current, previous, location) => {
    const curr = current.query?.query;
    const prev = previous?.query?.query;
    if (!curr || curr === prev) return;
    return { ...location, sql: curr };
  },
);

/** Warehouse-statement id assigned. */
export const detectStatement = eventDetector(
  "statement",
  (current, previous, location) => {
    const curr = current.query?.statement_id;
    const prev = previous?.query?.statement_id;
    if (!curr || curr === prev) return;
    return { ...location, statement_id: curr };
  },
);

/**
 * `row_count` changed - fires on every transition including the
 * initial `undefined -> 0` and the post-execution `0 -> N`.
 * Carries the statement id when available for correlation.
 */
export const detectRows = eventDetector(
  "rows",
  (current, previous, location) => {
    const curr = current.query?.query_result_metadata?.row_count;
    const prev = previous?.query?.query_result_metadata?.row_count;
    if (curr === undefined || curr === prev) return;
    return {
      ...location,
      row_count: curr,
      previous_row_count: prev,
      statement_id:
        current.query?.statement_id ?? previous?.query?.statement_id,
    };
  },
);

/**
 * Follow-up suggested-questions array appeared or changed.
 * Compares JSON-stringified arrays so a length-preserving content
 * rewrite still fires.
 */
export const detectSuggestedQuestions = eventDetector(
  "suggested_questions",
  (current, previous, location) => {
    const curr = current.suggested_questions?.questions;
    const prev = previous?.suggested_questions?.questions;
    if (!curr || curr.length === 0) return;
    if (JSON.stringify(curr) === JSON.stringify(prev)) return;
    return { ...location, questions: curr };
  },
);

/* --------------------------- orchestrator --------------------------- */

/**
 * Walk the diff between `current` and `previous` and call `emit`
 * for every event observed. Detector order mirrors Genie's wire
 * ordering (status first, then per-attachment field deltas) so a
 * subscriber that simply logs events as they arrive sees them in
 * a sensible sequence.
 *
 * Caller responsibilities (not handled here):
 *
 *   - Emit `message` (raw `GenieMessage`) BEFORE calling this,
 *     once per poll yield.
 *   - Emit `result` AFTER calling this when
 *     `isTerminalStatus(current.status)` - per-turn lifecycle,
 *     not a per-snapshot field diff.
 *   - Decide what counts as a "fresh turn" and pass `undefined`
 *     for `previous` on turn boundaries, so anonymous-attachment
 *     state from a prior turn doesn't bleed in.
 */
export function emitChatEvents(
  current: GenieMessage,
  previous: GenieMessage | undefined,
  space_id: string,
  emit: EmitChatEvent,
): void {
  // Generic dispatch: takes a detector and its result. TS binds
  // `T` per call from `detector.type`, keeping (type, payload)
  // linked through `emit`'s generic signature.
  const dispatch = <T extends keyof GenieChatEventMap>(
    detector: EventDetector<T>,
    result: DetectorResult<T>,
  ): void => {
    if (result === undefined) return;
    if (Array.isArray(result)) {
      for (const payload of result) emit(detector.type, payload);
    } else {
      emit(detector.type, result);
    }
  };

  // Message-scoped detectors run once per snapshot.
  dispatch(detectStatus, detectStatus.detect(current, previous, space_id));

  // Per-attachment detectors run once per attachment slot.
  const currAtts = current.attachments ?? [];
  const prevAtts = previous?.attachments ?? [];
  for (let i = 0; i < currAtts.length; i++) {
    const curr = currAtts[i]!;
    const prev = matchPrevAttachment(curr, prevAtts, i);
    const location: GenieChatLocation = {
      space_id,
      conversation_id: current.conversation_id,
      message_id: current.message_id,
      attachment_id: curr.attachment_id,
    };
    dispatch(
      detectAttachmentAdded,
      detectAttachmentAdded.detect(curr, prev, location, i),
    );
    dispatch(detectThinking, detectThinking.detect(curr, prev, location, i));
    dispatch(detectText, detectText.detect(curr, prev, location, i));
    dispatch(detectQuery, detectQuery.detect(curr, prev, location, i));
    dispatch(detectStatement, detectStatement.detect(curr, prev, location, i));
    dispatch(detectRows, detectRows.detect(curr, prev, location, i));
    dispatch(
      detectSuggestedQuestions,
      detectSuggestedQuestions.detect(curr, prev, location, i),
    );
  }
}

/* ----------------------------- helpers ----------------------------- */

/**
 * Find the prior version of `curr` in `prevAtts`. Attachments
 * with ids match by id (Genie keeps ids stable across polls);
 * anonymous attachments (Genie's main-answer text doesn't get
 * one) match positionally against an anonymous prev at the same
 * index, so they don't accidentally bind to an id'd predecessor
 * that happened to share the slot.
 */
function matchPrevAttachment(
  curr: GenieAttachment,
  prevAtts: GenieAttachment[],
  i: number,
): GenieAttachment | undefined {
  if (curr.attachment_id) {
    return prevAtts.find((a) => a.attachment_id === curr.attachment_id);
  }
  const p = prevAtts[i];
  return p && !p.attachment_id ? p : undefined;
}

/** Stable key for {@link detectThinking}'s value-based set diff. */
function thoughtKey(t: GenieThought): string {
  return `${t.thought_type}|${t.content}`;
}

/* -------------------------- emitter class -------------------------- */

/**
 * Typed `on` / `once` / `off` / `emit` overloads layered on top
 * of Node's `EventEmitter` via declaration merging. Each method
 * narrows the `event` argument to a key of {@link GenieChatEventMap}
 * and the listener / payload to that key's payload type, so a
 * typo (`chat.on("status2", ...)`) or a mismatched handler shape
 * is a compile-time error.
 */
export interface GenieEventEmitter {
  on<K extends keyof GenieChatEventMap>(
    event: K,
    listener: (payload: GenieChatEventMap[K]) => void,
  ): this;
  once<K extends keyof GenieChatEventMap>(
    event: K,
    listener: (payload: GenieChatEventMap[K]) => void,
  ): this;
  off<K extends keyof GenieChatEventMap>(
    event: K,
    listener: (payload: GenieChatEventMap[K]) => void,
  ): this;
  emit<K extends keyof GenieChatEventMap>(
    event: K,
    payload: GenieChatEventMap[K],
  ): boolean;
}

/**
 * Stateful `GenieMessage` -> typed-event emitter. Consumers
 * subscribe with `on` / `once` / `off`; producers feed snapshots
 * via {@link push}. Owns the per-turn diff state (the last
 * snapshot) and detects turn boundaries by `message_id` change,
 * so each new turn diffs against `undefined` and anonymous-
 * attachment indices / thought de-dup don't bleed across turns.
 *
 * Every `push` fires three categories of events:
 *
 *   - `message` (raw): the snapshot itself, before derivation.
 *   - Derived events: routed through {@link emitChatEvents} (the
 *     full `GenieChatEventMap` vocabulary minus `message` /
 *     `result`). Wire-coordinates (`space_id`,
 *     `conversation_id`, `message_id`, `attachment_id`) are
 *     pulled off `message` itself, which Genie always stamps.
 *   - `result`: fired exactly once per turn when the snapshot
 *     reaches a terminal status (`COMPLETED` / `FAILED` /
 *     `CANCELLED`).
 *
 * Designed to be driven by `genieChatRun` (see `chat.ts`,
 * `GenieChat`) but works with any `GenieMessage` source - feed it
 * from a webhook handler, a replay test, or a hand-rolled poller
 * and the event surface is identical.
 */
export class GenieEventEmitter extends EventEmitter {
  // Last snapshot for diff-based event derivation. Reset
  // implicitly on turn boundaries via the `message_id` check
  // inside `push`.
  private previous: GenieMessage | undefined;

  /**
   * Feed one snapshot. Emits raw, derived, and (when terminal)
   * lifecycle events in that order, then updates internal state
   * for the next call. All event coordinates come from `message`
   * itself - the SDK's `GenieMessage` always carries `space_id`,
   * `conversation_id`, and `message_id`.
   */
  push(message: GenieMessage): void {
    this.emit("message", message);
    // Same-turn diff source: previous snapshot only counts when
    // it belongs to the SAME message_id. New turn -> diff against
    // undefined so the first yield emits fresh events.
    const sameTurn =
      this.previous?.message_id === message.message_id
        ? this.previous
        : undefined;
    emitChatEvents(message, sameTurn, message.space_id, (type, payload) => {
      this.emit(type, payload);
    });
    // Per-turn lifecycle event. `commonUtils.poll` (and any
    // sensible producer) yields the terminal snapshot exactly
    // once, so this fires exactly once per turn.
    if (isTerminalStatus(message.status)) {
      this.emit("result", {
        space_id: message.space_id,
        conversation_id: message.conversation_id,
        message_id: message.message_id,
        status: message.status,
        message,
      } satisfies ResultEvent);
    }
    this.previous = message;
  }
}
