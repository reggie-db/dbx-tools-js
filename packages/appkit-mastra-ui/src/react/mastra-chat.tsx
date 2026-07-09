import {
  MLFLOW_TRACE_ID_HEADER,
  type MastraThread,
} from "@dbx-tools/appkit-mastra-shared";
import { commonUtils, logUtils } from "@dbx-tools/shared";
import type { UIMessage } from "ai";
import { nanoid } from "nanoid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { exportChat, type EmbedResolver, type ExportFormat } from "../lib/export.js";
import {
  useMastraClient,
  useMastraModels,
  useMastraSuggestions,
  useMastraThreads,
} from "../lib/mastra-client.js";
import type { MastraStreamResponse } from "../lib/mastra-stream.js";
import {
  createThreadSession,
  DEFAULT_THREAD_SESSION_KEY,
  isSessionRunning,
  sessionKey,
  type ThreadSession,
} from "../lib/thread-sessions.js";
import { ChatView } from "./chat-view.js";
import { dedupeSuggestions } from "./suggestions.js";
import type {
  ApprovalDecision,
  ChatViewProps,
  FeedbackSubmission,
  MessageFeedback,
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
// `onResolveToolApproval` to {@link MastraPluginClient.approveToolCallStream}
// / `declineToolCallStream`, which read SSE directly and avoid a stock
// `@mastra/client-js` bug on resumed approval streams.
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

/** Max characters of the first user message used as a provisional thread title. */
const TITLE_PREVIEW_MAX = 60;

/**
 * Derive a provisional sidebar title from a user's first message:
 * whitespace-collapsed and truncated with an ellipsis. Shown the instant
 * a brand-new conversation gets its first question so the row stops
 * reading "New conversation", until the server's auto-generated title
 * lands and supersedes it.
 */
const deriveThreadTitle = (text: string): string => {
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.length > TITLE_PREVIEW_MAX
    ? `${clean.slice(0, TITLE_PREVIEW_MAX - 1)}…`
    : clean;
};

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

/**
 * Pull the MLflow trace id (`tr-<hex>`) the server stamped on a stream
 * response, if present. `@mastra/client-js`'s `agent.stream()` returns
 * a Response-shaped object, so the header is read defensively (the
 * shape isn't guaranteed across client versions). Returns `undefined`
 * when absent - which is the "no feedback for this turn" signal.
 */
const readMlflowTraceId = (stream: unknown): string | undefined => {
  const headers = (stream as { headers?: { get?: (name: string) => string | null } })
    ?.headers;
  const raw = headers?.get?.(MLFLOW_TRACE_ID_HEADER);
  return raw?.trim() || undefined;
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
  /**
   * Enable chat export. Off by default (opt-in). When on, the header
   * shows an "Export" menu for the whole conversation and each assistant
   * bubble shows a per-message export menu. Both offer PDF (via the
   * browser print dialog) and Markdown; charts and data tables are
   * inlined into the export so it renders reliably offline.
   */
  enableExport?: boolean;
  /**
   * Surface per-message feedback controls (thumbs up/down + a comment
   * popover) that log to MLflow as trace assessments.
   *
   * Defaults to whatever {@link enableExport} is (feedback and export
   * are the two "quality loop" affordances, so turning on export opts
   * into feedback too); pass an explicit `true` / `false` to override.
   * Regardless of this flag, controls only actually render when the
   * server reports MLflow logging is enabled (`clientConfig.feedbackEnabled`)
   * and the turn produced a trace id - so enabling it on a deployment
   * without MLflow tracing is a safe no-op.
   */
  enableFeedback?: boolean;
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
  // routes (history / threads / models / suggestions / feedback /
  // embeds). Its identity is
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
  // Export is opt-in (default off): the host turns it on explicitly.
  const enableExport = options.enableExport === true;
  // Feedback defaults to export's setting; an explicit option overrides.
  // It only actually surfaces when the server reports MLflow logging is
  // wired (so a trace exists to attach the assessment to).
  const enableFeedback = options.enableFeedback ?? enableExport;
  const feedbackAvailable = enableFeedback && mastraClient.feedbackEnabled;
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
  // Optimistic sidebar rows for conversations the user just started but
  // that the server list hasn't returned yet. A new thread's id is
  // client-minted, and the server only materializes the thread row once
  // the first turn lands (with its auto-title arriving a beat later), so
  // without this the sidebar wouldn't show a brand-new conversation
  // until the delayed post-turn refresh. Keyed by thread id; each entry
  // is pruned once the real server row supersedes it.
  const [optimisticThreads, setOptimisticThreads] = useState<
    Record<string, ThreadSummary>
  >({});
  // Optimistic title overrides for threads the user just renamed, keyed
  // by thread id. Applied over the server rows in `sidebarThreads` so the
  // new name shows instantly; each entry is dropped once the server list
  // reports the matching title (or the rename request fails).
  const [renamedThreads, setRenamedThreads] = useState<Record<string, string>>(
    {},
  );
  // Provisional titles derived from a thread's first user message, keyed
  // by thread id. Shown the instant a brand-new conversation gets its
  // first question so the row stops reading "New conversation"; dropped
  // as soon as the server's auto-generated title lands (see the prune
  // effect below). A manual rename (`renamedThreads`) still wins.
  const [provisionalTitles, setProvisionalTitles] = useState<
    Record<string, string>
  >({});
  // Surface the active thread in the sidebar immediately (called when its
  // first message is sent). Upserts an untitled row stamped "now" so it
  // sorts to the top; the server row replaces it on the next refresh.
  const noteThreadActivity = useCallback(
    (threadId: string) => {
      if (!enableThreads) return;
      setOptimisticThreads((prev) => ({
        ...prev,
        [threadId]: {
          ...prev[threadId],
          id: threadId,
          updatedAt: new Date().toISOString(),
        },
      }));
    },
    [enableThreads],
  );
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
  const [sessionsTick, setSessionsTick] = useState(0);
  const sessionsRef = useRef<Map<string, ThreadSession>>(new Map());
  const notifySessions = useCallback(() => {
    setSessionsTick((tick) => tick + 1);
  }, []);
  const getSession = useCallback((threadId: string): ThreadSession => {
    let session = sessionsRef.current.get(threadId);
    if (!session) {
      session = createThreadSession();
      sessionsRef.current.set(threadId, session);
    }
    return session;
  }, []);
  const updateSession = useCallback(
    (threadId: string, updater: (session: ThreadSession) => ThreadSession) => {
      const next = updater(getSession(threadId));
      sessionsRef.current.set(threadId, next);
      notifySessions();
    },
    [getSession, notifySessions],
  );
  const activeKey = sessionKey(activeThreadId);
  const activeSession = useMemo(
    () => getSession(activeKey),
    [activeKey, getSession, sessionsTick],
  );
  const streamingThreadIds = useMemo(() => {
    const ids: string[] = [];
    for (const [id, session] of sessionsRef.current.entries()) {
      if (id === DEFAULT_THREAD_SESSION_KEY) continue;
      if (isSessionRunning(session)) ids.push(id);
    }
    return ids;
  }, [sessionsTick]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const historyInFlightRef = useRef(false);
  const feedbackByMessageRef = useRef<Record<string, MessageFeedback>>({});
  feedbackByMessageRef.current = activeSession.feedbackByMessage;

  const writeMessages = useCallback(
    (threadId: string, next: UIMessage[]) => {
      updateSession(threadId, (session) => ({ ...session, messages: next }));
    },
    [updateSession],
  );

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
      threadId: string,
      stream: MastraStreamResponse,
      assistantId: string,
      runIdRef: { current: string | null },
      signal: AbortSignal,
    ) => {
      const traceId = readMlflowTraceId(stream);
      if (traceId) {
        updateSession(threadId, (session) =>
          session.feedbackByMessage[assistantId]?.traceId === traceId
            ? session
            : {
                ...session,
                feedbackByMessage: {
                  ...session.feedbackByMessage,
                  [assistantId]: {
                    ...session.feedbackByMessage[assistantId],
                    traceId,
                  },
                },
              },
        );
      }
      const existing = getSession(threadId).messages.find((m) => m.id === assistantId);
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
        const prev = getSession(threadId).messages;
        const next = [...prev];
        const idx = next.findIndex((m) => m.id === assistantId);
        const parts: UIMessage["parts"] = [];
        if (assistantReasoning) {
          parts.push({ type: "reasoning", text: assistantReasoning });
        }
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
        writeMessages(threadId, next);
      };

      const patchToolEvents = (update: (list: ToolEvent[]) => ToolEvent[]) => {
        updateSession(threadId, (session) => ({
          ...session,
          toolEventsByMessage: {
            ...session.toolEventsByMessage,
            [assistantId]: update(session.toolEventsByMessage[assistantId] ?? []),
          },
        }));
      };

      let started = false;
      const markStreaming = () => {
        if (started) return;
        started = true;
        updateSession(threadId, (session) =>
          session.status === "streaming" ? session : { ...session, status: "streaming" },
        );
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
              updateSession(threadId, (session) => ({ ...session, runId: chunk.runId! }));
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
                updateSession(threadId, (session) => {
                  const existingApprovals = session.pendingApprovalsByMessage[assistantId] ?? [];
                  if (existingApprovals.some((a) => a.toolCallId === toolCallId)) {
                    return session;
                  }
                  return {
                    ...session,
                    pendingApprovalsByMessage: {
                      ...session.pendingApprovalsByMessage,
                      [assistantId]: [
                        ...existingApprovals,
                        {
                          toolName,
                          toolCallId,
                          runId: approvalRunId,
                          input: args,
                        },
                      ],
                    },
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
    [getSession, updateSession, writeMessages],
  );

  const driveStream = useCallback(
    async (
      threadId: string,
      assistantId: string,
      open: () => Promise<MastraStreamResponse>,
    ) => {
      const controller = new AbortController();
      let token = 0;
      updateSession(threadId, (session) => {
        session.abortController?.abort();
        token = session.runToken + 1;
        return {
          ...session,
          abortController: controller,
          assistantId,
          runId: session.runId,
          error: null,
          status: "submitted",
          runToken: token,
        };
      });
      const runIdRef = { current: getSession(threadId).runId };
      try {
        const streamThreadId =
          threadId === DEFAULT_THREAD_SESSION_KEY ? undefined : threadId;
        mastraClient.setThreadId(streamThreadId);
        const stream = await open();
        await processStream(threadId, stream, assistantId, runIdRef, controller.signal);
        updateSession(threadId, (session) => {
          if (session.runToken !== token) return session;
          return {
            ...session,
            status: "ready",
            abortController: session.abortController === controller ? null : session.abortController,
            runId: runIdRef.current,
          };
        });
        if (getSession(threadId).runToken === token) {
          refreshThreadsSoon();
        }
      } catch (caught) {
        if (getSession(threadId).runToken !== token) return;
        log.error("stream error", {
          error: commonUtils.errorMessage(caught),
        });
        updateSession(threadId, (session) => ({
          ...session,
          error: commonUtils.toError(caught),
          status: "error",
          abortController: session.abortController === controller ? null : session.abortController,
          runId: runIdRef.current,
        }));
      }
    },
    [getSession, mastraClient, processStream, refreshThreadsSoon, updateSession],
  );

  const runStream = useCallback(
    (threadId: string, history: UIMessage[]) => {
      const assistantId = nanoid();
      const runId = nanoid();
      updateSession(threadId, (session) => ({
        ...session,
        assistantId,
        runId,
      }));
      return driveStream(threadId, assistantId, () => {
        const agent = mastraClient.getAgent(agentId);
        const messagesForAgent = history.flatMap((m) =>
          m.parts
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => ({ role: m.role, content: p.text })),
        ) as Parameters<typeof agent.stream>[0];
        return agent.stream(messagesForAgent, { runId }) as Promise<MastraStreamResponse>;
      });
    },
    [driveStream, mastraClient, agentId, updateSession],
  );

  const stop = useCallback(() => {
    const threadId = activeKey;
    updateSession(threadId, (session) => {
      if (!isSessionRunning(session)) return session;
      session.abortController?.abort();
      return {
        ...session,
        abortController: null,
        runToken: session.runToken + 1,
        error: null,
        status: "ready",
      };
    });
  }, [activeKey, updateSession]);

  /**
   * Approve or deny an in-flight `requireApproval` tool call. The
   * suspended workflow lives on the server keyed by `runId`; we resume
   * via {@link MastraPluginClient.approveToolCallStream} /
   * `declineToolCallStream` and pipe the SSE chunk stream back into
   * the same bubble `runStream` was building.
   */
  const handleApproval = useCallback(
    async (decision: ApprovalDecision) => {
      const { runId: decisionRunId, toolCallId, toolName } = decision;
      const session = getSession(activeKey);
      const assistantId = session.assistantId;
      const runId = decisionRunId ?? session.runId;
      if (!runId || !assistantId) {
        log.warn("approval missing runId or assistantId, cannot resume", {
          tool: toolName,
          toolCallId,
          hasRunId: Boolean(runId),
          hasAssistantId: Boolean(assistantId),
        });
        return;
      }
      updateSession(activeKey, (current) => {
        const existing = current.pendingApprovalsByMessage[assistantId];
        if (!existing) return current;
        const next = existing.filter((a) => a.toolCallId !== toolCallId);
        if (next.length === 0) {
          const { [assistantId]: _drop, ...rest } = current.pendingApprovalsByMessage;
          return { ...current, pendingApprovalsByMessage: rest };
        }
        return {
          ...current,
          pendingApprovalsByMessage: { ...current.pendingApprovalsByMessage, [assistantId]: next },
        };
      });
      log.info(decision.approved ? "approved" : "denied", {
        tool: toolName,
        toolCallId,
        runId,
      });
      await driveStream(activeKey, assistantId, () =>
        decision.approved
          ? mastraClient.approveToolCallStream(agentId, { runId, toolCallId })
          : mastraClient.declineToolCallStream(agentId, { runId, toolCallId }),
      );
    },
    [activeKey, driveStream, getSession, mastraClient, agentId, updateSession],
  );

  const sendMessage = useCallback<ChatViewProps["sendMessage"]>(
    (message) => {
      const text = message.text ?? "";
      if (!text) return;
      const threadId = activeKey;
      updateSession(threadId, (session) => ({ ...session, lastUserText: text }));
      if (activeThreadId) {
        noteThreadActivity(activeThreadId);
        if (getSession(threadId).messages.length === 0) {
          const provisional = deriveThreadTitle(text);
          if (provisional) {
            setProvisionalTitles((prev) =>
              prev[activeThreadId]
                ? prev
                : { ...prev, [activeThreadId]: provisional },
            );
          }
        }
      }
      const next = [...getSession(threadId).messages, makeUserMessage(text)];
      writeMessages(threadId, next);
      void runStream(threadId, next);
    },
    [runStream, writeMessages, activeThreadId, activeKey, getSession, noteThreadActivity, updateSession],
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
    const threadId = activeKey;
    try {
      const result = await mastraClient.clearHistory({ agentId });
      log.info("history cleared", { cleared: result.cleared });
    } catch (error) {
      log.error("history clear error", {
        error: commonUtils.errorMessage(error),
      });
    }
    const session = getSession(threadId);
    session.abortController?.abort();
    updateSession(threadId, () => ({
      ...createThreadSession(),
      historyLoaded: true,
    }));
    if (activeThreadId) {
      setOptimisticThreads((prev) => {
        if (!prev[activeThreadId]) return prev;
        const { [activeThreadId]: _drop, ...rest } = prev;
        return rest;
      });
      setProvisionalTitles((prev) => {
        if (!(activeThreadId in prev)) return prev;
        const { [activeThreadId]: _drop, ...rest } = prev;
        return rest;
      });
    }
    refreshThreadsSoon();
  }, [mastraClient, agentId, activeKey, activeThreadId, getSession, refreshThreadsSoon, updateSession]);

  const selectThread = useCallback(
    (threadId: string) => {
      if (threadId === activeThreadId) return;
      setActiveThreadId(threadId);
    },
    [activeThreadId],
  );

  const newThread = useCallback(() => {
    const id = nanoid();
    sessionsRef.current.set(id, { ...createThreadSession(), historyLoaded: true });
    notifySessions();
    setActiveThreadId(id);
  }, [notifySessions]);

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
      const session = sessionsRef.current.get(threadId);
      session?.abortController?.abort();
      sessionsRef.current.delete(threadId);
      notifySessions();
      setOptimisticThreads((prev) => {
        if (!prev[threadId]) return prev;
        const { [threadId]: _drop, ...rest } = prev;
        return rest;
      });
      setProvisionalTitles((prev) => {
        if (!(threadId in prev)) return prev;
        const { [threadId]: _drop, ...rest } = prev;
        return rest;
      });
      if (threadId === activeThreadId) {
        const id = nanoid();
        sessionsRef.current.set(id, { ...createThreadSession(), historyLoaded: true });
        notifySessions();
        setActiveThreadId(id);
      }
      refreshThreads();
    },
    [mastraClient, agentId, activeThreadId, notifySessions, refreshThreads],
  );

  /**
   * Rename a conversation. Optimistically overlays the new title so the
   * sidebar updates instantly (both the server-row overlay and any
   * still-pending optimistic row for a brand-new thread), persists it,
   * then refreshes the list. On failure the overlay is dropped so the
   * real (unchanged) title reappears.
   */
  const renameThread = useCallback(
    async (threadId: string, rawTitle: string) => {
      const title = rawTitle.trim();
      if (!title) return;
      setRenamedThreads((prev) => ({ ...prev, [threadId]: title }));
      setOptimisticThreads((prev) =>
        prev[threadId]
          ? { ...prev, [threadId]: { ...prev[threadId], id: threadId, title } }
          : prev,
      );
      try {
        await mastraClient.renameThread(threadId, title, { agentId });
        log.info("thread renamed", { threadId });
      } catch (error) {
        log.error("thread rename error", {
          threadId,
          error: commonUtils.errorMessage(error),
        });
        setRenamedThreads((prev) => {
          if (!(threadId in prev)) return prev;
          const { [threadId]: _drop, ...rest } = prev;
          return rest;
        });
      }
      refreshThreads();
    },
    [mastraClient, agentId, refreshThreads],
  );

  const regenerate = useCallback(() => {
    const threadId = activeKey;
    const lastUserText = getSession(threadId).lastUserText;
    if (!lastUserText) return;
    const prev = getSession(threadId).messages;
    const lastAssistant =
      prev.length > 0 && prev.at(-1)?.role === "assistant" ? prev.at(-1) : null;
    const trimmed = lastAssistant ? prev.slice(0, -1) : prev;
    if (lastAssistant) {
      updateSession(threadId, (session) => {
        const { [lastAssistant.id]: _events, ...toolEvents } = session.toolEventsByMessage;
        const { [lastAssistant.id]: _approvals, ...pendingApprovals } =
          session.pendingApprovalsByMessage;
        const { [lastAssistant.id]: _feedback, ...feedback } = session.feedbackByMessage;
        return {
          ...session,
          toolEventsByMessage: toolEvents,
          pendingApprovalsByMessage: pendingApprovals,
          feedbackByMessage: feedback,
        };
      });
    }
    writeMessages(threadId, trimmed);
    void runStream(threadId, trimmed);
  }, [activeKey, getSession, runStream, updateSession, writeMessages]);

  // Hydrate the active thread from the server when it has no local
  // session yet. In-flight streams keep updating their session in the
  // background, so switching back shows live partial text without
  // refetching or aborting other threads' runs.
  useEffect(() => {
    const threadId = activeKey;
    mastraClient.setThreadId(activeThreadId);
    const session = getSession(threadId);
    if (session.historyLoaded) {
      setIsLoadingHistory(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
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
        updateSession(threadId, (current) => ({
          ...current,
          messages: response.uiMessages as unknown as UIMessage[],
          historyLoaded: true,
          hasMoreHistory: response.hasMore,
          historyPage: 1,
          toolEventsByMessage: {},
          pendingApprovalsByMessage: {},
          feedbackByMessage: {},
        }));
      })
      .catch((error: unknown) => {
        if (cancelled || (error as { name?: string }).name === "AbortError") return;
        log.error("history load error", {
          error: commonUtils.errorMessage(error),
        });
        updateSession(threadId, (current) => ({ ...current, hasMoreHistory: false }));
      })
      .finally(() => {
        historyInFlightRef.current = false;
        if (!cancelled) setIsLoadingHistory(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [mastraClient, agentId, activeThreadId, activeKey, getSession, updateSession]);

  const loadOlderHistory = useCallback(() => {
    const threadId = activeKey;
    const session = getSession(threadId);
    if (historyInFlightRef.current || !session.hasMoreHistory) return;
    historyInFlightRef.current = true;
    setIsLoadingMore(true);
    const page = session.historyPage;
    updateSession(threadId, (current) => ({ ...current, historyPage: page + 1 }));
    mastraClient
      .history({ agentId, page, perPage: HISTORY_PAGE_SIZE })
      .then((response) => {
        const uiMessages = response.uiMessages as unknown as UIMessage[];
        if (uiMessages.length > 0) {
          const currentMessages = getSession(threadId).messages;
          writeMessages(threadId, [...uiMessages, ...currentMessages]);
        }
        updateSession(threadId, (current) => ({
          ...current,
          hasMoreHistory: response.hasMore,
        }));
      })
      .catch((error: unknown) => {
        log.error("history load-more error", {
          page,
          error: commonUtils.errorMessage(error),
        });
        updateSession(threadId, (current) => ({
          ...current,
          historyPage: page,
          hasMoreHistory: false,
        }));
      })
      .finally(() => {
        historyInFlightRef.current = false;
        setIsLoadingMore(false);
      });
  }, [activeKey, getSession, mastraClient, agentId, updateSession, writeMessages]);

  // Chat export (opt-in). Resolves `[chart:<id>]` / `[data:<id>]` embeds
  // straight off the client so the export inlines the same charts /
  // tables the UI renders. Handlers are defined unconditionally (rules of
  // hooks) and only surfaced to ChatView when `enableExport` is on.
  const exportResolver = useMemo<EmbedResolver>(
    () => ({
      chart: (id) => mastraClient.chart(id),
      statement: (id) => mastraClient.statement(id),
    }),
    [mastraClient],
  );
  // Speaker label for the human turns in an export. The resource id is
  // the signed-in user's identity (every thread the client lists is its
  // own), so any owned thread supplies it; fall back to a bare "User"
  // before the first thread lands.
  const exportUserLabel = useMemo(() => {
    const resourceId = threads.find((t) => t.resourceId)?.resourceId;
    return resourceId ? `User (${resourceId})` : "User";
  }, [threads]);
  const exportConversation = useCallback(
    async (format: ExportFormat) => {
      const title =
        (activeThreadId && threads.find((t) => t.id === activeThreadId)?.title) ||
        "Conversation";
      try {
        await exportChat({
          messages: getSession(activeKey).messages,
          format,
          resolver: exportResolver,
          title,
          userLabel: exportUserLabel,
        });
      } catch (error) {
        log.error("conversation export error", {
          format,
          error: commonUtils.errorMessage(error),
        });
      }
    },
    [exportResolver, activeThreadId, activeKey, getSession, threads, exportUserLabel],
  );
  const exportMessage = useCallback(
    async (message: UIMessage, format: ExportFormat) => {
      try {
        await exportChat({
          messages: [message],
          format,
          resolver: exportResolver,
          title: "Message",
          filename: "message",
          userLabel: exportUserLabel,
        });
      } catch (error) {
        log.error("message export error", {
          format,
          error: commonUtils.errorMessage(error),
        });
      }
    },
    [exportResolver, exportUserLabel],
  );

  // Submit thumbs / comment feedback for an assistant message to MLflow
  // via the plugin's feedback route. The message's captured trace id
  // scopes the assessment; without one there's nothing to attach to, so
  // the call is skipped. A thumbs value is reflected optimistically so
  // the active button highlights immediately; a soft "not recorded"
  // (e.g. the trace is still exporting) is logged, not surfaced as an
  // error, to keep the chat calm.
  const submitFeedback = useCallback(
    async (message: UIMessage, submission: FeedbackSubmission) => {
      const traceId = feedbackByMessageRef.current[message.id]?.traceId;
      if (!traceId) return;
      if (submission.value) {
        updateSession(activeKey, (session) => ({
          ...session,
          feedbackByMessage: {
            ...session.feedbackByMessage,
            [message.id]: { traceId, value: submission.value },
          },
        }));
      }
      try {
        const result = await mastraClient.feedback({
          traceId,
          ...(submission.value !== undefined
            ? { value: submission.value === "up" }
            : {}),
          ...(submission.comment ? { comment: submission.comment } : {}),
        });
        if (!result.ok) {
          log.warn("feedback not recorded (trace may still be exporting)", {
            traceId,
          });
        }
      } catch (error) {
        log.error("feedback error", {
          traceId,
          error: commonUtils.errorMessage(error),
        });
      }
    },
    [activeKey, mastraClient, updateSession],
  );

  // Merge optimistic rows
  // the server list, newest first, dropping any optimistic entry the
  // server already returns so a thread is never listed twice.
  const sidebarThreads = useMemo<ThreadSummary[]>(() => {
    // Title overlay precedence per row: a manual rename always wins;
    // otherwise a provisional first-message title fills an untitled row
    // until the server titles the thread.
    const withOverlay = (t: ThreadSummary): ThreadSummary => {
      const renamed = renamedThreads[t.id];
      if (renamed !== undefined) return { ...t, title: renamed };
      if (!t.title && provisionalTitles[t.id] !== undefined) {
        return { ...t, title: provisionalTitles[t.id] };
      }
      return t;
    };
    const server = threads.map(toThreadSummary).map(withOverlay);
    const serverIds = new Set(server.map((t) => t.id));
    const pending = Object.values(optimisticThreads)
      .filter((t) => !serverIds.has(t.id))
      .map(withOverlay)
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return [...pending, ...server];
  }, [threads, optimisticThreads, renamedThreads, provisionalTitles]);
  // Once the server list includes a thread we were tracking optimistically,
  // drop the optimistic copy so the map doesn't grow without bound.
  useEffect(() => {
    const serverIds = new Set(threads.map((t) => t.id));
    const stale = Object.keys(optimisticThreads).filter((id) => serverIds.has(id));
    if (stale.length === 0) return;
    setOptimisticThreads((prev) => {
      const next = { ...prev };
      for (const id of stale) delete next[id];
      return next;
    });
  }, [threads, optimisticThreads]);
  // Drop a rename overlay once the server list reports the new title, so
  // the map doesn't grow without bound and later server-side title
  // changes aren't masked by a stale override.
  useEffect(() => {
    const settled = threads
      .filter((t) => renamedThreads[t.id] !== undefined && t.title === renamedThreads[t.id])
      .map((t) => t.id);
    if (settled.length === 0) return;
    setRenamedThreads((prev) => {
      const next = { ...prev };
      for (const id of settled) delete next[id];
      return next;
    });
  }, [threads, renamedThreads]);
  // Drop a provisional first-message title once the server reports any
  // real title for that thread, so the auto-generated title takes over.
  useEffect(() => {
    const settled = threads
      .filter((t) => t.title && provisionalTitles[t.id] !== undefined)
      .map((t) => t.id);
    if (settled.length === 0) return;
    setProvisionalTitles((prev) => {
      const next = { ...prev };
      for (const id of settled) delete next[id];
      return next;
    });
  }, [threads, provisionalTitles]);

  return {
    messages: activeSession.messages,
    status: activeSession.status,
    error: activeSession.error,
    sendMessage,
    regenerate,
    onStop: stop,
    suggestions,
    toolEventsByMessage: activeSession.toolEventsByMessage,
    pendingApprovalsByMessage: activeSession.pendingApprovalsByMessage,
    onResolveToolApproval: handleApproval,
    // Picker is opt-in: only hand ChatView the catalogue + change
    // handler when `showModelPicker` is on, otherwise the header hides
    // it (ChatView shows it only when both are present).
    models: showModelPicker ? models : undefined,
    model,
    onModelChange: showModelPicker ? setModel : undefined,
    onLoadMore: loadOlderHistory,
    isLoadingMore,
    hasMore: activeSession.hasMoreHistory,
    isLoadingHistory,
    onClear: handleClear,
    // Conversation management: hand ChatView the thread list + handlers
    // only when enabled, so the sidebar stays hidden for the classic
    // single-thread chat (ChatView keys the sidebar off these props).
    ...(enableThreads
      ? {
          threads: sidebarThreads,
          ...(activeThreadId ? { activeThreadId } : {}),
          streamingThreadIds,
          isLoadingThreads,
          onSelectThread: selectThread,
          onNewThread: newThread,
          onDeleteThread: deleteThread,
          onRenameThread: renameThread,
          // Persisted sidebar visibility, controlled from the driver so
          // the show/hide choice survives reloads.
          sidebarOpen,
          onToggleSidebar: toggleSidebar,
        }
      : {}),
    // Export is opt-in: only expose the handlers (which light up the
    // header + per-message export menus in ChatView) when enabled.
    ...(enableExport
      ? {
          onExportConversation: exportConversation,
          onExportMessage: exportMessage,
        }
      : {}),
    // Feedback: only expose the state + handler (which light up the
    // per-bubble thumbs / comment controls in ChatView) when feedback
    // is enabled AND the server can log to MLflow. `feedbackByMessage`
    // still gates per-message on a captured trace id.
    ...(feedbackAvailable
      ? {
          feedbackByMessage: activeSession.feedbackByMessage,
          onFeedback: submitFeedback,
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
