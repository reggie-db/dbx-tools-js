/**
 * Tests for the chat driver (`chat.ts`):
 *
 *   - {@link genieChat}: low-level single-turn async generator.
 *     Verifies the turn lifecycle (open / append / poll), Waiter
 *     `wait` stripping on `createMessage` responses,
 *     distinct-filtering, cooperative abort, and the
 *     "no conversation id, refuse to retry" defensive branch.
 *   - {@link genieEventChat}: high-level typed-event async
 *     generator. Verifies the per-snapshot stream order
 *     (`message` -> derived events -> `result` for the terminal
 *     yield) and the {@link GenieChatEvent} discriminated-union
 *     shape end-to-end against a fully stubbed `WorkspaceClient`.
 *
 * The `WorkspaceClient` is replaced with a structural stub that
 * exposes only the three methods `chat.ts` calls. We cast to
 * `WorkspaceClient` once at the boundary so each test reads as if
 * it had a real client.
 */

import { describe, expect, it, mock } from "bun:test";

import type { WorkspaceClient } from "@databricks/sdk-experimental";

import type {
  GenieChatEvent,
  GenieMessage,
} from "@dbx-tools/genie-shared";
import { genieChat, genieEventChat } from "../src/chat.js";

/* ----------------------------- fixtures ---------------------------- */

const SPACE = "space-1";

function makeMessage(over: Partial<GenieMessage> = {}): GenieMessage {
  return {
    space_id: SPACE,
    conversation_id: "conv-1",
    message_id: "msg-1",
    ...over,
  } as GenieMessage;
}

/**
 * Build a stub `WorkspaceClient` that only implements the three
 * `client.genie.*` methods the chat driver calls. Each hook is
 * optional - omitted hooks fall back to a no-op that throws, so a
 * test that uses an unmocked method fails loudly.
 */
interface ClientHooks {
  startConversation?: (req: {
    space_id: string;
    content: string;
  }) => Promise<{
    conversation_id?: string;
    message_id?: string;
    message?: GenieMessage;
  }>;
  createMessage?: (req: {
    space_id: string;
    conversation_id: string;
    content: string;
  }) => Promise<Record<string, unknown>>;
  getMessage?: (req: {
    space_id: string;
    conversation_id: string;
    message_id: string;
  }) => Promise<GenieMessage>;
}

function makeClient(hooks: ClientHooks): WorkspaceClient {
  const unsupported = (name: string) => async () => {
    throw new Error(`mock client: ${name} not configured`);
  };
  return {
    genie: {
      startConversation: hooks.startConversation ?? unsupported("startConversation"),
      createMessage: hooks.createMessage ?? unsupported("createMessage"),
      getMessage: hooks.getMessage ?? unsupported("getMessage"),
    },
  } as unknown as WorkspaceClient;
}

/* --------------------------- genieChat ----------------------------- */

