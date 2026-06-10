import { useChat } from "@ai-sdk/react";
import {
  ChatView,
  clearMastraHistory,
  useChatUrl,
  useMastraConfig,
  useMastraModels,
  type ApprovalDecision,
} from "@dbx-tools/appkit-mastra-ui/react";
import { commonUtils, logUtils } from "@dbx-tools/shared";
import { DefaultChatTransport } from "ai";
import { useCallback, useMemo, useRef, useState } from "react";

const log = logUtils.logger("client/chat");

const Chat = () => {
  const api = useChatUrl();
  const { historyPath, defaultAgent } = useMastraConfig();
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

  const { messages, sendMessage, status, regenerate, setMessages, stop, error } =
    useChat({
      transport,
    });

  /**
   * Wipe the server-side thread and reset the in-memory `useChat`
   * transcript. The session cookie that pins the thread id is left
   * alone so the next message opens against the same (now empty)
   * thread. Stops any in-flight stream first so the cleared bubble
   * doesn't get back-filled by an already-running generation.
   */
  const handleClear = useCallback(async () => {
    stop();
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
    }
    setMessages([]);
  }, [historyPath, defaultAgent, setMessages, stop]);

  /**
   * Resolve an approval-gated tool call.
   *
   * Mastra's `chatRoute()` paused the agent loop and emitted a
   * `data-tool-call-approval` part carrying `runId` + `toolCallId`.
   * To resume we POST back to the same chatRoute with
   * `{ resumeData, runId }` in the body; chatRoute then calls
   * `agent.resumeStream(resumeData)`, which wakes the suspended
   * tool call with the user's decision and the agent loop
   * continues. This is the canonical pattern from the Mastra UI
   * Dojo (`mastra-ai/ui-dojo/.../tool-approval.tsx`).
   *
   * `addToolOutput` is intentionally NOT used: it short-circuits
   * the suspension client-side without telling Mastra the
   * decision, so the server's persisted workflow state would still
   * show "awaiting approval" on the next turn / refresh.
   */
  const handleApproval = useCallback(
    async (decision: ApprovalDecision) => {
      const { runId, toolCallId, toolName } = decision;
      if (!runId) {
        log.warn("approval missing runId, cannot resume", {
          tool: toolName,
          toolCallId,
        });
        return;
      }
      const resumeData = decision.approved
        ? { approved: true }
        : { approved: false, reason: decision.reason };
      log.info(decision.approved ? "approved" : "denied", {
        tool: toolName,
        toolCallId,
        runId,
      });
      await sendMessage(undefined, {
        body: { resumeData, runId },
      });
    },
    [sendMessage],
  );

  return (
    <ChatView
      messages={messages}
      status={status}
      error={error}
      sendMessage={(message) => sendMessage(message)}
      regenerate={regenerate}
      onStop={stop}
      models={models}
      model={model}
      onModelChange={setModel}
      onResolveToolApproval={handleApproval}
      onClear={handleClear}
    />
  );
};

export default Chat;
