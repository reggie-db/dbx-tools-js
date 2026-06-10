/**
 * Unit tests for the pure event-detection layer (`event.ts`).
 *
 * Three concerns are covered, each in its own block:
 *
 *   1. The detector factory + every concrete detector. Detectors
 *      are pure functions of `(current, previous, location)` so the
 *      tests are straight value-in / value-out assertions; no I/O,
 *      no timers, no SDK mocks.
 *   2. The `eventsFromMessage` sync generator. Verifies dispatch
 *      order, multiple-attachment fan-out, and the prev-attachment
 *      match strategy (id-based when ids exist, positional for
 *      anonymous slots).
 *   3. The discriminated-union shape: every detector's output gets
 *      stamped with the matching `type` literal at yield time, and
 *      TypeScript narrows correctly on the `type` discriminator.
 */

import { describe, expect, it } from "bun:test";

import type {
  AttachmentEvent,
  GenieAttachment,
  GenieChatEvent,
  GenieChatEventFields,
  GenieChatLocation,
  GenieMessage,
  GenieThought,
  ThinkingEvent,
} from "@dbx-tools/genie-shared";
import {
  detectAttachmentAdded,
  detectQuery,
  detectRows,
  detectStatement,
  detectStatus,
  detectSuggestedQuestions,
  detectText,
  detectThinking,
  eventDetector,
  eventsFromMessage,
} from "@dbx-tools/genie-shared";

/* ----------------------------- fixtures ---------------------------- */

const SPACE_ID = "space-1";
const CONV_ID = "conv-1";
const MSG_ID = "msg-1";

function makeLoc(over: Partial<GenieChatLocation> = {}): GenieChatLocation {
  return {
    space_id: SPACE_ID,
    conversation_id: CONV_ID,
    message_id: MSG_ID,
    ...over,
  };
}

function makeMessage(over: Partial<GenieMessage> = {}): GenieMessage {
  return {
    space_id: SPACE_ID,
    conversation_id: CONV_ID,
    message_id: MSG_ID,
    ...over,
  } as GenieMessage;
}

function thought(
  thought_type: GenieThought["thought_type"],
  content: string,
): GenieThought {
  return { thought_type, content };
}

/* -------------------------- eventDetector -------------------------- */

describe("eventDetector", () => {
  it("returns an EventDetector with the literal type and the detect fn", () => {
    const fn: Parameters<typeof eventDetector<"status">>[1] = (
      current,
      _previous,
      space_id,
    ) => ({
      status: current.status!,
      previous_status: undefined,
      space_id,
      conversation_id: current.conversation_id,
      message_id: current.message_id,
    });
    const d = eventDetector("status", fn);
    expect(d.type).toBe("status");
    expect(d.detect).toBe(fn);
  });
});

/* ---------------------------- detectStatus -------------------------- */

describe("detectStatus", () => {
  it("emits with previous_status undefined on the first status seen", () => {
    const out = detectStatus.detect(
      makeMessage({ status: "SUBMITTED" }),
      undefined,
      SPACE_ID,
    );
    expect(out).toEqual({
      status: "SUBMITTED",
      previous_status: undefined,
      space_id: SPACE_ID,
      conversation_id: CONV_ID,
      message_id: MSG_ID,
    } satisfies GenieChatEventFields<"status">);
  });

  it("emits the transition when status differs from previous", () => {
    const out = detectStatus.detect(
      makeMessage({ status: "COMPLETED" }),
      makeMessage({ status: "ASKING_AI" }),
      SPACE_ID,
    );
    expect(out).toMatchObject({
      status: "COMPLETED",
      previous_status: "ASKING_AI",
    });
  });

  it("does not emit when status is unchanged", () => {
    const out = detectStatus.detect(
      makeMessage({ status: "ASKING_AI" }),
      makeMessage({ status: "ASKING_AI" }),
      SPACE_ID,
    );
    expect(out).toBeUndefined();
  });

  it("does not emit when current.status is undefined", () => {
    const out = detectStatus.detect(makeMessage(), undefined, SPACE_ID);
    expect(out).toBeUndefined();
  });
});

/* ------------------------ detectAttachmentAdded --------------------- */

