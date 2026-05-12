import { Button, cn } from "@databricks/appkit-ui/react";
import type { AgentChatEvent } from "@databricks/appkit-ui/react";
import type { ToolProgressEvent } from "@reggie-db/dbx-tools-appkit-shared";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AgentChatInput } from "./agent-chat-input.js";
import { AgentChatMessageList } from "./agent-chat-message-list.js";
import type { ChatTurn } from "./types.js";
import { useAgentChat } from "./use-agent-chat.js";
import { useToolProgress } from "./use-tool-progress.js";

// Full-featured chat interface for an agent registered with the appkit agents
// plugin. Handles message streaming, thread persistence, tool-call rendering,
// and live tool-progress updates from the appkit-plugin-dbx-tools server.
//
// Layout mirrors @databricks/appkit-ui's GenieChat: ScrollArea message list,
// Card-based bubbles with Avatar, auto-expanding textarea input, and a
// "New conversation" reset button. The chat is meant to be embedded in the
// same shells where you would embed `<GenieChat />`.

export interface AgentChatProps {
  /** Required. Agent name registered with the agents plugin. */
  agent: string;
  /** Chat SSE endpoint. Default `"/api/agents/chat"`. */
  endpoint?: string;
  /**
   * Tool-progress SSE URL produced by `appkit-plugin-dbx-tools`. Default
   * `"/api/dbx-tools/tool-progress"`. Pass `false` to disable the live
   * tool-progress side channel.
   */
  progressUrl?: string | false;
  /** localStorage key for the thread id. Default `"dbx-tools.agent.<agent>.threadId"`. */
  storageKey?: string;
  /** Placeholder shown in the input. Default `"Ask a question..."`. */
  placeholder?: string;
  /** Empty-state content shown before the first message. */
  welcome?: ReactNode;
  /** Additional CSS class for the root container. */
  className?: string;
}

const STREAMING_TURN_DEFAULTS: Omit<ChatTurn, "id"> = {
  role: "assistant",
  content: "",
  toolCalls: [],
  status: "streaming",
};

function newTurnId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Full-featured chat interface for an AppKit agent with live tool-progress. */
export function AgentChat({
  agent,
  endpoint,
  progressUrl,
  storageKey,
  placeholder,
  welcome,
  className,
}: AgentChatProps) {
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Mutate only the last assistant turn. The user's turn is immutable after
  // append, so every server-driven update is scoped to the trailing bubble.
  const updateLastAssistant = useCallback(
    (updater: (turn: ChatTurn) => ChatTurn) => {
      setMessages((prev) => {
        for (let i = prev.length - 1; i >= 0; i--) {
          if (prev[i].role === "assistant") {
            const next = prev.slice();
            next[i] = updater(prev[i]);
            return next;
          }
        }
        return prev;
      });
    },
    [],
  );

  const handleEvent = useCallback(
    (event: AgentChatEvent) => {
      switch (event.type) {
        case "response.output_item.added": {
          if (event.item?.type === "function_call") {
            const callId =
              event.item.call_id ?? event.item.id ?? newTurnId();
            updateLastAssistant((t) => ({
              ...t,
              toolCalls: [
                ...t.toolCalls,
                {
                  callId,
                  name: event.item?.name ?? "tool",
                  args: event.item?.arguments ?? "",
                  status: "running",
                  statusUpdates: [],
                },
              ],
            }));
          } else if (event.item?.type === "function_call_output") {
            const callId = event.item.call_id ?? "";
            const output = event.item.output ?? "";
            updateLastAssistant((t) => ({
              ...t,
              toolCalls: t.toolCalls.map((tc) =>
                tc.callId === callId
                  ? { ...tc, output, status: "done" as const }
                  : tc,
              ),
            }));
          }
          break;
        }
        case "error":
        case "response.failed": {
          updateLastAssistant((t) => ({
            ...t,
            status: "error" as const,
            errorText: event.error ?? "Stream failed",
          }));
          break;
        }
        default:
          break;
      }
    },
    [updateLastAssistant],
  );

  const { content, isStreaming, error, send, reset } = useAgentChat({
    agent,
    endpoint,
    storageKey,
    onEvent: handleEvent,
  });

  // Mirror live streaming text onto the trailing assistant turn so the bubble
  // grows in lockstep with the response.
  useEffect(() => {
    if (!isStreaming) return;
    updateLastAssistant((t) => ({ ...t, content }));
  }, [content, isStreaming, updateLastAssistant]);

  // Finalize the streaming turn when the SSE stream ends (success or error).
  useEffect(() => {
    if (isStreaming) return;
    setMessages((prev) => {
      let changed = false;
      const next = prev.map((t) => {
        if (t.role === "assistant" && t.status === "streaming") {
          changed = true;
          return {
            ...t,
            content: content || t.content,
            status: error ? ("error" as const) : ("done" as const),
            errorText: error ?? t.errorText,
          };
        }
        return t;
      });
      return changed ? next : prev;
    });
  }, [isStreaming, content, error]);

  // Side-channel: append phase labels to the most recent still-running tool
  // call whose name matches the event's tool. The agents plugin's chat SSE
  // cannot carry these updates (the tool's `execute()` returns one result), so
  // they ride a separate SSE channel managed by the dbx-tools server plugin.
  //
  // Consecutive events with the same phase + label are suppressed so repeated
  // status pings (e.g. "Waiting for warehouse" emitted on every Genie poll)
  // collapse into a single visible row instead of stacking.
  const handleProgress = useCallback(
    (payload: ToolProgressEvent) => {
      updateLastAssistant((t) => {
        const next = t.toolCalls.slice();
        for (let i = next.length - 1; i >= 0; i--) {
          const tc = next[i];
          if (tc.name === payload.tool && tc.status === "running") {
            const last = tc.statusUpdates[tc.statusUpdates.length - 1];
            if (last && last.phase === payload.phase && last.label === payload.label) {
              return t;
            }
            next[i] = {
              ...tc,
              statusUpdates: [
                ...tc.statusUpdates,
                {
                  phase: payload.phase,
                  label: payload.label,
                  ts: payload.ts,
                },
              ],
            };
            return { ...t, toolCalls: next };
          }
        }
        return t;
      });
    },
    [updateLastAssistant],
  );

  useToolProgress({
    url: progressUrl === false ? undefined : progressUrl,
    enabled: progressUrl !== false,
    onEvent: handleProgress,
  });

  const handleSend = useCallback(
    async (message: string) => {
      setMessages((prev) => [
        ...prev,
        {
          id: newTurnId(),
          role: "user",
          content: message,
          toolCalls: [],
          status: "done",
        },
        { id: newTurnId(), ...STREAMING_TURN_DEFAULTS },
      ]);
      await send(message);
    },
    [send],
  );

  const handleReset = useCallback(() => {
    reset();
    setMessages([]);
  }, [reset]);

  return (
    <div className={cn("flex flex-col h-full overflow-hidden", className)}>
      {messages.length > 0 && (
        <div className="shrink-0 flex justify-end px-4 pt-3 pb-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleReset}
            className="text-xs text-muted-foreground"
            disabled={isStreaming}
          >
            New conversation
          </Button>
        </div>
      )}
      <AgentChatMessageList
        messages={messages}
        liveContent={content}
        welcome={welcome}
      />
      {error && (
        <div className="shrink-0 px-4 py-2 text-sm text-destructive bg-destructive/10 border-t">
          {error}
        </div>
      )}
      <AgentChatInput
        onSend={handleSend}
        disabled={isStreaming}
        placeholder={placeholder}
      />
    </div>
  );
}
