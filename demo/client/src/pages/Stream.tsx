import { useCallback, useRef, useState } from "react";
import { nanoid } from "nanoid";
import type { UIMessage } from "ai";
import { ChatView, type ChatStatus } from "@/components/chat-view";
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

const Stream = () => {
  const mastraClient = useMastraClient();
  const { defaultAgent } = useMastraConfig();
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>("ready");
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
      let started = false;

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

      try {
        const agent = mastraClient.getAgent(defaultAgent);
        const messagesForAgent = history.flatMap((m) =>
          m.parts
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => ({ role: m.role, content: p.text })),
        );

        const stream = await agent.stream(messagesForAgent);

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
    // stream replaces it instead of appending alongside.
    const prev = messagesRef.current;
    const trimmed =
      prev.length > 0 && prev.at(-1)?.role === "assistant" ? prev.slice(0, -1) : prev;
    writeMessages(trimmed);
    void runStream(trimmed);
  }, [runStream, writeMessages]);

  return (
    <ChatView
      messages={messages}
      status={status}
      sendMessage={sendMessage}
      regenerate={regenerate}
    />
  );
};

export default Stream;