describe("genieChat", () => {
  it("opens a conversation and polls getMessage until terminal", async () => {
    const startConversation = mock(async () => ({
      conversation_id: "conv-1",
      message_id: "msg-1",
      message: makeMessage({ status: "SUBMITTED" }),
    }));
    const getMessage = mock(async () => makeMessage({ status: "COMPLETED" }));

    const client = makeClient({ startConversation, getMessage });
    const seen: (string | undefined)[] = [];
    for await (const m of genieChat(SPACE, "hello?", {
      workspaceClient: client,
      pollIntervalMs: 0,
    })) {
      seen.push(m.status);
    }
    expect(startConversation).toHaveBeenCalledTimes(1);
    expect(getMessage).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(["SUBMITTED", "COMPLETED"]);
  });

  it("forwards space_id + content to startConversation", async () => {
    // Typed parameter so `mock.calls[0]` is the recorded
    // request, not an empty tuple. bun's `mock<T>(fn)` infers
    // call-args from `fn`'s signature.
    const startConversation = mock(
      async (_req: { space_id: string; content: string }) => ({
        conversation_id: "conv-1",
        message_id: "msg-1",
        message: makeMessage({ status: "COMPLETED" }),
      }),
    );
    const client = makeClient({ startConversation });
    for await (const _ of genieChat(SPACE, "what is up?", {
      workspaceClient: client,
      pollIntervalMs: 0,
    })) {
      // consume
    }
    const [req] = startConversation.mock.calls[0]!;
    expect(req).toEqual({ space_id: SPACE, content: "what is up?" });
  });

  it("appends to a seeded conversationId via createMessage (no startConversation)", async () => {
    const startConversation = mock(async () => {
      throw new Error("startConversation should not be called");
    });
    const createMessage = mock(async () => ({
      // Waiter wraps the message with an extra `wait` field; the
      // driver strips it before yielding.
      ...makeMessage({ status: "SUBMITTED" }),
      wait: async () => makeMessage({ status: "COMPLETED" }),
    }));
    const getMessage = mock(async () => makeMessage({ status: "COMPLETED" }));

    const client = makeClient({ startConversation, createMessage, getMessage });
    const seen: GenieMessage[] = [];
    for await (const m of genieChat(SPACE, "follow-up?", {
      workspaceClient: client,
      conversationId: "conv-1",
      pollIntervalMs: 0,
    })) {
      seen.push(m);
    }
    expect(startConversation).not.toHaveBeenCalled();
    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(getMessage).toHaveBeenCalledTimes(1);
    // First yield is the createMessage response with `wait`
    // stripped, so a downstream serializer doesn't see the
    // AsyncFunction value.
    expect(seen[0]).not.toHaveProperty("wait");
    expect(seen[0]?.status).toBe("SUBMITTED");
    expect(seen[1]?.status).toBe("COMPLETED");
  });

  it("supports multi-turn when the caller threads conversation_id between calls", async () => {
    // The driver itself only handles one turn; this test is here
    // to document the caller-driven multi-turn pattern shown in
    // the chat.ts docstring.
    let conversationId: string | undefined;
    const startConversation = mock(async () => ({
      conversation_id: "conv-1",
      message_id: "turn-1",
      message: makeMessage({
        message_id: "turn-1",
        status: "COMPLETED",
      }),
    }));
    const createMessage = mock(
      async (req: { conversation_id: string; content: string }) => ({
        ...makeMessage({
          message_id: `msg-${req.content}`,
          conversation_id: req.conversation_id,
          status: "COMPLETED",
        }),
        wait: async () => undefined,
      }),
    );
    const client = makeClient({ startConversation, createMessage });

    const turns = ["first", "second", "third"];
    const seen: string[] = [];
    for (const content of turns) {
      for await (const m of genieChat(SPACE, content, {
        workspaceClient: client,
        conversationId,
        pollIntervalMs: 0,
      })) {
        conversationId = m.conversation_id ?? conversationId;
        seen.push(m.message_id ?? "<unknown>");
      }
    }

    // One startConversation on the first turn, then two
    // createMessage calls threading the conversation id forward.
    expect(startConversation).toHaveBeenCalledTimes(1);
    expect(createMessage).toHaveBeenCalledTimes(2);
    expect(createMessage.mock.calls[0]![0]!.conversation_id).toBe("conv-1");
    expect(createMessage.mock.calls[1]![0]!.conversation_id).toBe("conv-1");
    expect(seen).toEqual(["turn-1", "msg-second", "msg-third"]);
  });

  it("dedupes identical consecutive snapshots via the distinct filter", async () => {
    // getMessage returns the same non-terminal snapshot twice
    // before flipping to COMPLETED. `poll`'s `filter: 'distinct'`
    // should drop the duplicate.
    let i = 0;
    const snapshots: GenieMessage[] = [
      makeMessage({ status: "ASKING_AI" }),
      makeMessage({ status: "ASKING_AI" }),
      makeMessage({ status: "COMPLETED" }),
    ];
    const startConversation = mock(async () => ({
      conversation_id: "conv-1",
      message_id: "msg-1",
      message: snapshots[i++]!,
    }));
    const getMessage = mock(async () => snapshots[i++]!);
    const client = makeClient({ startConversation, getMessage });

    const seen: (string | undefined)[] = [];
    for await (const m of genieChat(SPACE, "q?", {
      workspaceClient: client,
      pollIntervalMs: 0,
    })) {
      seen.push(m.status);
    }
    // Three producer calls (one start + two getMessage) but only
    // two yields because the middle snapshot is a dup.
    expect(seen).toEqual(["ASKING_AI", "COMPLETED"]);
  });

  it("exits cleanly when the consumer breaks after the first yield", async () => {
    // The generator is suspended at `yield` when we break, so the
    // driver's `finally` runs immediately (no in-flight `await` to
    // wait on). This is the common UI path: render the first
    // partial, bail out, no leaked work.
    const startConversation = mock(async () => ({
      conversation_id: "conv-1",
      message_id: "msg-1",
      message: makeMessage({ status: "ASKING_AI" }),
    }));
    const getMessage = mock(async () => makeMessage({ status: "ASKING_AI" }));
    const client = makeClient({ startConversation, getMessage });

    let iterations = 0;
    for await (const _ of genieChat(SPACE, "q?", {
      workspaceClient: client,
      pollIntervalMs: 60_000,
    })) {
      iterations++;
      break;
    }
    expect(iterations).toBe(1);
    expect(getMessage).not.toHaveBeenCalled();
  });

  it("propagates external abort through the iteration", async () => {
    // Tie an external `AbortController` in via `options.context`.
    // Aborting it mid-iteration aborts the chat-internal
    // controller (via `apiUtils.toContext` tying them), which
    // aborts `poll`'s internal controller (via `tieAbortSignal`),
    // which causes the next inter-poll sleep / signal check to
    // throw and tears down the generator.
    const startConversation = mock(async () => ({
      conversation_id: "conv-1",
      message_id: "msg-1",
      message: makeMessage({ status: "ASKING_AI" }),
    }));
    let getCount = 0;
    const getMessage = mock(async () => {
      getCount++;
      // Distinct snapshots so the distinct filter doesn't skip
      // them and we actually rack up iterations.
      return makeMessage({
        status: "ASKING_AI",
        auto_regenerate_count: getCount,
      });
    });
    const client = makeClient({ startConversation, getMessage });
    const controller = new AbortController();

    let iterations = 0;
    const consume = async () => {
      for await (const _ of genieChat(SPACE, "q?", {
        workspaceClient: client,
        pollIntervalMs: 0,
        context: controller.signal,
      })) {
        iterations++;
        if (iterations === 3) controller.abort();
      }
    };

    await expect(consume()).rejects.toThrow();
    expect(iterations).toBe(3);
  });

  it("throws on retry when startConversation returned no conversation_id", async () => {
    // First call returns a non-terminal message but no
    // conversation_id, so the driver records nothing. The
    // predicate keeps polling, but the producer refuses to retry
    // startConversation and throws.
    const startConversation = mock(async () => ({
      conversation_id: undefined,
      message_id: "msg-1",
      message: makeMessage({ status: "ASKING_AI" }),
    }));
    const client = makeClient({ startConversation });

    await expect(async () => {
      for await (const _ of genieChat(SPACE, "q?", {
        workspaceClient: client,
        pollIntervalMs: 0,
      })) {
        // consume; the error fires on the next producer call
      }
    }).toThrow(/Genie did not return a conversation id/);
  });
});

