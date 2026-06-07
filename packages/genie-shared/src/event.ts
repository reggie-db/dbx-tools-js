/**
 * Pure event-detection for `genieEventChat`. Given two
 * `GenieMessage` snapshots (current + prior) and the surrounding
 * `space_id`, derive the semantic deltas (status transitions, new
 * attachments, new thoughts, SQL emission, warehouse submission,
 * row-count progress, follow-up suggestions, text deltas) and
 * yield them as typed {@link GenieChatEvent}s.
 *
 * Architecture:
 *
 *   - Each detector is built with {@link eventDetector}, which
 *     takes the event name as a literal string and a `detect`
 *     callback. TS infers `T extends GenieChatEventType` from the
 *     literal, looks up its scope in {@link DetectorScope}, and
 *     resolves `detect`'s parameter list (message vs
 *     per-attachment) and return type
 *     ({@link DetectorResult}<T>) accordingly. Pass an unknown
 *     name (`"status2"`) and the call fails to compile; pass a
 *     payload shape that doesn't match the named event and the
 *     return fails to compile.
 *   - {@link eventsFromMessage}: sync generator. Walks the
 *     snapshot diff and yields flat `{type, ...fields}` events
 *     for every detector that fires, in a stable order (status
 *     first, then per-attachment field deltas) so a subscriber
 *     that simply logs events as they arrive sees them in a
 *     sensible sequence.
 *   - Private helpers (`matchPrevAttachment`, `thoughtKey`):
 *     diff plumbing shared across detectors.
 *
 * The module is intentionally pure: no `EventEmitter`, no `this`,
 * no I/O, no module-level mutable state. The `message` and
 * `result` events are NOT derived here - they belong to the chat
 * lifecycle layer (`chat.ts`, `genieEventChat`) because they track
 * per-yield / per-turn-completion semantics rather than a
 * field-level snapshot diff.
 */

import {
  detectAttachmentType,
  type GenieAttachment,
  type GenieChatEvent,
  type GenieChatEventFields,
  type GenieChatEventType,
  type GenieChatLocation,
  type GenieMessage,
  type GenieThought,
} from "./protocol.js";

/* ----------------------------- contract ---------------------------- */

/**
 * What a single detector call returns: zero (`undefined`), one
 * (fields object), or many (`fields[]`) events of the same type.
 * Each result is the variant's payload fields **without** the
 * `type` discriminator - the orchestrator stamps `type` when it
 * yields the event.
 */
type DetectorResult<T extends GenieChatEventType> =
  | GenieChatEventFields<T>
  | GenieChatEventFields<T>[]
  | undefined;

/**
 * Where in the wire shape a given event is derived from. Drives
 * which arguments `detect` receives. `"message"` events watch
 * `GenieMessage` itself; `"attachment"` events watch one slot of
 * `message.attachments[]`. `"lifecycle"` events (`message`,
 * `result`) are emitted by `chat.ts` directly and can't be built
 * with {@link eventDetector} - they have no diff signature.
 */
