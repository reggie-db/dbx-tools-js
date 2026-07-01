import type { MastraThread } from "@dbx-tools/appkit-mastra-shared";
import { commonUtils, logUtils } from "@dbx-tools/shared";
import type { UIMessage } from "ai";
import { nanoid } from "nanoid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useMastraClient,
  useMastraModels,
  useMastraSuggestions,
  useMastraThreads,
} from "../lib/mastra-client.js";
import { ChatView } from "./chat-view.js";
import { dedupeSuggestions } from "./suggestions.js";
import type {
  ApprovalDecision,
  ChatStatus,
  ChatViewProps,
  PendingApproval,
  ThreadSummary,
  ToolEvent,
  ToolProgress,
} from "./types.js";

// Self-contained drop-in chat. `useMastraChat` drives the conversation
// over `@mastra/client-js`: `agent.stream()` returns a Response
// augmented with `processDataStream()`, which pushes typed Mastra
// chunks (text-delta, reasoning-delta, tool-*, ...) that we translate
// into `UIMessage` parts for `ChatView` to render.
//
// Approval gates ride the same channel: a paused `requireApproval: true`
// tool call emits a `tool-call-approval` chunk carrying
// `{ runId, payload: { toolCallId, toolName, args } }`. We surface that
// as an out-of-band entry in `pendingApprovalsByMessage` and wire
// `onResolveToolApproval` to `agent.approveToolCall` / `declineToolCall`,
// both of which return a fresh stream Response we run through the same
// chunk handler.
//
// On mount the transcript hydrates with the most recent page of thread
// history from the Mastra plugin's `/history` endpoint; scrolling near
// the top lazy-loads and prepends the next older page, with `ChatView`
// preserving the visual scroll position across the prepend.

const log = logUtils.logger("appkit-mastra-ui/chat");

const HISTORY_PAGE_SIZE = 20;

const makeUserMessage = (text: string): UIMessage => ({
  id: nanoid(),
  role: "user",
  parts: [{ type: "text", text }],
});

/** Project a wire {@link MastraThread} down to the sidebar's view. */
const toThreadSummary = (thread: MastraThread): ThreadSummary => ({
  id: thread.id,
  ...(thread.title ? { title: thread.title } : {}),
  updatedAt: thread.updatedAt,
});

/**
 * `localStorage` key the active thread id is persisted under, namespaced
 * by plugin mount + agent so two agents (or two apps on one origin)
 * don't clobber each other's "current conversation".
 */
const threadStorageKey = (basePath: string, agentId: string): string =>
  `dbx-mastra-thread:${basePath}:${agentId}`;

/** Read the persisted active thread id, tolerating storage being unavailable. */
const readStoredThreadId = (key: string): string | undefined => {
  try {
    return window.localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
};

/** Persist the active thread id, silently ignoring storage failures. */
const storeStoredThreadId = (key: string, id: string): void => {
  try {
    window.localStorage.setItem(key, id);
  } catch {
    // Private-mode / disabled storage: persistence is best-effort, the
    // in-memory selection still works for the session.
  }
};

/**
 * `localStorage` key the conversation sidebar's open/closed state is
 * persisted under, namespaced by plugin mount + agent so the user's
 * show/hide choice survives reloads without clobbering other mounts.
 */
const sidebarStorageKey = (basePath: string, agentId: string): string =>
  `dbx-mastra-sidebar:${basePath}:${agentId}`;

/** Read the persisted sidebar open flag, falling back when unset / unavailable. */
const readStoredSidebarOpen = (key: string, fallback: boolean): boolean => {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value === "1";
  } catch {
    return fallback;
  }
};

/** Persist the sidebar open flag, silently ignoring storage failures. */
const storeStoredSidebarOpen = (key: string, open: boolean): void => {
  try {
    window.localStorage.setItem(key, open ? "1" : "0");
  } catch {
    // Best-effort; the in-session toggle still works without persistence.
  }
};

// `tool-output` chunks carry arbitrary tool-defined payloads; only the
// `{type: ...}` shape we know how to render in `ToolSessionPill` is
// surfaced. Anything else (other tools, raw data, etc.) is ignored.
const isToolProgress = (value: unknown): value is ToolProgress =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string";

