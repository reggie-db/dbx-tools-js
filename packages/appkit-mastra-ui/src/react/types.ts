import type { GenieWriterEvent } from "@dbx-tools/appkit-mastra-shared";
import type { UIMessage } from "ai";

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

export type ChatViewProps = {
  messages: UIMessage[];
  status: ChatStatus;
  /**
   * The error from the last failed turn, surfaced as a destructive
   * Alert when `status` is `"error"`. When omitted, the Alert shows a
   * generic message. Pairs with the AI SDK `useChat`'s `error` on the
   * controlled path; `useMastraChat` populates it on the drop-in path.
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
   * resume the suspended Mastra workflow on its own:
   *
   * - With `useChat` + `chatRoute()`, call
   *   `sendMessage(undefined, { body: { resumeData: { approved }, runId } })`
   *   so chatRoute hits `agent.resumeStream(resumeData)` and the
   *   suspended tool call wakes up.
   * - With `mastraClient.getAgent(...).stream()`, call
   *   `agent.approveToolCall({ runId, toolCallId })` /
   *   `agent.declineToolCall({ runId, toolCallId })` to get a fresh
   *   stream Response and pipe it through the same chunk handler.
   *
   * Both paths require the `runId` Mastra emitted with the approval
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
   * server-side delete (typically `clearMastraHistory`) and
   * resetting client-side transcript / tool-event state so the
   * blank slate sticks across the next render. Omit to hide the
   * button entirely (read-only embeds, history-less agents).
   */
  onClear?: () => void | Promise<void>;
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
 * card was constructed from a live source (chatRoute's
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