describe("detectAttachmentAdded", () => {
  it("emits on first sight (no previous) with the detected attachment_type", () => {
    const att: GenieAttachment = { attachment_id: "a1", text: { content: "hi" } };
    const out = detectAttachmentAdded.detect(
      att,
      undefined,
      makeLoc({ attachment_id: "a1" }),
      0,
    );
    expect(out).toEqual({
      ...makeLoc({ attachment_id: "a1" }),
      index: 0,
      attachment_type: "text",
    } satisfies GenieChatEventFields<"attachment">);
  });

  it("does not emit when the slot already existed", () => {
    const att: GenieAttachment = { attachment_id: "a1", text: { content: "hi" } };
    expect(
      detectAttachmentAdded.detect(att, att, makeLoc({ attachment_id: "a1" }), 0),
    ).toBeUndefined();
  });

  it("reports the right attachment_type for query / suggested_questions attachments", () => {
    expect(
      detectAttachmentAdded.detect(
        { attachment_id: "q1", query: { query: "SELECT 1" } },
        undefined,
        makeLoc({ attachment_id: "q1" }),
        1,
      ),
    ).toMatchObject({ index: 1, attachment_type: "query" });

    expect(
      detectAttachmentAdded.detect(
        {
          attachment_id: "sq1",
          suggested_questions: { questions: ["Foo?", "Bar?"] },
        },
        undefined,
        makeLoc({ attachment_id: "sq1" }),
        2,
      ),
    ).toMatchObject({ index: 2, attachment_type: "suggested_questions" });
  });
});

/* ---------------------------- detectThinking ------------------------ */

describe("detectThinking", () => {
  it("returns undefined when the attachment has no thoughts", () => {
    const att: GenieAttachment = { attachment_id: "q1", query: { query: "SELECT 1" } };
    expect(detectThinking.detect(att, undefined, makeLoc(), 0)).toBeUndefined();
  });

  it("emits one event per thought on the first observation", () => {
    const att: GenieAttachment = {
      attachment_id: "q1",
      query: {
        thoughts: [
          thought("THOUGHT_TYPE_DESCRIPTION", "what the user asked"),
          thought("THOUGHT_TYPE_STEPS", "step 1"),
        ],
      },
    };
    const out = detectThinking.detect(att, undefined, makeLoc(), 0);
    expect(out).toEqual([
      {
        ...makeLoc(),
        text: "what the user asked",
        thought_type: "THOUGHT_TYPE_DESCRIPTION",
      },
      {
        ...makeLoc(),
        text: "step 1",
        thought_type: "THOUGHT_TYPE_STEPS",
      },
    ] satisfies GenieChatEventFields<"thinking">[]);
  });

  it("emits only the newly-added (type, content) tuples on a subsequent snapshot", () => {
    const prev: GenieAttachment = {
      attachment_id: "q1",
      query: {
        thoughts: [thought("THOUGHT_TYPE_DESCRIPTION", "first")],
      },
    };
    const curr: GenieAttachment = {
      attachment_id: "q1",
      query: {
        thoughts: [
          thought("THOUGHT_TYPE_DESCRIPTION", "first"),
          thought("THOUGHT_TYPE_STEPS", "second"),
        ],
      },
    };
    const out = detectThinking.detect(curr, prev, makeLoc(), 0);
    expect(out).toEqual([
      { ...makeLoc(), text: "second", thought_type: "THOUGHT_TYPE_STEPS" },
    ]);
  });

  it("uses a value-based set diff so re-typed / reordered thoughts only emit the new tuple", () => {
    // Genie can mutate index 0 in place (e.g. promote a DATA_SOURCING
    // thought to DESCRIPTION while re-appending the original at
    // index 1). A positional diff would mis-report the re-typed
    // slot as new and re-emit the moved one.
    const prev: GenieAttachment = {
      attachment_id: "q1",
      query: {
        thoughts: [thought("THOUGHT_TYPE_DATA_SOURCING", "tables...")],
      },
    };
    const curr: GenieAttachment = {
      attachment_id: "q1",
      query: {
        thoughts: [
          thought("THOUGHT_TYPE_DESCRIPTION", "restatement"),
          thought("THOUGHT_TYPE_DATA_SOURCING", "tables..."),
        ],
      },
    };
    const out = detectThinking.detect(curr, prev, makeLoc(), 0);
    expect(out).toEqual([
      {
        ...makeLoc(),
        text: "restatement",
        thought_type: "THOUGHT_TYPE_DESCRIPTION",
      },
    ]);
  });

  it("dedupes within a single snapshot if Genie ever ships the same tuple twice", () => {
    const att: GenieAttachment = {
      attachment_id: "q1",
      query: {
        thoughts: [
          thought("THOUGHT_TYPE_STEPS", "step"),
          thought("THOUGHT_TYPE_STEPS", "step"),
        ],
      },
    };
    const out = detectThinking.detect(att, undefined, makeLoc(), 0);
    expect(out).toEqual([
      { ...makeLoc(), text: "step", thought_type: "THOUGHT_TYPE_STEPS" },
    ]);
  });
});

