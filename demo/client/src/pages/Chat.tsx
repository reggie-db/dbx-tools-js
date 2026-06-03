import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useCallback, useMemo, useRef, useState } from "react";
import { logUtils } from "@dbx-tools/appkit-shared";
import { ChatView, type ApprovalDecision } from "@/components/chat-view";
import { useChatUrl, useMastraModels } from "@/lib/mastra-client";

const log = logUtils.logger("client/chat");

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

  const { messages, sendMessage, status, regenerate, addToolOutput } = useChat({
    transport,
  });

  /**
   * Resolve an approval-gated tool call. AI SDK V5's
   * `addToolOutput` resolves the suspended tool part client-side
   * (sets `state: 'output-available'` / `'output-error'`) and
   * triggers a follow-up turn where the model sees the result.
   * Note: the server tool's `execute` body never runs because the
   * output is provided manually here. For demos that need to
   * simulate "send the email" behaviour, we log the would-be email
   * to the browser console on approve.
   */
  const handleApproval = useCallback(
    async (decision: ApprovalDecision) => {
      if (decision.approved) {
        const input = decision.input as { to?: string };
        log.info("approved", {
          tool: decision.toolName,
          toolCallId: decision.toolCallId,
          input: decision.input,
        });
        await addToolOutput({
          tool: decision.toolName as never,
          toolCallId: decision.toolCallId,
          // Output shape mirrors the server tool's `outputSchema`
          // so the model sees the same record it would have if the
          // server had executed the tool.
          output: {
            sent: true,
            recipient: input.to ?? "",
          } as never,
        });
        return;
      }
      log.info("denied", {
        tool: decision.toolName,
        toolCallId: decision.toolCallId,
        reason: decision.reason,
      });
      await addToolOutput({
        state: "output-error",
        tool: decision.toolName as never,
        toolCallId: decision.toolCallId,
        errorText: decision.reason,
      });
    },
    [addToolOutput],
  );

  return (
    <ChatView
      messages={messages}
      status={status}
      sendMessage={(message) => sendMessage(message)}
      regenerate={regenerate}
      models={models}
      model={model}
      onModelChange={setModel}
      onResolveToolApproval={handleApproval}
    />
  );
};

export default Chat;
