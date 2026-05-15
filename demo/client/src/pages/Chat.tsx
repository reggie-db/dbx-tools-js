import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { ChatView } from "@/components/chat-view";
import { DEFAULT_AGENT_ID } from "@/lib/mastra-client";

// One transport instance for the lifetime of the module. A fresh
// `DefaultChatTransport` on every render would change `useChat`'s
// options identity and can re-trigger the stream request (duplicate
// POSTs and duplicate `buildModel()` logs on the server).
const mastraChatTransport = new DefaultChatTransport({
  // chatRoute path is `/route/chat/:agentId`; plugin is mounted at
  // `/api/mastra`. Agent id must match a key in `Mastra({ agents })`.
  api: `/api/mastra/route/chat/${DEFAULT_AGENT_ID}`,
});

const Chat = () => {
  const { messages, sendMessage, status, regenerate } = useChat({
    transport: mastraChatTransport,
  });

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
