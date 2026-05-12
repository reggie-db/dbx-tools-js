import { cn, ScrollArea } from "@databricks/appkit-ui/react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { AgentChatMessage } from "./agent-chat-message.js";
import type { ChatTurn } from "./types.js";

// Scrollable message list with auto-scroll-on-append. Mirrors the structure
// of @databricks/appkit-ui's GenieChatMessageList: a ScrollArea wrapping a
// vertical stack of chat bubbles, with an empty-state slot.

function getViewport(
  scrollRef: RefObject<HTMLDivElement | null>,
): HTMLElement | null {
  return (
    scrollRef.current?.querySelector(
      '[data-slot="scroll-area-viewport"]',
    ) ?? null
  );
}

function useAutoScroll(
  scrollRef: RefObject<HTMLDivElement | null>,
  messages: ChatTurn[],
  liveContentLen: number,
) {
  const prevCountRef = useRef(0);
  // Scroll to bottom whenever a new message is appended or the streaming
  // assistant's text grows. Cheaper than tracking individual mutations.
  useLayoutEffect(() => {
    const viewport = getViewport(scrollRef);
    if (!viewport) return;
    const count = messages.length;
    const appended = count !== prevCountRef.current;
    prevCountRef.current = count;
    if (appended || liveContentLen > 0) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [messages, liveContentLen, scrollRef]);

  // Also follow growth from tool-progress updates (these don't change message
  // count but do change rendered height under the last tool-call card).
  useEffect(() => {
    const viewport = getViewport(scrollRef);
    if (!viewport) return;
    const observer = new ResizeObserver(() => {
      const isNearBottom =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80;
      if (isNearBottom) viewport.scrollTop = viewport.scrollHeight;
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [scrollRef]);
}

export interface AgentChatMessageListProps {
  messages: ChatTurn[];
  /** Live-streamed text of the in-flight assistant turn. Drives auto-scroll. */
  liveContent: string;
  welcome?: ReactNode;
  className?: string;
}

// The "Thinking..." indicator is rendered inline by `AgentChatMessage` (next
// to the assistant avatar) when the latest assistant turn is streaming with
// no content and no active tool call. A list-level duplicate is intentionally
// omitted to avoid two simultaneous spinners.

export function AgentChatMessageList({
  messages,
  liveContent,
  welcome,
  className,
}: AgentChatMessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useAutoScroll(scrollRef, messages, liveContent.length);

  return (
    <ScrollArea
      ref={scrollRef}
      className={cn(
        "flex-1 min-h-0 p-4 [&_[data-slot=scroll-area-viewport]>div]:!block",
        className,
      )}
    >
      <div className="flex flex-col gap-4 min-w-0">
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm py-12 text-center">
            {welcome ?? "Start a conversation by typing a question below."}
          </div>
        ) : (
          messages.map((turn) => (
            <AgentChatMessage key={turn.id} turn={turn} />
          ))
        )}
      </div>
    </ScrollArea>
  );
}
