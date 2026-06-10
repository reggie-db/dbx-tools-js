import {
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
import {
  ArrowDownIcon,
  MessageSquareIcon,
  SendIcon,
  Trash2Icon,
} from "lucide-react";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AssistantBubble, UserBubble } from "./bubbles.js";
import type { ChatViewProps } from "./types.js";

// Controlled, presentational chat shell: the scroll container, header
// (model picker + clear), empty state, transcript of message bubbles,
// and the composer. All conversation state is owned by the caller and
// fed in through props - this component renders it and reports user
// intent back out (send, regenerate, load-more, clear, approve).

const DEFAULT_SUGGESTIONS = [
  "Tell me about Spirited Away",
  "Who are the main characters in Princess Mononoke?",
  "Summarize the plot of Howl's Moving Castle",
];

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
  sendMessage,
  regenerate,
  className,
  suggestions = DEFAULT_SUGGESTIONS,
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
}: ChatViewProps) => {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
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
  const showWaiting = status === "submitted" || status === "streaming";
  const waitingLabel = !lastAssistantHasContent
    ? "Thinking..."
    : hasRunningTool
      ? "Working..."
      : "Composing response...";

  const showModelPicker = Boolean(models && models.length > 0 && onModelChange);
  const showClear = Boolean(onClear);
  const showHeader = showModelPicker || showClear;

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
      <div className={cn("mx-auto flex h-full max-w-4xl flex-col p-0 md:p-6", className)}>
        {showHeader && (
          <div className="flex items-center justify-end gap-3 px-4 pb-2 pt-1 text-xs text-muted-foreground">
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
                    <SelectItem value={DEFAULT_MODEL_VALUE}>Server default</SelectItem>
                    {models!.map((m) => (
                      <SelectItem key={m.name} value={m.name}>
                        {m.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
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
        )}
        <div className="relative flex flex-1 flex-col overflow-hidden">
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto"
          >
            {messages.length === 0 && !isLoadingHistory ? (
              <Empty className="h-full">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <MessageSquareIcon className="size-5" />
                  </EmptyMedia>
                  <EmptyTitle>Start a conversation</EmptyTitle>
                  <EmptyDescription>
                    Ask anything, or pick a suggestion below.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="flex flex-col gap-4 p-4">
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
                      />
                    );
                  }
                  return <UserBubble key={message.id} message={message} />;
                })}
                {showWaiting && (
                  <div className="flex items-center gap-2 px-3 text-xs text-muted-foreground">
                    <Spinner className="size-3" />
                    <span className="animate-pulse">{waitingLabel}</span>
                  </div>
                )}
              </div>
            )}
          </div>
          {!isAtBottom && (
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={scrollToBottom}
              className="absolute bottom-4 right-4 rounded-full shadow"
            >
              <ArrowDownIcon className="size-4" />
            </Button>
          )}
        </div>

        {messages.length === 0 && suggestions.length > 0 && (
          <div className="flex flex-wrap gap-2 px-4 pb-2">
            {suggestions.map((s) => (
              <Button
                key={s}
                type="button"
                size="sm"
                variant="outline"
                onClick={() => sendMessage({ text: s })}
              >
                {s}
              </Button>
            ))}
          </div>
        )}

        <form onSubmit={handleSubmit} className="px-4 pb-4 pt-2">
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
              <InputGroupButton
                type="submit"
                size="icon-sm"
                variant="default"
                disabled={
                  !input.trim() || status === "streaming" || status === "submitted"
                }
              >
                {status === "streaming" || status === "submitted" ? (
                  <Spinner className="size-3" />
                ) : (
                  <SendIcon className="size-3" />
                )}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </form>
      </div>
    </TooltipProvider>
  );
};