/* ----------------------------- detectText --------------------------- */

describe("detectText", () => {
  it("emits when text content first appears", () => {
    const out = detectText.detect(
      { attachment_id: "t1", text: { content: "hello" } },
      undefined,
      makeLoc({ attachment_id: "t1" }),
      0,
    );
    expect(out).toEqual({ ...makeLoc({ attachment_id: "t1" }), text: "hello" });
  });

  it("emits when text content changes", () => {
    const out = detectText.detect(
      { attachment_id: "t1", text: { content: "hello world" } },
      { attachment_id: "t1", text: { content: "hello" } },
      makeLoc({ attachment_id: "t1" }),
      0,
    );
    expect(out).toMatchObject({ text: "hello world" });
  });

  it("does not emit when content is unchanged", () => {
    const same: GenieAttachment = { attachment_id: "t1", text: { content: "x" } };
    expect(detectText.detect(same, same, makeLoc(), 0)).toBeUndefined();
  });

  it("does not emit when text is undefined", () => {
    expect(
      detectText.detect({ attachment_id: "x" }, undefined, makeLoc(), 0),
    ).toBeUndefined();
  });
});

/* ----------------------------- detectQuery -------------------------- */

describe("detectQuery", () => {
  it("emits when SQL first appears", () => {
    const out = detectQuery.detect(
      { attachment_id: "q1", query: { query: "SELECT 1" } },
      { attachment_id: "q1", query: {} },
      makeLoc({ attachment_id: "q1" }),
      0,
    );
    expect(out).toEqual({ ...makeLoc({ attachment_id: "q1" }), sql: "SELECT 1" });
  });

  it("emits when SQL is rewritten", () => {
    const out = detectQuery.detect(
      { attachment_id: "q1", query: { query: "SELECT 2" } },
      { attachment_id: "q1", query: { query: "SELECT 1" } },
      makeLoc({ attachment_id: "q1" }),
      0,
    );
    expect(out).toMatchObject({ sql: "SELECT 2" });
  });

  it("does not emit when SQL is unchanged or missing", () => {
    const same: GenieAttachment = {
      attachment_id: "q1",
      query: { query: "SELECT 1" },
    };
    expect(detectQuery.detect(same, same, makeLoc(), 0)).toBeUndefined();
    expect(
      detectQuery.detect({ attachment_id: "q1", query: {} }, undefined, makeLoc(), 0),
    ).toBeUndefined();
  });
});

/* ---------------------------- detectStatement ----------------------- */

describe("detectStatement", () => {
  it("emits when statement_id transitions undefined -> string", () => {
    const out = detectStatement.detect(
      { attachment_id: "q1", query: { statement_id: "stmt-1" } },
      { attachment_id: "q1", query: {} },
      makeLoc({ attachment_id: "q1" }),
      0,
    );
    expect(out).toEqual({
      ...makeLoc({ attachment_id: "q1" }),
      statement_id: "stmt-1",
    });
  });

  it("does not emit when statement_id is unchanged", () => {
    const a: GenieAttachment = {
      attachment_id: "q1",
      query: { statement_id: "stmt-1" },
    };
    expect(detectStatement.detect(a, a, makeLoc(), 0)).toBeUndefined();
  });
});

/* ----------------------------- detectRows --------------------------- */

