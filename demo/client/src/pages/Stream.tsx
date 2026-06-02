import { useCallback, useEffect, useRef, useState } from "react";
import { nanoid } from "nanoid";
import type { UIMessage } from "ai";
import {
  ChatView,
  type ChatStatus,
  type ToolEvent,
  type ToolProgress,
} from "@/components/chat-view";
import {
  fetchMastraHistory,
  useMastraClient,
  useMastraConfig,
  useMastraModels,
} from "@/lib/mastra-client";
import { synthesizeToolEventsFromHistory } from "@/lib/genie-history";

// Same chat UI as pages/Chat.tsx, but instead of pointing useChat at the
// chatRoute() endpoint, we drive messages by hand using @mastra/client-js.
// agent.stream() returns a Response augmented with processDataStream(),
// which pushes typed Mastra chunks (text-delta, reasoning-delta, etc.)
// at us. We translate those into UIMessage parts so ChatView renders
// identically to the useChat-backed page.
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
// `{kind: ...}` shape we know how to render in `ToolStatusList` is
// surfaced. Anything else (other tools, raw data, etc.) is ignored.
const isToolProgress = (value: unknown): value is ToolProgress =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { kind?: unknown }).kind === "string";

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

  const runStream = useCallback(
    async (history: UIMessage[]) => {
      setStatus("submitted");
      const assistantId = nanoid();
      let assistantText = "";
      let assistantReasoning = "";

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
      const patchToolEvents = (
        update: (list: ToolEvent[]) => ToolEvent[],
      ) => {
        setToolEventsByMessage((prev) => ({
          ...prev,
          [assistantId]: update(prev[assistantId] ?? []),
        }));
      };

      try {
        const agent = mastraClient.getAgent(defaultAgent);
        const messagesForAgent = history.flatMap((m) =>
          m.parts
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => ({ role: m.role, content: p.text })),
        );

        const stream = await agent.stream(messagesForAgent);

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
          onChunk: async (chunk) => {
            switch (chunk.type) {
              case "text-delta":
                assistantText += chunk.payload.text ?? "";
                upsertAssistant();
                markStreaming();
                break;
              case "reasoning-delta":
                assistantReasoning += chunk.payload.text ?? "";
                upsertAssistant();
                markStreaming();
                break;
              case "tool-call": {
                const { toolCallId, toolName } = chunk.payload;
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
              case "tool-result": {
                const { toolCallId } = chunk.payload;
                patchToolEvents((list) =>
                  list.map((e) =>
                    e.id === toolCallId ? { ...e, status: "done" } : e,
                  ),
                );
                break;
              }
              case "tool-error": {
                const { toolCallId } = chunk.payload;
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
                const { toolCallId, output } = chunk.payload;
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
        setStatus("ready");
      } catch (error) {
        console.error("Mastra stream error", error);
        setStatus("error");
      }
    },
    [writeMessages, mastraClient, defaultAgent],
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

  const regenerate = useCallback(() => {
    if (!lastUserTextRef.current) return;
    // Drop the last assistant message before regenerating so the new
    // stream replaces it instead of appending alongside. Clear the
    // tool events for that turn too so the regenerated bubble starts
    // with a blank slate.
    const prev = messagesRef.current;
    const lastAssistant =
      prev.length > 0 && prev.at(-1)?.role === "assistant" ? prev.at(-1) : null;
    const trimmed = lastAssistant ? prev.slice(0, -1) : prev;
    if (lastAssistant) {
      setToolEventsByMessage((map) => {
        const { [lastAssistant.id]: _, ...rest } = map;
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
        // Replay Genie tool events (SQL pills, charts, suggested
        // questions) by synthesising them from the persisted
        // tool-result outputs. Live stream state is gone after a
        // reload, but the DrainResult sat in the assistant
        // message's `tool-${name}` part the whole time.
        const replay = synthesizeToolEventsFromHistory(response.uiMessages);
        if (Object.keys(replay).length > 0) {
          setToolEventsByMessage((prev) => ({ ...prev, ...replay }));
        }
        historyPageRef.current = 1;
        setHasMoreHistory(response.hasMore);
      })
      .catch((error: unknown) => {
        if (cancelled || (error as { name?: string }).name === "AbortError") return;
        console.error("Mastra history load error", error);
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
          // Same synthesis as the initial load, but only for the
          // newly-prepended page so existing live tool events for
          // recent turns aren't clobbered.
          const replay = synthesizeToolEventsFromHistory(response.uiMessages);
          if (Object.keys(replay).length > 0) {
            setToolEventsByMessage((prev) => ({ ...prev, ...replay }));
          }
        }
        setHasMoreHistory(response.hasMore);
      })
      .catch((error: unknown) => {
        console.error("Mastra history load-more error", error);
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
      models={models}
      model={model}
      onModelChange={setModel}
      onLoadMore={loadOlderHistory}
      isLoadingMore={isLoadingMore}
      hasMore={hasMoreHistory}
      isLoadingHistory={isLoadingHistory}
    />
  );
};

export default Stream;