interface DetectorScope {
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
  question: "lifecycle";
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
type DetectFn<T extends GenieChatEventType> = DetectorScope[T] extends "message"
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
 * Typed detector for one event in the {@link GenieChatEvent}
 * union. The `type` field is the event name; `detect`'s signature
 * is picked from {@link DetectorScope} based on `T`.
 */
interface EventDetector<T extends GenieChatEventType> {
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
 *     {@link GenieChatEvent}.
 *   - `eventDetector("status", attachmentArgsCallback)` fails -
 *     `"status"` is message-scoped, so `detect` must take
 *     `(GenieMessage, GenieMessage | undefined, string)`.
 *   - Returning a `ThinkingEvent`-shaped fields object from a
 *     `"status"` detector fails - the return type is constrained
 *     to `DetectorResult<"status">`.
 *
 * Lifecycle event names (`"message"`, `"result"`) resolve `detect`
 * to `never` and won't compile, which is intentional: those have
 * no diff signature and are emitted directly by `chat.ts`.
 */
export function eventDetector<T extends GenieChatEventType>(
  type: T,
  detect: DetectFn<T>,
): EventDetector<T> {
  return { type, detect };
}

/* ---------------------------- detectors ---------------------------- */

/** Top-level `message.status` transitioned. */
export const detectStatus = eventDetector("status", (current, previous, space_id) => {
  if (!current.status || current.status === previous?.status) return;
  return {
    status: current.status,
    previous_status: previous?.status,
    space_id,
    conversation_id: current.conversation_id,
    message_id: current.message_id,
  };
});

/** First time we see an attachment slot. */
export const detectAttachmentAdded = eventDetector(
  "attachment",
  (current, previous, location, index) => {
    if (previous) return;
    return {
      ...location,
      index,
      attachment_type: detectAttachmentType(current),
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
    const out: GenieChatEventFields<"thinking">[] = [];
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
export const detectText = eventDetector("text", (current, previous, location) => {
  const curr = current.text?.content;
  const prev = previous?.text?.content;
  if (curr === undefined || curr === prev) return;
  return { ...location, text: curr };
});

/** SQL transitioned undefined -> string, or changed. */
export const detectQuery = eventDetector("query", (current, previous, location) => {
  const curr = current.query?.query;
  const prev = previous?.query?.query;
  if (!curr || curr === prev) return;
  return {
    ...location,
    sql: curr,
    title: current.query?.title,
    description: current.query?.description,
  };
});

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
export const detectRows = eventDetector("rows", (current, previous, location) => {
  const curr = current.query?.query_result_metadata?.row_count;
  const prev = previous?.query?.query_result_metadata?.row_count;
  if (curr === undefined || curr === prev) return;
  return {
    ...location,
    row_count: curr,
    previous_row_count: prev,
    statement_id: current.query?.statement_id ?? previous?.query?.statement_id,
  };
});

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
 * Walk the diff between `current` and `previous` and yield every
 * derived event the snapshot produced. Detector order mirrors
 * Genie's wire ordering (status first, then per-attachment field
 * deltas) so a subscriber that simply logs events as they arrive
 * sees them in a sensible sequence.
 *
 * Caller responsibilities (not handled here):
 *
 *   - Yield `{ type: "message", message: current }` BEFORE
 *     calling this, once per poll yield.
 *   - Yield `{ type: "result", ... }` AFTER calling this when
 *     `isTerminalStatus(current.status)` - per-turn lifecycle,
 *     not a per-snapshot field diff.
 *   - Decide what counts as a "fresh turn" and pass `undefined`
 *     for `previous` on turn boundaries, so anonymous-attachment
 *     state from a prior turn doesn't bleed in.
 *
 * Sync generator: the diff is pure CPU work, no awaits. Use
 * `yield*` from an async generator to splice the events into a
 * stream.
 */
export function* eventsFromMessage(
  current: GenieMessage,
  previous: GenieMessage | undefined,
  space_id: string,
): Generator<GenieChatEvent, void, void> {
  // Stamp `type` onto each detector result and yield it. Returning
  // a typed generator keeps the `yield*` callsite tidy. The double
  // cast (`unknown` -> `GenieChatEvent`) is needed because the
  // generic merge `{type: T} & GenieChatEventFields<T>` doesn't
  // structurally narrow back to a discriminated-union member -
  // each detector's runtime output is shaped correctly by
  // construction, so the cast is sound.
  function* emit<T extends GenieChatEventType>(
    detector: EventDetector<T>,
    result: DetectorResult<T>,
  ): Generator<GenieChatEvent, void, void> {
    if (result === undefined) return;
    if (Array.isArray(result)) {
      for (const fields of result) {
        yield { type: detector.type, ...fields } as unknown as GenieChatEvent;
      }
    } else {
      yield { type: detector.type, ...result } as unknown as GenieChatEvent;
    }
  }

  // Message-scoped detectors run once per snapshot.
  yield* emit(detectStatus, detectStatus.detect(current, previous, space_id));

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
    yield* emit(
      detectAttachmentAdded,
      detectAttachmentAdded.detect(curr, prev, location, i),
    );
    yield* emit(detectThinking, detectThinking.detect(curr, prev, location, i));
    yield* emit(detectText, detectText.detect(curr, prev, location, i));
    yield* emit(detectQuery, detectQuery.detect(curr, prev, location, i));
    yield* emit(detectStatement, detectStatement.detect(curr, prev, location, i));
    yield* emit(detectRows, detectRows.detect(curr, prev, location, i));
    yield* emit(
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
