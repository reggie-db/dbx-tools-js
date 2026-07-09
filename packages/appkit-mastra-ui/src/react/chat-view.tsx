import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@databricks/appkit-ui/react";
import { commonUtils } from "@dbx-tools/shared";
import {
  ArrowDownIcon,
  MessageSquareIcon,
  PanelLeftIcon,
  RefreshCwIcon,
  SendIcon,
  SquareIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AssistantBubble, UserBubble } from "./bubbles.js";
import { ExportMenu } from "./export-menu.js";
import { SuggestionPills } from "./suggestion-pills.js";
import { ThreadSidebar } from "./thread-sidebar.js";
import type { ChatViewProps } from "./types.js";

// Controlled, presentational chat shell: the scroll container, header
// (model picker + clear), empty state, transcript of message bubbles,
// and the composer. All conversation state is owned by the caller and
// fed in through props - this component renders it and reports user
// intent back out (send, regenerate, load-more, clear, approve).

const BOTTOM_THRESHOLD_PX = 24;
/**
 * Distance from the top of the scroll container at which we trigger
 * `onLoadMore`. Sized to give the lazy fetch a head-start before the
 * user actually hits the top so the reveal feels seamless.
 */
const TOP_LOAD_MORE_THRESHOLD_PX = 120;

/**
 * Sentinel for "no explicit model" in the Select. Radix's `SelectItem`
 * forbids an empty string `value`, so we map `""` <-> `__default__`
 * across the dropdown boundary.
 */
const DEFAULT_MODEL_VALUE = "__default__";

