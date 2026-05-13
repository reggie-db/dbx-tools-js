import { connectSSE } from "@databricks/appkit-ui/js";
import type { AgentChatEvent } from "@databricks/appkit-ui/react";
import { useCallback, useEffect, useRef, useState } from "react";

// Wrapper around the agents plugin POST /api/agents/chat SSE stream that adds
// the things @databricks/appkit-ui's `useAgentChat` does not:
//
// 1. Hydrates the thread id from localStorage on mount, so a page refresh or a
//    component remount continues the same server-side thread (the agents
//    plugin keys thread history by id, so without rehydration every new mount
//    starts a fresh thread and the LLM forgets the conversation).
// 2. Persists the thread id back to localStorage on every metadata event.
// 3. On a "Thread <id> not found" error (HTTP 404 - happens after a server
//    restart wipes the in-memory ThreadStore) it drops the stale id and
//    retries the send once with a fresh thread.

export interface UseAgentChatOptions {
  /** Agent name registered with the `agents()` plugin. */
  agent: string;
  /** Chat endpoint. Default `"/api/agents/chat"`. */
  endpoint?: string;
  /** localStorage key used to persist the thread id. Default `"dbx-tools.agent.<agent>.threadId"`. */
  storageKey?: string;
  /**
   * Called for every parsed SSE event before any internal state update.
   * Errors thrown here are swallowed so a buggy handler cannot kill the stream.
   */
  onEvent?: (event: AgentChatEvent) => void;
}

export interface UseAgentChatResult {
  /** Accumulated assistant text from `response.output_text.delta` events. */
  content: string;
  /** Thread id captured from the first `appkit.metadata` event. */
  threadId: string | null;
  /** True while an SSE stream is open. */
  isStreaming: boolean;
  /** Last error message, cleared on next successful `send()`. */
  error: string | null;
  /**
   * Send a user turn and stream the response. Aborts any in-flight stream.
   * Resolves when the stream completes (success or error).
   */
  send: (message: string) => Promise<void>;
  /**
   * Discard accumulated content, threadId, and any in-flight stream. Use when
   * switching agents or starting a fresh conversation.
   */
  reset: () => void;
}

function defaultStorageKey(agent: string): string {
  return `dbx-tools.agent.${agent}.threadId`;
}

function loadStoredThreadId(storageKey: string): string | null {
  try {
    const value = localStorage.getItem(storageKey);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function persistThreadId(storageKey: string, value: string | null): void {
  try {
    if (value) localStorage.setItem(storageKey, value);
    else localStorage.removeItem(storageKey);
  } catch {
    /* localStorage may be unavailable (private mode, quota) */
  }
}

export function useAgentChat({
  agent,
  endpoint = "/api/agents/chat",
  storageKey,
  onEvent,
}: UseAgentChatOptions): UseAgentChatResult {
  const resolvedKey = storageKey ?? defaultStorageKey(agent);
  const [content, setContent] = useState("");
  const [threadId, setThreadId] = useState<string | null>(() =>
    loadStoredThreadId(resolvedKey),
  );
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const threadIdRef = useRef<string | null>(threadId);
  threadIdRef.current = threadId;
  const contentRef = useRef("");
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const abortControllerRef = useRef<AbortController | null>(null);

  const updateThreadId = useCallback(
    (value: string | null) => {
      threadIdRef.current = value;
      setThreadId(value);
      persistThreadId(resolvedKey, value);
    },
    [resolvedKey],
  );

  const reset = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    contentRef.current = "";
    setContent("");
    setIsStreaming(false);
    setError(null);
    updateThreadId(null);
  }, [updateThreadId]);

  const runStream = useCallback(
    async (message: string): Promise<{ staleThread: boolean }> => {
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;
      contentRef.current = "";
      setContent("");
      setError(null);
      setIsStreaming(true);

      const payload = {
        message,
        agent,
        ...(threadIdRef.current ? { threadId: threadIdRef.current } : {}),
      };

      let staleThread = false;
      let streamError: string | null = null;

      try {
        await connectSSE({
          url: endpoint,
          payload,
          signal: controller.signal,
          maxRetries: 0,
          onMessage: async ({ data }) => {
            if (controller.signal.aborted) return;
            if (!data || data === "[DONE]") return;

            let event: AgentChatEvent;
            try {
              event = JSON.parse(data) as AgentChatEvent;
            } catch {
              return;
            }
            if (!event.type) return;

            try {
              onEventRef.current?.(event);
            } catch {
              /* user-supplied callback errors must not kill the stream */
            }

            if (event.type === "appkit.metadata") {
              const tid = (event.data as { threadId?: unknown } | undefined)
                ?.threadId;
              if (typeof tid === "string" && tid.length > 0) {
                updateThreadId(tid);
              }
            } else if (
              event.type === "response.output_text.delta" &&
              typeof event.delta === "string"
            ) {
              contentRef.current += event.delta;
              setContent(contentRef.current);
            } else if (
              event.type === "error" &&
              typeof event.error === "string"
            ) {
              streamError = event.error;
            }
          },
          onError: (err) => {
            if (controller.signal.aborted) return;
            const message = err instanceof Error ? err.message : String(err);
            streamError = message;
            if (/Thread .* not found/i.test(message) || /\b404\b/.test(message)) {
              staleThread = true;
            }
          },
        });
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        setIsStreaming(false);
      }

      if (streamError && !controller.signal.aborted) setError(streamError);
      return { staleThread };
    },
    [agent, endpoint, updateThreadId],
  );

  const send = useCallback(
    async (message: string) => {
      const { staleThread } = await runStream(message);
      if (!staleThread) return;
      // Stale thread (server restart / GC). Drop the local id and try once
      // more with a fresh thread so the user is not left with a dead chat.
      updateThreadId(null);
      await runStream(message);
    },
    [runStream, updateThreadId],
  );

  useEffect(
    () => () => {
      abortControllerRef.current?.abort();
    },
    [],
  );

  return { content, threadId, isStreaming, error, send, reset };
}
