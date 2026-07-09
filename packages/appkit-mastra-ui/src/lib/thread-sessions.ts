import type { UIMessage } from "ai";
import type {
  ChatStatus,
  MessageFeedback,
  PendingApproval,
  ToolEvent,
} from "../react/types.js";

/** Session-scoped transcript + stream state for one conversation thread. */
export type ThreadSession = {
  messages: UIMessage[];
  status: ChatStatus;
  error: Error | null;
  toolEventsByMessage: Record<string, ToolEvent[]>;
  pendingApprovalsByMessage: Record<string, PendingApproval[]>;
  feedbackByMessage: Record<string, MessageFeedback>;
  abortController: AbortController | null;
  runToken: number;
  assistantId: string | null;
  runId: string | null;
  historyLoaded: boolean;
  hasMoreHistory: boolean;
  historyPage: number;
  lastUserText: string | null;
};

/** Map key for the classic single-thread chat (no explicit thread id). */
export const DEFAULT_THREAD_SESSION_KEY = "__session__";

export function createThreadSession(): ThreadSession {
  return {
    messages: [],
    status: "ready",
    error: null,
    toolEventsByMessage: {},
    pendingApprovalsByMessage: {},
    feedbackByMessage: {},
    abortController: null,
    runToken: 0,
    assistantId: null,
    runId: null,
    historyLoaded: false,
    hasMoreHistory: false,
    historyPage: 0,
    lastUserText: null,
  };
}

export function isSessionRunning(session: ThreadSession): boolean {
  return session.status === "submitted" || session.status === "streaming";
}

export function sessionKey(activeThreadId: string | undefined): string {
  return activeThreadId ?? DEFAULT_THREAD_SESSION_KEY;
}