/** Options for {@link useMastraChat}. */
export interface UseMastraChatOptions {
  /**
   * Agent to converse with. Defaults to the Mastra plugin's registered
   * default agent (`clientConfig().defaultAgent`).
   */
  agentId?: string;
  /**
   * Surface the built-in model picker in the header, letting the user
   * override the serving endpoint per turn (via `X-Mastra-Model`).
   * Off by default so the drop-in renders a clean single-model chat;
   * when `false` the model catalogue isn't even fetched.
   */
  showModelPicker?: boolean;
  /**
   * Starter questions shown as one-tap buttons on the empty state.
   * When omitted, the drop-in auto-sources them from the agent's
   * Genie space sample questions (via the plugin's `/suggestions`
   * endpoint); when the agent has no Genie space the empty state
   * stays bare. Pass an explicit list to override that lookup, or
   * `[]` to force no suggestions.
   */
  suggestions?: string[];
  /**
   * Enable built-in conversation (thread) management: the chat tracks a
   * client-selected thread id, persists it across reloads, lists the
   * resource's conversations, and renders a sidebar to switch between
   * them / start new ones / delete them. On by default. Set `false` for
   * the classic single-thread chat anchored to the per-session cookie
   * (no sidebar, no thread tracking).
   */
  enableThreads?: boolean;
}

/**
 * Thrown out of the chunk handler to unwind `processDataStream` when
 * the user stops a turn. Callers treat it as a clean stop, not an
 * error, so the composer just returns to idle.
 */
class StreamAborted extends Error {}

/**
 * Headless driver for the Mastra chat experience. Owns the full
 * conversation lifecycle (streaming, tool-event tracking, approvals,
 * model selection, clear, and infinite-scroll-up history) over
 * `@mastra/client-js` and returns the exact prop bag {@link ChatView}
 * consumes. Use this when you want the drop-in behaviour but need to
 * render the view yourself; otherwise reach for {@link MastraChat}.
 */
