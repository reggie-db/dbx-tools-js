import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useMemo, useRef, useState } from "react";
import { ChatView } from "@/components/chat-view";
import { useChatUrl, useMastraModels } from "@/lib/mastra-client";

const Chat = () => {
  const api = useChatUrl();
  const { models } = useMastraModels();
  const [model, setModel] = useState("");

  // `useChat` snapshots `transport` on first render, so swapping
  // identity later doesn't change what gets used for the next call.
  // We instead build one stable transport per `api` and feed the
  // current model via the `Resolvable` form of `headers` -
  // `HttpChatTransport` invokes the function on every outgoing
  // request, picking up whatever's currently in `modelRef`.
  //
  // The override travels as `X-Mastra-Model` (not body) because
  // `MastraServer.registerAuthMiddleware()` runs before
  // `express.json()`; a body-based override would parse too late
  // for the per-request model resolver to see it.
  const modelRef = useRef(model);
  modelRef.current = model;

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api,
        headers: (): Record<string, string> => {
          const current = modelRef.current;
          return current ? { "X-Mastra-Model": current } : {};
        },
      }),
    [api],
  );

  const { messages, sendMessage, status, regenerate } = useChat({ transport });

  return (
    <ChatView
      messages={messages}
      status={status}
      sendMessage={(message) => sendMessage(message)}
      regenerate={regenerate}
      models={models}
      model={model}
      onModelChange={setModel}
    />
  );
};

export default Chat;
