import { useCallback, useEffect, useRef, useState } from "react";
import { nanoid } from "nanoid";
import type { UIMessage } from "ai";
import { commonUtils, logUtils } from "@dbx-tools/shared";
import {
  ChatView,
  type ApprovalDecision,
  type ChatStatus,
  type PendingApproval,
  type ToolEvent,
  type ToolProgress,
} from "@/components/chat-view";
import {
  clearMastraHistory,
  fetchMastraHistory,
  useMastraClient,
  useMastraConfig,
  useMastraModels,
} from "@/lib/mastra-client";

const log = logUtils.logger("client/stream");

// Same chat UI as pages/Chat.tsx, but instead of pointing useChat at the
// chatRoute() endpoint, we drive messages by hand using @mastra/client-js.
// agent.stream() returns a Response augmented with processDataStream(),
// which pushes typed Mastra chunks (text-delta, reasoning-delta, etc.)
// at us. We translate those into UIMessage parts so ChatView renders
// identically to the useChat-backed page.
//
// Approval gates ride on the same channel: when the agent pauses on a
// `requireApproval: true` tool call, Mastra emits a `tool-call-approval`
// chunk carrying `{ runId, payload: { toolCallId, toolName, args } }`.
// We surface that as an out-of-band entry in `pendingApprovalsByMessage`
// (the same map ChatView already accepts), and wire `onResolveToolApproval`
// to call `agent.approveToolCall` / `declineToolCall` - both return a
// fresh stream Response we run through the same chunk handler.
//
// On mount we hydrate the transcript with the most recent page of
// thread history fetched from the Mastra plugin's `/history` endpoint
// (server-side wraps `Memory.recall` and `toAISdkV5Messages`). When
// the user scrolls back near the top of the transcript we lazy-load
// the next older page and prepend it; ChatView preserves the visual
// scroll position across the prepend.

const HISTORY_PAGE_SIZE = 20;

const makeUserMessage = (text: string): UIMessage => ({
  id: nanoid(),
  role: "user",
  parts: [{ type: "text", text }],
});

// `tool-output` chunks carry arbitrary tool-defined payloads; only the
// `{type: ...}` shape we know how to render in `ToolSessionPill` is
// surfaced. Anything else (other tools, raw data, etc.) is ignored.
const isToolProgress = (value: unknown): value is ToolProgress =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string";

const PLACEHOLDER_MARKER_RE =
  /\[\[?([^\s:\]]+):(?![0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\]?\]?)([^\s\]]+)\]\]?/i;

const replaceNextPlaceholder = (text: string, type: string, id: string): string => {
  const marker = `[${type}:${id}]`;

  return PLACEHOLDER_MARKER_RE.test(text)
    ? text.replace(PLACEHOLDER_MARKER_RE, marker)
    : `${text}${text.endsWith("\n") || text.length === 0 ? "" : "\n"}\n${marker}`;
};

