import type { GenieWriterEvent } from "@dbx-tools/appkit-mastra-shared";
import type { UIMessage } from "ai";
import type { ExportFormat } from "../lib/export.js";

export type { ExportFormat } from "../lib/export.js";

// Public types for the chat UI: the controlled `ChatView` props plus
// the supporting tool-event / approval shapes a host transport feeds
// it. Kept dependency-free of the components so both the presentational
// layer and the `useMastraChat` driver can share them.

export type ChatStatus = "submitted" | "streaming" | "ready" | "error";

/**
 * Lifecycle of a single tool invocation surfaced inline in the assistant
 * bubble. `running` while we wait for the backend, `done` on `tool-result`,
 * `error` on `tool-error`. `progress` is an in-order log of mid-flight
 * events the tool itself pushed through Mastra's `ctx.writer`.
 */
export type ToolEvent = {
  id: string;
  toolName: string;
  status: "running" | "done" | "error";
  progress?: ToolProgress[];
};

/**
 * Normalised progress event shape. Aliases {@link GenieWriterEvent}
 * from `@dbx-tools/appkit-mastra-shared` so the Genie agent
 * (server) and the chat UI (client) stay in lock-step on the
 * unified flat `{type, ...}` events the `tool-output` chunks
 * carry. New variants should be added there.
 */
export type ToolProgress = GenieWriterEvent;

/** Subset of a Model Serving endpoint surfaced in the model picker. */
export type ChatModelOption = { name: string };

/** Thumbs reaction a user can leave on an assistant turn. */
export type FeedbackValue = "up" | "down";

/**
 * One feedback action from the user: a thumbs `value`, a freeform
 * `comment`, or both. Emitted by {@link ChatViewProps.onFeedback}.
 */
export type FeedbackSubmission = {
  value?: FeedbackValue;
  comment?: string;
};

/**
 * Feedback state for a single assistant message. `traceId` is the
 * MLflow trace the feedback attaches to (captured from the stream
 * response); its presence is what makes a bubble eligible for feedback
 * controls. `value` mirrors the last thumbs the user chose so the
 * active thumb stays highlighted.
 */
export type MessageFeedback = {
  traceId: string;
  value?: FeedbackValue;
};

/**
 * One conversation thread surfaced in the {@link ChatViewProps}
 * sidebar. A trimmed view of the wire `MastraThread`: only what the
 * list needs to render and reference a conversation.
 */
export type ThreadSummary = {
  /** Thread id. Passed back out via {@link ChatViewProps.onSelectThread}. */
  id: string;
  /** Human-readable title; falls back to a placeholder when absent (new threads). */
  title?: string;
  /** ISO-8601 last-activity timestamp, used to render a relative "time ago" hint. */
  updatedAt?: string;
};