/* --------------------------- genieEventChat ------------------------- */

describe("genieEventChat", () => {
  it("yields message -> derived events -> result for a full turn", async () => {
    const messages: GenieMessage[] = [
      makeMessage({ status: "SUBMITTED" }),
      makeMessage({
        status: "ASKING_AI",
        attachments: [{ attachment_id: "q1", query: { query: "SELECT 1" } }],
      }),
      makeMessage({
        status: "COMPLETED",
        attachments: [{ attachment_id: "q1", query: { query: "SELECT 1" } }],
      }),
    ];
    let i = 0;
    const client = makeClient({
      startConversation: async () => ({
        conversation_id: "conv-1",
        message_id: "msg-1",
        message: messages[i++]!,
      }),
      getMessage: async () => messages[i++]!,
    });

    const events: GenieChatEvent[] = [];
    for await (const event of genieEventChat(SPACE, "hello?", {
      workspaceClient: client,
      pollIntervalMs: 0,
    })) {
      events.push(event);
    }

    // Per snapshot: `message` first, then derived events. Status
    // emits on every transition; attachment + query fire only on
    // snapshot 2 (their first appearance); `result` fires once on
    // the terminal snapshot.
    expect(events.map((e) => e.type)).toEqual([
      // snapshot 1: SUBMITTED, no attachments
      "message",
      "status",
      // snapshot 2: ASKING_AI, attachment + query appear
      "message",
      "status",
      "attachment",
      "query",
      // snapshot 3: COMPLETED, no per-attachment change
      "message",
      "status",
      "result",
    ]);
  });

  it("yields flat { type, ...fields } objects with strongly-typed fields per variant", async () => {
    const client = makeClient({
      startConversation: async () => ({
        conversation_id: "conv-1",
        message_id: "msg-1",
        message: makeMessage({
          status: "COMPLETED",
          attachments: [{ attachment_id: "q1", query: { query: "SELECT 1" } }],
        }),
      }),
    });

    const events: GenieChatEvent[] = [];
    for await (const event of genieEventChat(SPACE, "q?", {
      workspaceClient: client,
      pollIntervalMs: 0,
    })) {
      events.push(event);
    }

    // Narrow each variant via the discriminator and pull a field
    // that's only present on that variant. If the typing were
    // wrong, these lookups wouldn't compile.
    const statusEvent = events.find((e) => e.type === "status");
    if (statusEvent?.type !== "status") throw new Error("expected status event");
    expect(statusEvent.status).toBe("COMPLETED");

    const attachmentEvent = events.find((e) => e.type === "attachment");
    if (attachmentEvent?.type !== "attachment") {
      throw new Error("expected attachment event");
    }
    expect(attachmentEvent.attachment_type).toBe("query");
    expect(attachmentEvent.index).toBe(0);

    const resultEvent = events.find((e) => e.type === "result");
    if (resultEvent?.type !== "result") throw new Error("expected result event");
    expect(resultEvent.status).toBe("COMPLETED");
  });

  it("always yields { type: 'result' } as the LAST event of a terminal turn", async () => {
    const client = makeClient({
      startConversation: async () => ({
        conversation_id: "conv-1",
        message_id: "msg-1",
        message: makeMessage({ status: "COMPLETED" }),
      }),
    });
    const events: GenieChatEvent[] = [];
    for await (const event of genieEventChat(SPACE, "q?", {
      workspaceClient: client,
      pollIntervalMs: 0,
    })) {
      events.push(event);
    }
    expect(events.at(-1)?.type).toBe("result");
  });

  it("emits result with FAILED / CANCELLED statuses too", async () => {
    for (const status of ["FAILED", "CANCELLED"] as const) {
      const client = makeClient({
        startConversation: async () => ({
          conversation_id: "conv-1",
          message_id: "msg-1",
          message: makeMessage({ status }),
        }),
      });
      let result: GenieChatEvent | undefined;
      for await (const event of genieEventChat(SPACE, "q?", {
        workspaceClient: client,
        pollIntervalMs: 0,
      })) {
        if (event.type === "result") result = event;
      }
      if (result?.type !== "result") throw new Error("expected result event");
      expect(result.status).toBe(status);
    }
  });

  it("does not yield result when no terminal snapshot was reached (aborted mid-turn)", async () => {
    const startConversation = mock(async () => ({
      conversation_id: "conv-1",
      message_id: "msg-1",
      message: makeMessage({ status: "ASKING_AI" }),
    }));
    const getMessage = mock(async () =>
      makeMessage({ status: "ASKING_AI", auto_regenerate_count: 1 }),
    );
    const client = makeClient({ startConversation, getMessage });
    const controller = new AbortController();

    const events: GenieChatEvent[] = [];
    const consume = async () => {
      for await (const event of genieEventChat(SPACE, "q?", {
        workspaceClient: client,
        pollIntervalMs: 0,
        context: controller.signal,
      })) {
        events.push(event);
        if (events.filter((e) => e.type === "message").length === 2) {
          controller.abort();
        }
      }
    };
    await expect(consume()).rejects.toThrow();
    expect(events.some((e) => e.type === "result")).toBe(false);
  });

  it("backfills message_id from the legacy id field when Genie ships only id", async () => {
    // Regression: Genie's `startConversation` / `createMessage` inner
    // `message` payload sometimes lands with `id` set but `message_id`
    // undefined. Downstream subscribers (e.g. the demo UI's tool
    // pill) group every event for a turn by `message_id`; if it's
    // undefined on snapshot 1, the first batch of events lands in a
    // separate "anon" bucket from the later snapshots and the turn
    // looks split. `genieEventChat` defends against this by
    // back-filling `message_id` from `id` before yielding.
    const messages: GenieMessage[] = [
      // Snapshot 1: only `id` populated, no `message_id`. Mimics the
      // wire shape some Genie deployments emit on the first turn -
      // the legacy `id` carries the canonical message id while the
      // newer `message_id` field lands undefined.
      {
        ...makeMessage({ status: "SUBMITTED" }),
        id: "msg-1",
        message_id: undefined as never,
      },
      // Snapshot 2: terminal, both fields populated as normal.
      { ...makeMessage({ status: "COMPLETED" }), id: "msg-1" },
    ];
    let i = 0;
    const client = makeClient({
      startConversation: async () => ({
        conversation_id: "conv-1",
        message_id: "msg-1",
        message: messages[i++]!,
      }),
      getMessage: async () => messages[i++]!,
    });

    const events: GenieChatEvent[] = [];
    for await (const event of genieEventChat(SPACE, "q?", {
      workspaceClient: client,
      pollIntervalMs: 0,
    })) {
      events.push(event);
    }

    // Every event tagged with a `message_id` field should carry it,
    // even on the first snapshot where Genie only shipped `id`. The
    // `message` event holds the snapshot inline, so check both its
    // top-level field absence and its embedded message's
    // back-filled `message_id`.
    for (const e of events) {
      if (e.type === "message") {
        expect(e.message.message_id).toBe("msg-1");
      } else if ("message_id" in e) {
        expect(e.message_id).toBe("msg-1");
      }
    }
  });

  it("rejects when the underlying SDK call throws", async () => {
    const boom = new Error("nope");
    const client = makeClient({
      startConversation: async () => {
        throw boom;
      },
    });
    const consume = async () => {
      for await (const _ of genieEventChat(SPACE, "q?", {
        workspaceClient: client,
        pollIntervalMs: 0,
      })) {
        // consume
      }
    };
    await expect(consume()).rejects.toThrow(boom);
  });
});
