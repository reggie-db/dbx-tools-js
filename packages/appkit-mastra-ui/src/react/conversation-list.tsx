import {
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Spinner,
  cn,
} from "@databricks/appkit-ui/react";
import { MessageSquareIcon, PlusIcon } from "lucide-react";
import React, { useState } from "react";
import type { MastraThread } from "@dbx-tools/appkit-mastra-shared";

export interface ConversationListProps {
  threads: MastraThread[];
  selectedThreadId: string | null;
  loading: boolean;
  error: Error | null;
  onSelect: (threadId: string) => void;
  onNew: () => Promise<void>;
  className?: string;
}

/**
 * Sidebar list of stored conversation threads. Shows a "New chat"
 * button at the top, then the thread list ordered newest-first.
 * Threads without a title fall back to a formatted `createdAt` date.
 */
export const ConversationList = ({
  threads,
  selectedThreadId,
  loading,
  error,
  onSelect,
  onNew,
  className,
}: ConversationListProps) => {
  const [isCreating, setIsCreating] = useState(false);

  const handleNew = async () => {
    if (isCreating) return;
    setIsCreating(true);
    try {
      await onNew();
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className={cn("flex flex-col h-full", className)}>
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <span className="text-sm font-medium text-foreground">Conversations</span>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={handleNew}
          disabled={isCreating}
          aria-label="New conversation"
        >
          {isCreating ? <Spinner className="size-3.5" /> : <PlusIcon className="size-3.5" />}
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && threads.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
            <Spinner className="size-3" />
            <span>Loading conversations...</span>
          </div>
        ) : error && threads.length === 0 ? (
          <div className="px-3 py-4 text-xs text-destructive">
            Failed to load conversations.
          </div>
        ) : threads.length === 0 ? (
          <Empty className="h-full px-3">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MessageSquareIcon className="size-4" />
              </EmptyMedia>
              <EmptyTitle className="text-sm">No conversations yet</EmptyTitle>
              <EmptyDescription className="text-xs">
                Start a new chat to begin.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="py-1">
            {threads.map((thread) => (
              <li key={thread.id}>
                <button
                  type="button"
                  onClick={() => onSelect(thread.id)}
                  className={cn(
                    "w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors",
                    "flex flex-col gap-0.5 min-w-0",
                    selectedThreadId === thread.id && "bg-accent font-medium",
                  )}
                >
                  <span className="truncate leading-snug">
                    {thread.title ?? formatThreadDate(thread.createdAt)}
                  </span>
                  <span className="text-xs text-muted-foreground truncate">
                    {formatRelativeTime(thread.updatedAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

function formatThreadDate(isoString: string): string {
  try {
    return new Date(isoString).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "Conversation";
  }
}

function formatRelativeTime(isoString: string): string {
  try {
    const diff = Date.now() - new Date(isoString).getTime();
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(isoString).toLocaleDateString();
  } catch {
    return "";
  }
}