export const useMastraChat = (
  options: UseMastraChatOptions = {},
): Omit<ChatViewProps, "className"> => {
  const [model, setModel] = useState("");
  // One client drives both the agent stream and the plugin's custom
  // routes (history / models / suggestions / embeds). Its identity is
  // stable across renders (memoized on `basePath` / `defaultAgent`) so
  // using it as a hook dep doesn't refire the initial-history fetch on
  // every parent render.
  const mastraClient = useMastraClient();
  // Apply the selected model as a per-request override header in place,
  // so the next `agent.stream()` picks it up without rebuilding the
  // client (which would refire history loads on every model change).
  useEffect(() => {
    mastraClient.setModelOverride(model || undefined);
  }, [mastraClient, model]);
  const agentId = options.agentId ?? mastraClient.defaultAgent;
  // Built-in conversation management. When on, the chat always drives an
  // explicit client thread id (rather than leaning on the per-session
  // cookie) so it can reference, persist, and switch between the
  // conversations a user owns. Selecting a thread routes every call
  // (stream + history + clear) at it via `mastraClient.setThreadId`.
  const enableThreads = options.enableThreads !== false;
  const threadKey = threadStorageKey(mastraClient.basePath, agentId);
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>(() =>
    enableThreads ? (readStoredThreadId(threadKey) ?? nanoid()) : undefined,
  );
  const {
    threads,
    loading: isLoadingThreads,
    refresh: refreshThreads,
  } = useMastraThreads(options.agentId, enableThreads);
  // Persist the active thread id so a reload reopens the same
  // conversation. Best-effort; storage may be unavailable.
  useEffect(() => {
    if (enableThreads && activeThreadId) storeStoredThreadId(threadKey, activeThreadId);
  }, [enableThreads, threadKey, activeThreadId]);
  // Conversation sidebar show/hide, persisted so the user's choice
  // sticks across reloads. The view exposes a header toggle wired to
  // `onToggleSidebar`; defaults open the first time.
  const sidebarKey = sidebarStorageKey(mastraClient.basePath, agentId);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() =>
    enableThreads ? readStoredSidebarOpen(sidebarKey, true) : true,
  );
  const toggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => {
      const next = !prev;
      storeStoredSidebarOpen(sidebarKey, next);
      return next;
    });
  }, [sidebarKey]);
  // Refresh the conversation list after a turn (a brand-new thread
  // appears, or its auto-generated title lands), a clear, or a delete.
  // Titles are generated server-side after the turn settles, so a short
  // delayed second pass picks them up.
  const refreshThreadsSoon = useCallback(() => {
    if (!enableThreads) return;
    refreshThreads();
    window.setTimeout(refreshThreads, 2000);
  }, [enableThreads, refreshThreads]);
  // Picker is opt-in: an omitted (or falsy) `showModelPicker` keeps it
  // hidden and skips the catalogue fetch entirely.
  const showModelPicker = Boolean(options.showModelPicker);
  const { models } = useMastraModels(showModelPicker);
  // Starter suggestions: an explicit `options.suggestions` always
  // wins (including `[]` to force none) and is rendered verbatim;
  // otherwise auto-source the agent's Genie space sample questions.
  // The fetch is skipped when the caller passed an explicit list so we
  // never round-trip for a value we won't use. Genie-sourced questions
  // run through the same dedupe + cap as in-conversation follow-ups so
  // initial and follow-up suggestions behave identically.
  const explicitSuggestions = options.suggestions;
  const { questions: genieSuggestions } = useMastraSuggestions(
    options.agentId,
    explicitSuggestions === undefined,
  );
  const suggestions = useMemo(
    () => explicitSuggestions ?? dedupeSuggestions(genieSuggestions),
    [explicitSuggestions, genieSuggestions],
  );
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>("ready");
  // The error from the last failed turn, surfaced by ChatView as a
  // destructive Alert. Cleared whenever a new turn starts.
  const [error, setError] = useState<Error | null>(null);
  // History pagination UI state. The authoritative "next page to
  // fetch" lives in `historyPageRef` so concurrent callers see the
  // updated value synchronously; `hasMoreHistory` and `isLoadingMore`
  // exist only to drive the spinner / load-more trigger in ChatView.
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  // Atomic guards for history fetches. `historyPageRef` is the next
  // page index to request and is bumped *before* the fetch fires so
  // back-to-back calls never request the same page. `historyInFlightRef`
  // gates concurrent calls so two scroll events near the top can't
  // both pass an `isLoadingMore === false` check (state updates are
  // async; refs are not).
  const historyPageRef = useRef(0);
  const historyInFlightRef = useRef(false);
  // Tool-call status keyed by the assistant message that owns them. We
  // need an out-of-band channel because `UIMessage["parts"]` doesn't
  // carry tool metadata in a way our `ChatView` reads. Indexed by
  // assistant id so regenerating one message doesn't wipe sibling
  // events, and rendered as inline shimmer/pills in the bubble.
  const [toolEventsByMessage, setToolEventsByMessage] = useState<
    Record<string, ToolEvent[]>
  >({});
  // Approval-gated tool calls keyed by assistant message. Populated
  // from `tool-call-approval` chunks during streaming and consumed by
  // ChatView's inline `ToolApprovalCard`. Each entry persists until
  // the user approves/denies (or the tool run completes another way),
  // at which point we drop the assistant key so the card disappears.
  const [pendingApprovalsByMessage, setPendingApprovalsByMessage] = useState<
    Record<string, PendingApproval[]>
  >({});
  // We mirror `messages` into a ref so sendMessage / regenerate can read
  // the latest history without putting side effects (the agent.stream
  // call) inside a state updater. State updaters get invoked twice in
  // React StrictMode, which would otherwise fire the stream request
  // twice and produce duplicate assistant responses.
  const messagesRef = useRef<UIMessage[]>([]);
  const lastUserTextRef = useRef<string | null>(null);

  const writeMessages = useCallback((next: UIMessage[]) => {
    messagesRef.current = next;
    setMessages(next);
  }, []);

  /**
   * Pipe a Mastra stream Response through the same chunk handler used
   * for the initial turn. `assistantId` identifies the in-progress
   * assistant message so resumed streams (from approveToolCall /
   * declineToolCall) keep mutating the same bubble instead of
   * spawning a new one. `runId` is captured in a ref so the approval
   * handler can later resume the suspended workflow.
   */
  const processStream = useCallback(
    async (
      stream: Awaited<ReturnType<ReturnType<typeof mastraClient.getAgent>["stream"]>>,
      assistantId: string,
      runIdRef: { current: string | null },
      signal: AbortSignal,
    ) => {
      // Replay carries forward whatever text / reasoning was already
      // accumulated for `assistantId` so resuming after approval
      // appends rather than overwrites.
      const existing = messagesRef.current.find((m) => m.id === assistantId);
      // Text is tracked as ordered segments, one per `text-start` the
      // agent emits. In a multi-step turn the model opens a fresh text
      // block in each step (a short preamble before each tool call),
      // and those blocks read as distinct "updates". Keeping them as
      // separate segments lets the bubble render each as its own block
      // instead of mashing "...summary.This is..." into one paragraph.
      const textSegments: string[] = [];
      let assistantReasoning = "";
      if (existing) {
        for (const part of existing.parts) {
          if (part.type === "text") textSegments.push(part.text);
          else if (part.type === "reasoning") {
            assistantReasoning += (part as { text?: string }).text ?? "";
          }
        }
      }
      // Append a text delta to the current (most recent) segment,
      // opening one if none exists yet (defensive: a provider could
      // stream deltas without a leading `text-start`).
      const appendText = (delta: string) => {
        if (textSegments.length === 0) textSegments.push("");
        textSegments[textSegments.length - 1] += delta;
      };

      const upsertAssistant = () => {
        const prev = messagesRef.current;
        const next = [...prev];
        const idx = next.findIndex((m) => m.id === assistantId);
        const parts: UIMessage["parts"] = [];
        if (assistantReasoning) {
          parts.push({ type: "reasoning", text: assistantReasoning });
        }
        // One text part per non-empty segment, in stream order, so the
        // bubble renders each step's text as its own block.
        for (const segment of textSegments) {
          if (segment.length > 0) parts.push({ type: "text", text: segment });
        }
        const message: UIMessage = {
          id: assistantId,
          role: "assistant",
          parts: parts.length > 0 ? parts : [{ type: "text", text: "" }],
        };
        if (idx === -1) next.push(message);
        else next[idx] = message;
        writeMessages(next);
      };

      // Patch the tool-event list for `assistantId` without clobbering
      // events that belong to other assistant turns in `messages`.
      const patchToolEvents = (update: (list: ToolEvent[]) => ToolEvent[]) => {
        setToolEventsByMessage((prev) => ({
          ...prev,
          [assistantId]: update(prev[assistantId] ?? []),
        }));
      };

      // Flip to "streaming" as soon as *any* visible signal lands
      // (text, reasoning, or a tool call), so the input switch from
      // "submitted" to "streaming" reflects real activity.
      let started = false;
      const markStreaming = () => {
        if (started) return;
        started = true;
        setStatus("streaming");
      };

      try {
        await stream.processDataStream({
          onChunk: async (chunk: { type: string; payload?: any; runId?: string }) => {
            // The user hit Stop: unwind the read loop. Throwing (rather
            // than returning) is what actually stops `processDataStream`
            // from pulling the next chunk; the wrapper below swallows it.
            if (signal.aborted) throw new StreamAborted();
            // Mastra stamps the stream's runId on most chunks. Capturing
            // it the first time we see it (rather than relying on a
            // separate API) keeps approve/decline calls correct even if
            // the client-supplied runId got overridden server-side.
            if (chunk.runId && !runIdRef.current) {
              runIdRef.current = chunk.runId;
            }
            switch (chunk.type) {
              case "text-start":
                // Open a new text segment so each step's preamble stays
                // a separate part (and thus a separate rendered block).
                textSegments.push("");
                break;
              case "text-delta":
                appendText(chunk.payload?.text ?? "");
                upsertAssistant();
                markStreaming();
                break;
              case "text-end":
                // Segment boundary is driven by `text-start`; nothing to
                // do on end - the next start opens the next segment.
                break;
              case "reasoning-delta":
                assistantReasoning += chunk.payload?.text ?? "";
                upsertAssistant();
                markStreaming();
                break;
              case "tool-call": {
                const { toolCallId, toolName } = chunk.payload ?? {};
                if (typeof toolCallId !== "string") break;
                patchToolEvents((list) => [
                  ...list,
                  { id: toolCallId, toolName, status: "running" },
                ]);
                // Make sure the assistant message exists in `messages`
                // even when the model goes straight to a tool call with
                // no preceding text, so the bubble (and its inline
                // tool indicator) renders right away.
                upsertAssistant();
                markStreaming();
                break;
              }
              case "tool-call-approval": {
                // Mastra paused the agent loop on a `requireApproval`
                // tool call. The chunk carries the runId we'll need to
                // resume the suspended workflow later. We surface the
                // approval card via `pendingApprovalsByMessage` so the
                // existing ChatView UI lights up without us having to
                // inject a synthetic data part.
                const { toolCallId, toolName, args } = chunk.payload ?? {};
                const approvalRunId = chunk.runId ?? runIdRef.current;
                if (
                  typeof toolCallId !== "string" ||
                  typeof toolName !== "string" ||
                  !approvalRunId
                ) {
                  log.warn("malformed tool-call-approval chunk", {
                    toolCallId,
                    toolName,
                    hasRunId: Boolean(approvalRunId),
                  });
                  break;
                }
                setPendingApprovalsByMessage((prev) => {
                  const existing = prev[assistantId] ?? [];
                  if (existing.some((a) => a.toolCallId === toolCallId)) {
                    return prev;
                  }
                  return {
                    ...prev,
                    [assistantId]: [
                      ...existing,
                      {
                        toolName,
                        toolCallId,
                        runId: approvalRunId,
                        input: args,
                      },
                    ],
                  };
                });
                upsertAssistant();
                markStreaming();
                break;
              }
              case "tool-result": {
                const toolCallId = chunk.payload?.toolCallId;
                if (typeof toolCallId !== "string") break;
                // Charts resolve from `[chart:<id>]` markers in the
                // assistant's prose (the model embeds the id returned
                // by `prepare_chart`), so the tool-result payload is
                // opaque here - we only need it to flip the pill.
                // Genie tools (`ask_genie`, `get_statement`,
                // `prepare_chart`) stream their entire progress
                // surface through `ctx.writer` and arrive on this
                // page via the `tool-output` path. The settled
                // tool-result return value is opaque to the UI -
                // we only need it to flip the pill to `done`.
                patchToolEvents((list) =>
                  list.map((e) => (e.id === toolCallId ? { ...e, status: "done" } : e)),
                );
                break;
              }
              case "tool-error": {
                const toolCallId = chunk.payload?.toolCallId;
                if (typeof toolCallId !== "string") break;
                patchToolEvents((list) =>
                  list.map((e) =>
                    e.id === toolCallId ? { ...e, status: "error" } : e,
                  ),
                );
                break;
              }
              case "tool-output": {
                // Mid-flight progress pushed by a tool via `ctx.writer`
                // (e.g. genie.ts forwarding `status`/`sql`/`data` events
                // from the Genie space). Append to the matching pill so
                // the user sees SQL/row info as soon as Genie publishes
                // it, not only when the LLM call completes.
                const { toolCallId, output } = chunk.payload ?? {};
                if (typeof toolCallId !== "string") break;
                if (!isToolProgress(output)) break;
                patchToolEvents((list) =>
                  list.map((e) =>
                    e.id === toolCallId
                      ? { ...e, progress: [...(e.progress ?? []), output] }
                      : e,
                  ),
                );
                break;
              }
              case "error": {
                // Surface a stream-reported error through the same path as
                // a thrown one: throwing here propagates out of
                // `processDataStream` to `driveStream`, which records the
                // message and pins `status` to "error" (a plain
                // setStatus would be clobbered by the clean-close "ready").
                const detail = chunk.payload?.error ?? chunk.payload?.message;
                throw new Error(
                  typeof detail === "string" && detail
                    ? detail
                    : "The assistant stream reported an error.",
                );
              }
              default:
                break;
            }
          },
        });
      } catch (error) {
        // A stop (signal aborted) unwinds the loop cleanly - not a
        // failure. Anything else is a real stream error and propagates
        // to the driver's catch.
        if (error instanceof StreamAborted || signal.aborted) return;
        throw error;
      }
    },
    [writeMessages],
  );

  // The currently-active assistant turn. Refreshed on every fresh
  // `runStream` and consumed by `handleApproval` so resumed streams
  // attach back to the same bubble. Persists across renders because
  // approvals can be resolved long after the originating render
  // committed.
  const currentAssistantIdRef = useRef<string | null>(null);
  // Mastra runId for the active turn. Pre-seeded by `runStream`
  // (client-supplied) and mutated in-place by `processStream` when
  // chunks land. Read by `handleApproval` to call `approveToolCall`
  // / `declineToolCall` against the right workflow instance.
  const currentRunIdRef = useRef<string | null>(null);
  // Abort handle for the active turn. `stop()` fires it; `processStream`
  // watches the signal to unwind. Each new turn supersedes the prior
  // controller so an in-flight run can't bleed into the next.
  const abortRef = useRef<AbortController | null>(null);
  // Monotonic token identifying the active turn. A run only writes its
  // terminal status (`ready`/`error`) if its token is still current, so
  // a stopped or superseded run can't clobber a newer turn's state.
  const runTokenRef = useRef(0);

  /**
   * Run one streamed turn end-to-end: arm a fresh abort controller,
   * supersede any prior turn, flip to `submitted`, open the stream via
   * `open`, and pipe it through {@link processStream}. Shared by the
   * initial send/regenerate path and the approval-resume path so the
   * stop/supersede/error bookkeeping lives in exactly one place.
   */
  const driveStream = useCallback(
    async (
      assistantId: string,
      open: () => Promise<
        Awaited<ReturnType<ReturnType<typeof mastraClient.getAgent>["stream"]>>
      >,
    ) => {
      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;
      const token = ++runTokenRef.current;
      currentAssistantIdRef.current = assistantId;
      setError(null);
      setStatus("submitted");
      try {
        const stream = await open();
        await processStream(stream, assistantId, currentRunIdRef, controller.signal);
        if (runTokenRef.current === token) {
          setStatus("ready");
          // A completed turn may have created the thread (first message)
          // or triggered server-side title generation; sync the list.
          refreshThreadsSoon();
        }
      } catch (caught) {
        // A superseded or stopped run (token moved on) leaves the status
        // to the newer turn / `stop()`; only the still-active run
        // surfaces the error.
        if (runTokenRef.current !== token) return;
        log.error("stream error", {
          error: commonUtils.errorMessage(caught),
        });
        setError(caught instanceof Error ? caught : new Error(String(caught)));
        setStatus("error");
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [mastraClient, processStream, refreshThreadsSoon],
  );

  const runStream = useCallback(
    (history: UIMessage[]) => {
      const assistantId = nanoid();
      const runId = nanoid();
      // Pre-seed the runId so a follow-up `approveToolCall` stays
      // anchored to the same workflow even if the first chunk is
      // delayed. Server is authoritative; if it overrides we pick that
      // up via `currentRunIdRef` inside `processStream`.
      currentRunIdRef.current = runId;
      return driveStream(assistantId, () => {
        const agent = mastraClient.getAgent(agentId);
        // Flatten each turn's text parts into role/content messages. The
        // cast to `agent.stream`'s own input type is needed because a
        // single object literal carries a *union* `role`
        // (`"user" | "assistant" | "system"`), which TS won't narrow to
        // any one arm of Mastra's discriminated message union on its own.
        const messagesForAgent = history.flatMap((m) =>
          m.parts
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => ({ role: m.role, content: p.text })),
        ) as Parameters<typeof agent.stream>[0];
        return agent.stream(messagesForAgent, { runId });
      });
    },
    [driveStream, mastraClient, agentId],
  );

  /**
   * Abort the in-flight turn: invalidate its token so its completion
   * can't flip status, signal `processStream` to unwind, and return the
   * composer to idle. Any partial assistant text already streamed stays
   * in the transcript.
   */
  const stop = useCallback(() => {
    runTokenRef.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    setError(null);
    setStatus("ready");
  }, []);

  /**
   * Approve or deny an in-flight `requireApproval` tool call. The
   * suspended workflow lives on the server keyed by `runId`; we
   * call `agent.approveToolCall` / `declineToolCall` to resume it
   * and pipe the resulting chunk stream back into the same bubble
   * `runStream` was building.
   */
  const handleApproval = useCallback(
    async (decision: ApprovalDecision) => {
      const { runId, toolCallId, toolName } = decision;
      const assistantId = currentAssistantIdRef.current;
      if (!runId || !assistantId) {
        log.warn("approval missing runId or assistantId, cannot resume", {
          tool: toolName,
          toolCallId,
          hasRunId: Boolean(runId),
          hasAssistantId: Boolean(assistantId),
        });
        return;
      }
      // Drop the card immediately so the user gets feedback even if
      // the resume request takes a moment.
      setPendingApprovalsByMessage((prev) => {
        const existing = prev[assistantId];
        if (!existing) return prev;
        const next = existing.filter((a) => a.toolCallId !== toolCallId);
        if (next.length === 0) {
          const { [assistantId]: _drop, ...rest } = prev;
          return rest;
        }
        return { ...prev, [assistantId]: next };
      });
      log.info(decision.approved ? "approved" : "denied", {
        tool: toolName,
        toolCallId,
        runId,
      });
      await driveStream(assistantId, () => {
        const agent = mastraClient.getAgent(agentId);
        return decision.approved
          ? agent.approveToolCall({ runId, toolCallId })
          : agent.declineToolCall({ runId, toolCallId });
      });
    },
    [driveStream, mastraClient, agentId],
  );

  const sendMessage = useCallback<ChatViewProps["sendMessage"]>(
    (message) => {
      const text = message.text ?? "";
      if (!text) return;
      lastUserTextRef.current = text;
      const next = [...messagesRef.current, makeUserMessage(text)];
      writeMessages(next);
      void runStream(next);
    },
    [runStream, writeMessages],
  );

  /**
   * Wipe the current thread on the server and reset every piece of
   * client-side state that mirrored it. The session cookie that
   * anchors the thread id is preserved by the server, so the next
   * turn opens against the same (now empty) thread - no reload
   * needed. Suspended approval cards belong to the cleared turns
   * and would be unresolvable anyway, so we drop them too.
   */
  const handleClear = useCallback(async () => {
    try {
      const result = await mastraClient.clearHistory({ agentId });
      log.info("history cleared", { cleared: result.cleared });
    } catch (error) {
      log.error("history clear error", {
        error: commonUtils.errorMessage(error),
      });
      // Reset UI anyway so the user isn't stuck staring at a stale
      // transcript; the server-side cleanup will catch up on next
      // request or session expiry.
    }
    writeMessages([]);
    setToolEventsByMessage({});
    setPendingApprovalsByMessage({});
    setHasMoreHistory(false);
    historyPageRef.current = 1;
    lastUserTextRef.current = null;
    currentAssistantIdRef.current = null;
    currentRunIdRef.current = null;
    setError(null);
    setStatus("ready");
    // Clearing deletes the thread server-side, so drop it from the list.
    refreshThreadsSoon();
  }, [mastraClient, agentId, writeMessages, refreshThreadsSoon]);

  /**
   * Switch the active conversation to `threadId`. Aborts any in-flight
   * turn on the current thread, then flips `activeThreadId` - the
   * history effect re-points the client at the thread, resets the
   * transcript, and loads its messages. No-op when already active.
   */
  const selectThread = useCallback(
    (threadId: string) => {
      if (threadId === activeThreadId) return;
      runTokenRef.current++;
      abortRef.current?.abort();
      abortRef.current = null;
      setActiveThreadId(threadId);
    },
    [activeThreadId],
  );

  /**
   * Start a fresh conversation: mint a new thread id and make it active.
   * The thread row materializes server-side (and joins the list) on the
   * first message; until then the transcript is just empty.
   */
  const newThread = useCallback(() => {
    runTokenRef.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    setActiveThreadId(nanoid());
  }, []);

  /**
   * Delete a conversation by id, then refresh the list. Deleting the
   * active conversation rolls onto a fresh empty thread so the user is
   * never left pointed at a thread that no longer exists.
   */
  const deleteThread = useCallback(
    async (threadId: string) => {
      try {
        const result = await mastraClient.removeThread(threadId, { agentId });
        log.info("thread deleted", { threadId, deleted: result.deleted });
      } catch (error) {
        log.error("thread delete error", {
          threadId,
          error: commonUtils.errorMessage(error),
        });
      }
      if (threadId === activeThreadId) {
        runTokenRef.current++;
        abortRef.current?.abort();
        abortRef.current = null;
        setActiveThreadId(nanoid());
      }
      refreshThreads();
    },
    [mastraClient, agentId, activeThreadId, refreshThreads],
  );

  const regenerate = useCallback(() => {
    if (!lastUserTextRef.current) return;
    // Drop the last assistant message before regenerating so the new
    // stream replaces it instead of appending alongside. Clear the
    // tool events and pending approvals for that turn too so the
    // regenerated bubble starts with a blank slate.
    const prev = messagesRef.current;
    const lastAssistant =
      prev.length > 0 && prev.at(-1)?.role === "assistant" ? prev.at(-1) : null;
    const trimmed = lastAssistant ? prev.slice(0, -1) : prev;
    if (lastAssistant) {
      setToolEventsByMessage((map) => {
        const { [lastAssistant.id]: _events, ...rest } = map;
        return rest;
      });
      setPendingApprovalsByMessage((map) => {
        const { [lastAssistant.id]: _approvals, ...rest } = map;
        return rest;
      });
    }
    writeMessages(trimmed);
    void runStream(trimmed);
  }, [runStream, writeMessages]);

  // Hydrate the transcript with the latest page of stored messages on
  // mount and whenever the active thread (or agent) changes. Pointing
  // the client at `activeThreadId` here - before any fetch or stream -
  // is what makes every subsequent call target the selected thread. We
  // re-run when `basePath`, `agentId`, or `activeThreadId` changes (the
  // model only affects subsequent generations, not stored history, so
  // model changes don't refire this).
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    // Route the agent stream + custom routes at the active thread. When
    // thread management is off, `activeThreadId` is undefined and the
    // header is cleared, so the server falls back to the session cookie.
    mastraClient.setThreadId(activeThreadId);
    // Reset per-thread client state so switching conversations never
    // bleeds the prior thread's transcript / pills / approvals through.
    writeMessages([]);
    setToolEventsByMessage({});
    setPendingApprovalsByMessage({});
    historyInFlightRef.current = true;
    setIsLoadingHistory(true);
    mastraClient
      .history({
        agentId,
        page: 0,
        perPage: HISTORY_PAGE_SIZE,
        signal: controller.signal,
      })
      .then((response) => {
        if (cancelled) return;
        writeMessages(response.uiMessages as unknown as UIMessage[]);
        // Tool events are live-stream only - the progress that
        // built the SQL/thinking pills isn't persisted, so a
        // reload renders the settled assistant text + any
        // `[chart:<id>]` markers it carries. Charts re-resolve
        // out-of-band: `<ChartSlot>` long-polls the chart cache
        // by id; unknown / TTL-expired ids silently drop.
        historyPageRef.current = 1;
        setHasMoreHistory(response.hasMore);
      })
      .catch((error: unknown) => {
        if (cancelled || (error as { name?: string }).name === "AbortError") return;
        log.error("history load error", {
          error: commonUtils.errorMessage(error),
        });
        setHasMoreHistory(false);
      })
      .finally(() => {
        historyInFlightRef.current = false;
        if (!cancelled) setIsLoadingHistory(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [mastraClient, agentId, activeThreadId, writeMessages]);

  // Lazy-load the next older page when the user scrolls near the top
  // of the transcript. ChatView captures the pre-prepend scroll
  // anchor before invoking us, so the visual position is preserved
  // across the prepend; we just have to keep `messagesRef` and
  // `messages` in sync via `writeMessages`.
  //
  // Concurrency: `historyInFlightRef` blocks overlapping calls and
  // `historyPageRef` is bumped synchronously *before* the fetch
  // fires, so two scroll events that both observe `isLoadingMore`
  // mid-render can never request the same page twice (which would
  // produce duplicate UIMessage ids and the React duplicate-key
  // warning).
  const loadOlderHistory = useCallback(() => {
    if (historyInFlightRef.current || !hasMoreHistory) return;
    historyInFlightRef.current = true;
    setIsLoadingMore(true);
    const page = historyPageRef.current;
    historyPageRef.current = page + 1;
    mastraClient
      .history({ agentId, page, perPage: HISTORY_PAGE_SIZE })
      .then((response) => {
        const uiMessages = response.uiMessages as unknown as UIMessage[];
        if (uiMessages.length > 0) {
          writeMessages([...uiMessages, ...messagesRef.current]);
        }
        setHasMoreHistory(response.hasMore);
      })
      .catch((error: unknown) => {
        log.error("history load-more error", {
          page,
          error: commonUtils.errorMessage(error),
        });
        // Roll back the page so a manual retry hits the same page,
        // and stop the trigger so we don't thrash the failed call.
        historyPageRef.current = page;
        setHasMoreHistory(false);
      })
      .finally(() => {
        historyInFlightRef.current = false;
        setIsLoadingMore(false);
      });
  }, [hasMoreHistory, mastraClient, agentId, writeMessages]);

  return {
    messages,
    status,
    error,
    sendMessage,
    regenerate,
    onStop: stop,
    suggestions,
    toolEventsByMessage,
    pendingApprovalsByMessage,
    onResolveToolApproval: handleApproval,
    // Picker is opt-in: only hand ChatView the catalogue + change
    // handler when `showModelPicker` is on, otherwise the header hides
    // it (ChatView shows it only when both are present).
    models: showModelPicker ? models : undefined,
    model,
    onModelChange: showModelPicker ? setModel : undefined,
    onLoadMore: loadOlderHistory,
    isLoadingMore,
    hasMore: hasMoreHistory,
    isLoadingHistory,
    onClear: handleClear,
    // Conversation management: hand ChatView the thread list + handlers
    // only when enabled, so the sidebar stays hidden for the classic
    // single-thread chat (ChatView keys the sidebar off these props).
    ...(enableThreads
      ? {
          threads: threads.map(toThreadSummary),
          ...(activeThreadId ? { activeThreadId } : {}),
          isLoadingThreads,
          onSelectThread: selectThread,
          onNewThread: newThread,
          onDeleteThread: deleteThread,
          // Persisted sidebar visibility, controlled from the driver so
          // the show/hide choice survives reloads.
          sidebarOpen,
          onToggleSidebar: toggleSidebar,
        }
      : {}),
  };
};

/** Props for {@link MastraChat}. */
export interface MastraChatProps extends UseMastraChatOptions {
  /** Extra classes merged onto the chat's root layout container. */
  className?: string;
}

/**
 * Self-contained chat component. Mount it anywhere under the Mastra
 * plugin and it wires itself from the plugin's published client config
 * (mount paths + default agent) via {@link useMastraChat}, then renders
 * the conversation through {@link ChatView}. The GenieChat-equivalent
 * drop-in: full streaming, tool-session pills, approvals, stop control,
 * history pagination, and built-in conversation management (a sidebar
 * of the resource's threads with select / new / delete, persisted
 * across reloads) - all with no host wiring. The model picker is opt-in
 * via `showModelPicker`; thread management is on by default and can be
 * turned off with `enableThreads: false`.
 */
export const MastraChat = ({ className, ...options }: MastraChatProps) => {
  const chat = useMastraChat(options);
  return <ChatView {...chat} className={className} />;
};