describe("detectRows", () => {
  it("emits on undefined -> 0 (initial observation)", () => {
    const out = detectRows.detect(
      {
        attachment_id: "q1",
        query: { query_result_metadata: { row_count: 0 } },
      },
      { attachment_id: "q1", query: {} },
      makeLoc({ attachment_id: "q1" }),
      0,
    );
    expect(out).toMatchObject({ row_count: 0, previous_row_count: undefined });
  });

  it("emits on 0 -> N once warehouse execution completes", () => {
    const out = detectRows.detect(
      {
        attachment_id: "q1",
        query: {
          statement_id: "stmt-1",
          query_result_metadata: { row_count: 42 },
        },
      },
      {
        attachment_id: "q1",
        query: {
          statement_id: "stmt-1",
          query_result_metadata: { row_count: 0 },
        },
      },
      makeLoc({ attachment_id: "q1" }),
      0,
    );
    expect(out).toMatchObject({
      row_count: 42,
      previous_row_count: 0,
      statement_id: "stmt-1",
    });
  });

  it("does not emit when row_count is unchanged", () => {
    const a: GenieAttachment = {
      attachment_id: "q1",
      query: { query_result_metadata: { row_count: 5 } },
    };
    expect(detectRows.detect(a, a, makeLoc(), 0)).toBeUndefined();
  });
});

/* ----------------------- detectSuggestedQuestions ------------------- */

describe("detectSuggestedQuestions", () => {
  it("emits when questions first appear", () => {
    const out = detectSuggestedQuestions.detect(
      {
        attachment_id: "sq1",
        suggested_questions: { questions: ["Foo?", "Bar?"] },
      },
      undefined,
      makeLoc({ attachment_id: "sq1" }),
      0,
    );
    expect(out).toMatchObject({ questions: ["Foo?", "Bar?"] });
  });

  it("emits when the questions list is rewritten (length-preserving)", () => {
    const out = detectSuggestedQuestions.detect(
      {
        attachment_id: "sq1",
        suggested_questions: { questions: ["A?", "B?"] },
      },
      {
        attachment_id: "sq1",
        suggested_questions: { questions: ["A?", "C?"] },
      },
      makeLoc({ attachment_id: "sq1" }),
      0,
    );
    expect(out).toMatchObject({ questions: ["A?", "B?"] });
  });

  it("does not emit on an empty list", () => {
    expect(
      detectSuggestedQuestions.detect(
        { attachment_id: "sq1", suggested_questions: { questions: [] } },
        undefined,
        makeLoc(),
        0,
      ),
    ).toBeUndefined();
  });

  it("does not emit when the JSON-stringified list is unchanged", () => {
    const same: GenieAttachment = {
      attachment_id: "sq1",
      suggested_questions: { questions: ["Foo?", "Bar?"] },
    };
    expect(detectSuggestedQuestions.detect(same, same, makeLoc(), 0)).toBeUndefined();
  });
});

/* -------------------------- eventsFromMessage ----------------------- */

