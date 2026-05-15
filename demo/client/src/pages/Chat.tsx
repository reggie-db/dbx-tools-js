import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { ChatView } from "@/components/chat-view";

const Chat = () => {
  const { messages, sendMessage, status, regenerate } = useChat({
    transport: new DefaultChatTransport({
      // Defined through chatRoute() in @dbx-tools/appkit-mastra. The full
      // URL is /api/mastra/route/chat: /api/mastra is the plugin mount
      // and /route/chat is the custom Mastra chatRoute.
      api: "/api/mastra/route/chat",
    }),
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
