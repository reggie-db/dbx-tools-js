import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useMemo } from "react";
import { ChatView } from "@/components/chat-view";
import { useChatUrl } from "@/lib/mastra-client";

const Chat = () => {
  const api = useChatUrl();
  // One transport instance per resolved URL. A fresh
  // `DefaultChatTransport` on every render would change `useChat`'s
  // options identity and can re-trigger the stream request (duplicate
  // POSTs and duplicate `buildModel()` logs on the server).
  const transport = useMemo(() => new DefaultChatTransport({ api }), [api]);

  const { messages, sendMessage, status, regenerate } = useChat({ transport });

  return (
    <ChatView
      messages={messages}
      status={status}
      sendMessage={sendMessage}
      regenerate={regenerate}
    />
  );
};

export default Chat;