export type ChatViewProps = {
  messages: UIMessage[];
  status: ChatStatus;
  /**
   * The error from the last failed turn, surfaced as a destructive
   * Alert when `status` is `"error"`. When omitted, the Alert shows a
   * generic message. `useMastraChat` populates it on the drop-in path;
   * a host driving `ChatView` itself supplies its own.
   */
  error?: Error | null;
  sendMessage: (message: { text: string }) => void;
  regenerate?: () => void;
  /**
   * Abort the in-flight response. When provided and the chat is running
   * (`status` is `"submitted"` or `"streaming"`), the composer swaps the
   * Send button for a Stop button that calls this. The handler should
   * cancel the active generation and return the chat to `"ready"`. Omit
   * to hide the Stop affordance (the Send button just disables while a
   * response streams).
   */
  onStop?: () => void;
  /** Extra classes merged onto the root layout container. */
  className?: string;
  /**
   * Starter questions shown as one-tap buttons on the empty state.
   * Defaults to none - nothing renders when omitted or empty, so the
   * component carries no built-in example prompts. The drop-in
   * `MastraChat` fills this from the agent's Genie space sample
   * questions when the caller doesn't pass an explicit list.
   */
  suggestions?: string[];
  toolEventsByMessage?: Record<string, ToolEvent[]>;
  /** Available model endpoints. Pass an empty array (or omit) to hide the picker. */
  models?: ChatModelOption[];
  /** Currently selected model name; empty string means "use server default". */
  model?: string;
  onModelChange?: (model: string) => void;
  /**
   * Optional infinite-scroll-up handler. Fired when the user scrolls
   * within `TOP_LOAD_MORE_THRESHOLD_PX` of the top of the
   * transcript. The parent is expected to fetch the next older page
   * and prepend it to `messages`; the view preserves the visual
   * scroll position across the prepend so the reveal feels like
   * paging up through history rather than a layout jump.
   */
  onLoadMore?: () => void;
  /** True while a {@link ChatViewProps.onLoadMore} fetch is in flight. */
  isLoadingMore?: boolean;
  /** True when more history is still available (drives the trigger). */
  hasMore?: boolean;
  /** True while the *initial* history page is loading. */
  isLoadingHistory?: boolean;
  /**
   * Resolve an approval-gated tool call. Fired when the user clicks
   * Approve or Deny on the inline approval card. The handler must
   * resume the suspended Mastra workflow on its own: with
   * `mastraClient.getAgent(...).stream()`, call
   * `agent.approveToolCall({ runId, toolCallId })` /
   * `agent.declineToolCall({ runId, toolCallId })` to get a fresh
   * stream Response and pipe it through the same chunk handler
   * (this is exactly what `useMastraChat` does).
   *
   * It requires the `runId` Mastra emitted with the approval
   * chunk - the field is always populated when the card was rendered
   * from a live `data-tool-call-approval` part or an out-of-band
   * `pendingApprovalsByMessage` entry. It will be missing only for
   * approvals reconstructed from history (where the original runId
   * is lost), in which case the handler should surface a "this
   * approval is stale, please re-ask the model" message rather than
   * trying to resume a workflow that no longer exists.
   */
  onResolveToolApproval?: (args: ApprovalDecision) => void | Promise<void>;
  /**
   * Out-of-band approval requests keyed by assistant message id, for
   * transports that don't surface approvals as `UIMessage` parts.
   * The `/stream` page populates this from Mastra's
   * `tool-call-approval` chunk so the same `ToolApprovalCard`
   * UI works without injecting synthetic data parts. Each entry is
   * merged with any approvals already discovered in `message.parts`.
   */
  pendingApprovalsByMessage?: Record<string, PendingApproval[]>;
  /**
   * Wipe the current chat thread. When provided, the header renders
   * a "Clear" button that calls this and shows a confirmation
   * prompt first. The handler is responsible for both the
   * server-side delete (typically `mastraClient.clearHistory()`) and
   * resetting client-side transcript / tool-event state so the
   * blank slate sticks across the next render. Omit to hide the
   * button entirely (read-only embeds, history-less agents).
   */
  onClear?: () => void | Promise<void>;
  /**
   * The caller's conversation threads, newest first. When provided
   * together with {@link onSelectThread}, the view renders a
   * collapsible sidebar listing them so the user can switch between
   * conversations. Omit (or pass without `onSelectThread`) to render
   * the classic single-thread chat with no sidebar.
   */
  threads?: ThreadSummary[];
  /** Id of the currently-active thread, highlighted in the sidebar. */
  activeThreadId?: string;
  /**
   * Thread ids with an in-flight generation (`submitted` or `streaming`).
   * Drives a per-row streaming indicator in the sidebar while a turn
   * continues after the user switches away.
   */
  streamingThreadIds?: string[];
  /** True while the initial thread list is loading (drives a sidebar spinner). */
  isLoadingThreads?: boolean;
  /**
   * Switch the conversation to `threadId`. The handler reloads that
   * thread's history and points subsequent turns at it. Providing this
   * (with {@link threads}) is what turns the sidebar on.
   */
  onSelectThread?: (threadId: string) => void;
  /**
   * Start a fresh conversation. The handler mints a new thread id,
   * clears the transcript, and points subsequent turns at it. When
   * provided, the sidebar shows a "New chat" affordance.
   */
  onNewThread?: () => void;
  /**
   * Delete a conversation by id. The handler removes it server-side and
   * refreshes the list; deleting the active thread starts a new one.
   * When provided, each sidebar row shows a delete affordance.
   */
  onDeleteThread?: (threadId: string) => void;
  /**
   * Rename a conversation by id. The handler persists the new title
   * server-side and updates the list (optimistically, so the new name
   * shows immediately). When provided, each sidebar row shows a rename
   * affordance that swaps the title into an inline text field.
   */
  onRenameThread?: (threadId: string, title: string) => void;
  /**
   * Controlled open/closed state for the conversation sidebar. When
   * omitted the view manages its own (session-only) open state; pass
   * this together with {@link onToggleSidebar} to control and persist
   * the show/hide choice from the host (the driver does this so the
   * choice survives reloads). The header toggle is shown whenever the
   * sidebar is enabled, regardless of who owns the state.
   */
  sidebarOpen?: boolean;
  /**
   * Toggle the conversation sidebar's visibility. Provided alongside
   * {@link sidebarOpen} for controlled mode; when omitted the view
   * flips its own internal open state.
   */
  onToggleSidebar?: () => void;
  /**
   * Export the whole conversation in the chosen {@link ExportFormat}
   * (PDF via the browser print dialog, or a Markdown download). When
   * provided, the header shows an Export menu. Charts and data tables are
   * inlined into the export. Omit to hide conversation-level export.
   */
  onExportConversation?: (format: ExportFormat) => void | Promise<void>;
  /**
   * Export a single message in the chosen {@link ExportFormat}. When
   * provided, each assistant bubble shows a per-message export menu.
   */
  onExportMessage?: (message: UIMessage, format: ExportFormat) => void | Promise<void>;
  /**
   * Feedback state keyed by assistant message id. Only messages with an
   * entry (i.e. a captured MLflow trace id) show feedback controls, so
   * this doubles as the "is feedback available for this message" gate.
   * `useMastraChat` populates it from each streamed turn's trace-id
   * response header when MLflow logging is enabled.
   */
  feedbackByMessage?: Record<string, MessageFeedback>;
  /**
   * Submit thumbs / comment feedback for an assistant message. When
   * provided (and the message has a {@link feedbackByMessage} entry),
   * the bubble shows thumbs up/down plus a comment affordance. The
   * handler logs the feedback to MLflow via the plugin's feedback route.
   */
  onFeedback?: (
    message: UIMessage,
    submission: FeedbackSubmission,
  ) => void | Promise<void>;
};

/** Payload {@link ChatViewProps.onResolveToolApproval} receives. */
export type ApprovalDecision =
  | {
      approved: true;
      toolName: string;
      toolCallId: string;
      /**
       * Mastra run id from the approval chunk. Required to resume
       * the suspended workflow; absent only when the card was
       * reconstructed from history (no live runId available).
       */
      runId?: string;
      input: unknown;
    }
  | {
      approved: false;
      toolName: string;
      toolCallId: string;
      runId?: string;
      input: unknown;
      reason: string;
    };

/**
 * One approval-gated tool call paused mid-turn. `runId` is the
 * Mastra workflow id needed to resume; it's always present when the
 * card was constructed from a live source (the stream's
 * `data-tool-call-approval` part or `pendingApprovalsByMessage`),
 * and absent only for approvals reconstructed from a history load
 * where the original runId is lost.
 */
export type PendingApproval = {
  toolName: string;
  toolCallId: string;
  /** Mastra run id from the approval chunk. */
  runId?: string;
  input: unknown;
};