describe("eventsFromMessage", () => {
  // Drain the sync generator to an array. Every yield is a flat
  // `{type, ...fields}` object per the GenieChatEvent contract;
  // the discriminator narrows the rest of the fields per variant.
  function collect(
    current: GenieMessage,
    previous: GenieMessage | undefined,
    space_id: string = SPACE_ID,
  ): GenieChatEvent[] {
    return [...eventsFromMessage(current, previous, space_id)];
  }

  it("yields every event with the type discriminator stamped", () => {
    const curr = makeMessage({
      status: "ASKING_AI",
      attachments: [{ attachment_id: "q1", query: { query: "SELECT 1" } }],
    });
    const events = collect(curr, undefined);
    // Each variant carries its discriminator.
    for (const e of events) {
      expect(typeof e.type).toBe("string");
    }
    expect(events[0]?.type).toBe("status");
  });

  it("dispatches status before any attachment events", () => {
    const curr = makeMessage({
      status: "ASKING_AI",
      attachments: [{ attachment_id: "q1", query: { query: "SELECT 1" } }],
    });
    const events = collect(curr, undefined);
    expect(events.map((e) => e.type)).toEqual(["status", "attachment", "query"]);
  });

  it("fans out per-attachment events with the correct index", () => {
    const curr = makeMessage({
      attachments: [
        { attachment_id: "t1", text: { content: "hi" } },
        { attachment_id: "q1", query: { query: "SELECT 1" } },
      ],
    });
    const events = collect(curr, undefined);

    const attachmentEvents = events.filter(
      (e): e is AttachmentEvent => e.type === "attachment",
    );
    expect(attachmentEvents).toHaveLength(2);
    expect(attachmentEvents[0]).toMatchObject({
      index: 0,
      attachment_type: "text",
      attachment_id: "t1",
    });
    expect(attachmentEvents[1]).toMatchObject({
      index: 1,
      attachment_type: "query",
      attachment_id: "q1",
    });
  });

  it("matches an id'd attachment to the prev slot by id regardless of position", () => {
    const prev = makeMessage({
      attachments: [
        { attachment_id: "a", text: { content: "x" } },
        { attachment_id: "b", query: { query: "SELECT 1" } },
      ],
    });
    // Same attachments, swapped order. The query SQL is unchanged
    // and the text attachment is unchanged, so no `query` /
    // `text` events should fire even though positional matching
    // would think both are brand-new.
    const curr = makeMessage({
      attachments: [
        { attachment_id: "b", query: { query: "SELECT 1" } },
        { attachment_id: "a", text: { content: "x" } },
      ],
    });
    const events = collect(curr, prev);
    expect(events.filter((e) => e.type === "attachment")).toHaveLength(0);
    expect(events.filter((e) => e.type === "query")).toHaveLength(0);
    expect(events.filter((e) => e.type === "text")).toHaveLength(0);
  });

  it("matches anonymous attachments positionally and does not bind to an id'd predecessor", () => {
    const prev = makeMessage({
      attachments: [{ text: { content: "old" } }],
    });
    const curr = makeMessage({
      attachments: [{ text: { content: "new" } }],
    });
    const events = collect(curr, prev);

    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0]).toMatchObject({ text: "new" });
    expect(events.filter((e) => e.type === "attachment")).toHaveLength(0);
  });

  it("does not bind an id'd attachment to an anonymous predecessor at the same slot", () => {
    const prev = makeMessage({
      attachments: [{ text: { content: "x" } }],
    });
    const curr = makeMessage({
      attachments: [{ attachment_id: "a", text: { content: "x" } }],
    });
    const events = collect(curr, prev);
    const attachmentEvents = events.filter(
      (e): e is AttachmentEvent => e.type === "attachment",
    );
    expect(attachmentEvents).toHaveLength(1);
    expect(attachmentEvents[0]).toMatchObject({
      attachment_id: "a",
      attachment_type: "text",
    });
  });

  it("does NOT emit message or result (those are lifecycle, handled by chat.ts)", () => {
    // Even when the snapshot's status is terminal,
    // `eventsFromMessage` is pure-diff and shouldn't emit the
    // lifecycle envelope.
    const curr = makeMessage({ status: "COMPLETED" });
    const events = collect(curr, undefined);
    expect(events.some((e) => e.type === "message")).toBe(false);
    expect(events.some((e) => e.type === "result")).toBe(false);
  });

  it("no-ops on attachments[] when nothing changed", () => {
    const a = makeMessage({
      status: "ASKING_AI",
      attachments: [{ attachment_id: "q1", query: { query: "SELECT 1" } }],
    });
    const events = collect(a, a);
    expect(events).toHaveLength(0);
  });

  it("yields multiple thinking events as separate flat events", () => {
    const curr = makeMessage({
      attachments: [
        {
          attachment_id: "q1",
          query: {
            thoughts: [
              thought("THOUGHT_TYPE_DESCRIPTION", "first"),
              thought("THOUGHT_TYPE_STEPS", "second"),
            ],
          },
        },
      ],
    });
    const events = collect(curr, undefined);
    const thinking = events.filter((e): e is ThinkingEvent => e.type === "thinking");
    expect(thinking).toHaveLength(2);
    expect(thinking[0]!.thought_type).toBe("THOUGHT_TYPE_DESCRIPTION");
    expect(thinking[1]!.thought_type).toBe("THOUGHT_TYPE_STEPS");
  });
});