const Stream = () => {
  const [model, setModel] = useState("");
  // `useMastraClient(model)` rebuilds the client with
  // `X-Mastra-Model` attached as a default header whenever the
  // selected model changes. The Mastra plugin's server middleware
  // reads that header and overrides the per-request resolved model
  // without redeploying the agent.
  const mastraClient = useMastraClient(model);
  const mastraConfig = useMastraConfig();
  // Pull stable scalar fields out of the config for hook deps. The
  // config object reference can churn across renders (the provider
  // returns whatever `usePluginClientConfig` hands us), and using the
  // whole object as a dep would refire the initial-history fetch on
  // every parent render, leading to duplicate keys when overlapping
  // pages prepend.
  const { historyPath, defaultAgent } = mastraConfig;
  const { models } = useMastraModels();
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>("ready");
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
    ) => {
      // Replay carries forward whatever text / reasoning was already
      // accumulated for `assistantId` so resuming after approval
      // appends rather than overwrites.
      const existing = messagesRef.current.find((m) => m.id === assistantId);
      let assistantText = "";
      let assistantReasoning = "";
      if (existing) {
        for (const part of existing.parts) {
          if (part.type === "text") assistantText += part.text;
          else if (part.type === "reasoning") {
            assistantReasoning += (part as { text?: string }).text ?? "";
          }
        }
      }

      const upsertAssistant = () => {
        const prev = messagesRef.current;
        const next = [...prev];
        const idx = next.findIndex((m) => m.id === assistantId);
        const parts: UIMessage["parts"] = [];
        if (assistantReasoning) {
          parts.push({ type: "reasoning", text: assistantReasoning });
        }
        if (assistantText) {
          parts.push({ type: "text", text: assistantText });
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

      await stream.processDataStream({
        onChunk: async (chunk: { type: string; payload?: any; runId?: string }) => {
          // Mastra stamps the stream's runId on most chunks. Capturing
          // it the first time we see it (rather than relying on a
          // separate API) keeps approve/decline calls correct even if
          // the client-supplied runId got overridden server-side.
          if (chunk.runId && !runIdRef.current) {
            runIdRef.current = chunk.runId;
          }
          switch (chunk.type) {
            case "text-delta":
              assistantText += chunk.payload?.text ?? "";
              upsertAssistant();
              markStreaming();
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
              const toolName = chunk.payload?.toolName;
              const chartId =
                toolName === "prepare_chart" &&
                typeof chunk.payload?.result?.chartId === "string"
                  ? chunk.payload.result.chartId
                  : null;
              if (chartId) {
                assistantText = replaceNextPlaceholder(assistantText, chartId);
                upsertAssistant();
              }
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
                list.map((e) => (e.id === toolCallId ? { ...e, status: "error" } : e)),
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
            case "error":
              setStatus("error");
              break;
            default:
              break;
          }
        },
      });
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

  const runStream = useCallback(
    async (history: UIMessage[]) => {
      setStatus("submitted");
      const assistantId = nanoid();
      const runId = nanoid();
      currentAssistantIdRef.current = assistantId;
      currentRunIdRef.current = runId;
      try {
        const agent = mastraClient.getAgent(defaultAgent);
        const messagesForAgent = history.flatMap((m) =>
          m.parts
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => ({ role: m.role, content: p.text })),
        );
        // Pre-seed the runId so chatRoute / approveToolCall stay
        // anchored to the same workflow even if the first chunk is
        // delayed. Server is authoritative; if it overrides we'll
        // pick that up via `runIdRef` inside `processStream`.
        const stream = await agent.stream(messagesForAgent, { runId });
        await processStream(stream, assistantId, currentRunIdRef);
        setStatus("ready");
      } catch (error) {
        log.error("stream error", {
          error: commonUtils.errorMessage(error),
        });
        setStatus("error");
      }
    },
    [mastraClient, defaultAgent, processStream],
  );

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
      setStatus("submitted");
      try {
        const agent = mastraClient.getAgent(defaultAgent);
        const stream = decision.approved
          ? await agent.approveToolCall({ runId, toolCallId })
          : await agent.declineToolCall({ runId, toolCallId });
        await processStream(stream, assistantId, currentRunIdRef);
        setStatus("ready");
      } catch (error) {
        log.error("approval resume error", {
          error: commonUtils.errorMessage(error),
        });
        setStatus("error");
      }
    },
    [mastraClient, defaultAgent, processStream],
  );

  const sendMessage = useCallback<React.ComponentProps<typeof ChatView>["sendMessage"]>(
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
      const result = await clearMastraHistory(
        { historyPath, defaultAgent },
        { agentId: defaultAgent },
      );
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
    setStatus("ready");
  }, [historyPath, defaultAgent, writeMessages]);

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
  // mount. We re-run when `historyPath` or `defaultAgent` changes
  // (e.g. picker swaps the agent), but not on every model change
  // since the model only affects subsequent generations, not stored
  // history.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    historyInFlightRef.current = true;
    setIsLoadingHistory(true);
    fetchMastraHistory(
      { historyPath, defaultAgent },
      {
        agentId: defaultAgent,
        page: 0,
        perPage: HISTORY_PAGE_SIZE,
        signal: controller.signal,
      },
    )
      .then((response) => {
        if (cancelled) return;
        writeMessages(response.uiMessages);
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
  }, [historyPath, defaultAgent, writeMessages]);

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
    fetchMastraHistory(
      { historyPath, defaultAgent },
      { agentId: defaultAgent, page, perPage: HISTORY_PAGE_SIZE },
    )
      .then((response) => {
        if (response.uiMessages.length > 0) {
          writeMessages([...response.uiMessages, ...messagesRef.current]);
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
  }, [hasMoreHistory, historyPath, defaultAgent, writeMessages]);

  return (
    <ChatView
      messages={messages}
      status={status}
      sendMessage={sendMessage}
      regenerate={regenerate}
      toolEventsByMessage={toolEventsByMessage}
      pendingApprovalsByMessage={pendingApprovalsByMessage}
      onResolveToolApproval={handleApproval}
      models={models}
      model={model}
      onModelChange={setModel}
      onLoadMore={loadOlderHistory}
      isLoadingMore={isLoadingMore}
      hasMore={hasMoreHistory}
      isLoadingHistory={isLoadingHistory}
      onClear={handleClear}
    />
  );
};

export default Stream;
