import { useCallback, useRef, useState } from "react";
import { nanoid } from "nanoid";
import type { UIMessage } from "ai";
import {
  ChatView,
  type ChatStatus,
  type ToolEvent,
  type ToolProgress,
} from "@/components/chat-view";
import { useMastraClient, useMastraConfig } from "@/lib/mastra-client";

// Same chat UI as pages/Chat.tsx, but instead of pointing useChat at the
// chatRoute() endpoint, we drive messages by hand using @mastra/client-js.
// agent.stream() returns a Response augmented with processDataStream(),
// which pushes typed Mastra chunks (text-delta, reasoning-delta, etc.)
// at us. We translate those into UIMessage parts so ChatView renders
// identically to the useChat-backed page.

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
  const mastraClient = useMastraClient();
  const { defaultAgent } = useMastraConfig();
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>("ready");
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

  return (
    <ChatView
      messages={messages}
      status={status}
      sendMessage={sendMessage}
      regenerate={regenerate}
      toolEventsByMessage={toolEventsByMessage}
    />
  );
};

export default Stream;