export const ChatView = ({
  messages,
  status,
  error,
  sendMessage,
  regenerate,
  onStop,
  className,
  suggestions = [],
  toolEventsByMessage = {},
  models,
  model,
  onModelChange,
  onLoadMore,
  isLoadingMore = false,
  hasMore = false,
  isLoadingHistory = false,
  onResolveToolApproval,
  pendingApprovalsByMessage = {},
  onClear,
  threads,
  activeThreadId,
  streamingThreadIds = [],
  isLoadingThreads = false,
  onSelectThread,
  onNewThread,
  onDeleteThread,
  onRenameThread,
  sidebarOpen: sidebarOpenProp,
  onToggleSidebar,
  onExportConversation,
  onExportMessage,
  feedbackByMessage = {},
  onFeedback,
}: ChatViewProps) => {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  // Mirror `isAtBottom` into a ref so the ResizeObserver below (created
  // per transcript mount, not per render) reads the latest value
  // without re-subscribing every time the flag toggles.
  const isAtBottomRef = useRef(isAtBottom);
  isAtBottomRef.current = isAtBottom;
  // Scroll-anchor state for prepending older messages. When the
  // parent answers an `onLoadMore` call we capture the pre-prepend
  // `scrollHeight`/`scrollTop`; once the new DOM nodes mount we shift
  // `scrollTop` so the previously-visible content stays in place
  // (instead of jumping to the bottom of the new transcript).
  const prependAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(
    null,
  );
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;

  // Auto-scroll to bottom whenever a new chunk lands, but only while the
  // user is already pinned to the bottom. Lets them scroll up to read
  // history mid-stream without the view yanking them back. Skip the
  // adjust when an older page was just prepended (the anchor restore
  // below owns that case).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (prependAnchorRef.current) return;
    if (!isAtBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, toolEventsByMessage, isAtBottom]);

  // Keep the view pinned to the bottom as streamed content grows. The
  // `messages`-dep effect above only fires when the array reference
  // changes; a ResizeObserver on the transcript also catches height
  // growth that lands without a new `messages` ref - token-by-token
  // text, async markdown/syntax layout, the in-flight waiting row - so
  // the scroll keeps up while the user is pinned to the bottom. Only
  // pins when already at the bottom, so scrolling up to read history
  // mid-stream still works. Re-subscribes when the transcript mounts
  // (empty -> first message, or history finishes loading).
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const observer = new ResizeObserver(() => {
      if (prependAnchorRef.current || !isAtBottomRef.current) return;
      el.scrollTop = el.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [messages.length, isLoadingHistory]);

  // Restore the visual scroll position after a prepend. Runs in
  // `useLayoutEffect` so the adjustment happens before the browser
  // paints; an effect would let the new content flash at the top.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = prependAnchorRef.current;
    prependAnchorRef.current = null;
    if (!el || !anchor) return;
    const delta = el.scrollHeight - anchor.scrollHeight;
    el.scrollTop = anchor.scrollTop + delta;
  }, [messages]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setIsAtBottom(
      el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD_PX,
    );
    // Lazy-load older messages once the user gets close to the top.
    // Capture the anchor *before* firing the callback so the parent's
    // synchronous state updates don't beat us to the layout effect.
    if (
      el.scrollTop <= TOP_LOAD_MORE_THRESHOLD_PX &&
      hasMore &&
      !isLoadingMore &&
      loadMoreRef.current
    ) {
      prependAnchorRef.current = {
        scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop,
      };
      loadMoreRef.current();
    }
  };

  const scrollToBottom = () => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  };

  // A turn is in flight from the moment the run opens (`submitted`)
  // until the server signals done (`ready`/`error`). Used to gate new
  // submissions and to swap the composer's Send button for Stop.
  const isRunning = status === "submitted" || status === "streaming";

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Don't queue a new turn while one is streaming - the Enter-key
    // path would otherwise bypass the disabled Send button.
    if (isRunning) return;
    const text = input.trim();
    if (!text) return;
    sendMessage({ text });
    setInput("");
  };

  const lastMessage = messages.at(-1);
  const lastEvents = lastMessage ? toolEventsByMessage[lastMessage.id] : undefined;
  // Single in-flight indicator for the whole turn: visible from the
  // moment the agent run opens (`status === "submitted"`) until the
  // server signals done (`status === "ready"` / `"error"`). The label
  // refines based on what the turn is currently doing so the user
  // gets a finer-grained hint without the spinner blinking on/off
  // between text, tool, and "between-step" phases.
  const lastAssistantParts = lastMessage?.role === "assistant" ? lastMessage.parts : [];
  const lastAssistantHasContent =
    lastAssistantParts.some(
      (p) =>
        (p.type === "text" || p.type === "reasoning") &&
        Boolean((p as { text?: string }).text),
    ) || (lastEvents?.length ?? 0) > 0;
  const hasRunningTool = (lastEvents ?? []).some((e) => e.status === "running");
  const showWaiting = isRunning;
  const waitingLabel = !lastAssistantHasContent
    ? "Thinking..."
    : hasRunningTool
      ? "Working..."
      : "Composing response...";

  const showModelPicker = Boolean(models && models.length > 0 && onModelChange);
  const showClear = Boolean(onClear);
  const showExport = Boolean(onExportConversation);
  // The conversation sidebar turns on once the host wires both the
  // thread list and a selection handler. A header toggle lets the user
  // show/hide it on demand. Open state is controlled when the caller
  // supplies `sidebarOpen` + `onToggleSidebar` (the driver does this and
  // persists the choice); otherwise the view manages a session-only
  // open flag. Defaults to open.
  const showSidebar = Boolean(threads && onSelectThread);
  const [internalSidebarOpen, setInternalSidebarOpen] = useState(true);
  const sidebarOpen = sidebarOpenProp ?? internalSidebarOpen;
  const toggleSidebar = () => {
    if (onToggleSidebar) onToggleSidebar();
    else setInternalSidebarOpen((open) => !open);
  };
  const showHeader = showModelPicker || showClear || showSidebar || showExport;

  // Local "in-flight" + confirm latch for the clear button so the
  // user can't double-fire the DELETE and so a stray click doesn't
  // wipe history without a beat to back out. Resets back to idle
  // after the parent's `onClear` settles (success or failure).
  const [clearState, setClearState] = useState<"idle" | "confirm" | "clearing">("idle");

  const handleClearClick = async () => {
    if (clearState === "clearing" || !onClear) return;
    if (clearState === "idle") {
      setClearState("confirm");
      return;
    }
    setClearState("clearing");
    try {
      await onClear();
    } finally {
      setClearState("idle");
    }
  };

  return (
    <TooltipProvider delayDuration={200}>
      {/*
       * Outer row hosts the optional conversation sidebar beside the
       * chat column. The chat column owns the vertical layout and the
       * scroll; the centered `max-w-4xl` framing lives on each section
       * (header, transcript, suggestions, composer) instead of the
       * outer shell, so the scroll area's scrollbar sits at the far
       * right - outside the centered column - and the composer lines up
       * with the message column regardless of whether a scrollbar is
       * showing.
       */}
      <div className={cn("flex h-full", className)}>
        {showSidebar && sidebarOpen && (
          <ThreadSidebar
            threads={threads ?? []}
            {...(activeThreadId ? { activeThreadId } : {})}
            streamingThreadIds={streamingThreadIds}
            isLoading={isLoadingThreads}
            onSelect={(id) => onSelectThread?.(id)}
            {...(onNewThread ? { onNew: onNewThread } : {})}
            {...(onDeleteThread ? { onDelete: onDeleteThread } : {})}
            {...(onRenameThread ? { onRename: onRenameThread } : {})}
            onHide={toggleSidebar}
          />
        )}
        <div className="flex h-full min-w-0 flex-1 flex-col py-0 md:py-6">
          {showHeader && (
            <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-3 px-4 pb-2 pt-1 text-xs text-muted-foreground md:px-6">
              <div className="flex items-center gap-2">
                {/*
                 * The hide control lives on the sidebar itself; the header
                 * only offers a "show" toggle while the sidebar is collapsed.
                 */}
                {showSidebar && !sidebarOpen && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={toggleSidebar}
                        aria-label="Show conversations"
                      >
                        <PanelLeftIcon className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Show conversations</TooltipContent>
                  </Tooltip>
                )}
              </div>
              <div className="flex items-center gap-3">
                {showModelPicker && (
                  <div className="flex items-center gap-2">
                    <span>Model</span>
                    <Select
                      value={model ? model : DEFAULT_MODEL_VALUE}
                      onValueChange={(v) =>
                        onModelChange?.(v === DEFAULT_MODEL_VALUE ? "" : v)
                      }
                    >
                      <SelectTrigger size="sm" className="w-[260px]">
                        <SelectValue placeholder="Server default" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={DEFAULT_MODEL_VALUE}>
                          Server default
                        </SelectItem>
                        {models!.map((m) => (
                          <SelectItem key={m.name} value={m.name}>
                            {m.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {showExport && (
                  <ExportMenu
                    onExport={(format) => void onExportConversation?.(format)}
                    tooltip="Export conversation"
                  />
                )}
                {showClear && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant={clearState === "confirm" ? "destructive" : "outline"}
                        size="sm"
                        onClick={handleClearClick}
                        onBlur={() =>
                          // Drop the confirm latch when focus leaves so a
                          // half-armed button doesn't sit destructive-red
                          // forever after the user clicks away.
                          setClearState((s) => (s === "confirm" ? "idle" : s))
                        }
                        disabled={clearState === "clearing"}
                        className="gap-1.5"
                      >
                        {clearState === "clearing" ? (
                          <Spinner className="size-3" />
                        ) : (
                          <Trash2Icon className="size-3" />
                        )}
                        {clearState === "confirm"
                          ? "Confirm clear"
                          : clearState === "clearing"
                            ? "Clearing..."
                            : "Clear"}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {clearState === "confirm"
                        ? "Click again to confirm; wipes this conversation."
                        : "Clear chat history for this thread"}
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            </div>
          )}
          <div className="relative flex flex-1 flex-col overflow-hidden">
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              className="flex-1 overflow-y-auto [scrollbar-gutter:stable]"
            >
              {messages.length === 0 && !isLoadingHistory ? (
                <Empty className="mx-auto h-full w-full max-w-4xl px-4 md:px-6">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <MessageSquareIcon className="size-5" />
                    </EmptyMedia>
                    <EmptyTitle>Start a conversation</EmptyTitle>
                    <EmptyDescription>
                      {suggestions.length > 0
                        ? "Ask anything, or pick a suggestion below."
                        : "Ask anything to get started."}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <div
                  ref={contentRef}
                  className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-4 md:px-6"
                >
                  {(isLoadingMore || isLoadingHistory) && (
                    <div className="flex items-center justify-center gap-2 py-1 text-xs text-muted-foreground">
                      <Spinner className="size-3" />
                      <span>
                        {isLoadingHistory
                          ? "Loading history..."
                          : "Loading older messages..."}
                      </span>
                    </div>
                  )}
                  {messages.map((message, i) => {
                    const isLast = i === messages.length - 1;
                    if (message.role === "assistant") {
                      return (
                        <AssistantBubble
                          key={message.id}
                          message={message}
                          isLast={isLast}
                          status={status}
                          events={toolEventsByMessage[message.id]}
                          regenerate={regenerate}
                          onSuggestionClick={(text) => sendMessage({ text })}
                          onResolveToolApproval={onResolveToolApproval}
                          externalApprovals={pendingApprovalsByMessage[message.id]}
                          {...(onExportMessage
                            ? {
                                onExport: (format) => onExportMessage(message, format),
                              }
                            : {})}
                          {...(onFeedback && feedbackByMessage[message.id]
                            ? {
                                onFeedback: (submission) =>
                                  onFeedback(message, submission),
                                ...(feedbackByMessage[message.id]?.value
                                  ? {
                                      feedbackValue:
                                        feedbackByMessage[message.id]!.value,
                                    }
                                  : {}),
                              }
                            : {})}
                        />
                      );
                    }
                    return <UserBubble key={message.id} message={message} />;
                  })}
                  {showWaiting && (
                    <div className="flex h-7 items-center gap-2 px-3 text-xs text-muted-foreground">
                      <Spinner className="size-3" />
                      <span className="animate-pulse">{waitingLabel}</span>
                    </div>
                  )}
                  {status === "error" && (
                    <div className="flex flex-col items-start gap-2">
                      <Alert variant="destructive">
                        <TriangleAlertIcon className="size-4" />
                        <AlertTitle>Something went wrong</AlertTitle>
                        <AlertDescription>
                          {error
                            ? commonUtils.errorMessage(error)
                            : "The assistant ran into an error. Please try again."}
                        </AlertDescription>
                      </Alert>
                      {regenerate && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={regenerate}
                          className="gap-1.5"
                        >
                          <RefreshCwIcon className="size-3" />
                          Retry
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
            {!isAtBottom && (
              <div className="pointer-events-none absolute inset-x-0 bottom-4 mx-auto flex w-full max-w-4xl justify-end px-4 md:px-6">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={scrollToBottom}
                  className="pointer-events-auto rounded-full shadow"
                >
                  <ArrowDownIcon className="size-4" />
                </Button>
              </div>
            )}
          </div>

          {messages.length === 0 && (
            <SuggestionPills
              questions={suggestions}
              onSelect={(s) => sendMessage({ text: s })}
              className="mx-auto w-full max-w-4xl px-4 pb-2 md:px-6"
            />
          )}

          <form
            onSubmit={handleSubmit}
            className="mx-auto w-full max-w-4xl px-4 pb-4 pt-2 md:px-6"
          >
            <InputGroup>
              <InputGroupTextarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSubmit(e as unknown as React.FormEvent);
                  }
                }}
                placeholder="Send a message..."
                rows={1}
              />
              <InputGroupAddon align="inline-end">
                {isRunning && onStop ? (
                  <InputGroupButton
                    type="button"
                    size="icon-sm"
                    variant="default"
                    onClick={onStop}
                    aria-label="Stop response"
                  >
                    <SquareIcon className="size-3 fill-current" />
                  </InputGroupButton>
                ) : (
                  <InputGroupButton
                    type="submit"
                    size="icon-sm"
                    variant="default"
                    disabled={!input.trim() || isRunning}
                    aria-label="Send message"
                  >
                    {isRunning ? (
                      <Spinner className="size-3" />
                    ) : (
                      <SendIcon className="size-3" />
                    )}
                  </InputGroupButton>
                )}
              </InputGroupAddon>
            </InputGroup>
          </form>
        </div>
      </div>
    </TooltipProvider>
  );
};
