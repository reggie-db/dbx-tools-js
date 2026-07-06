import { cn } from "@databricks/appkit-ui/react";
import React from "react";
import { useConversations } from "../lib/mastra-client.js";
import { ConversationList } from "./conversation-list.js";
import { MastraChat } from "./mastra-chat.js";
import type { MastraChatProps } from "./mastra-chat.js";

export interface ConversationShellProps extends Omit<MastraChatProps, "threadId"> {
  /**
   * Extra classes merged onto the outer wrapper div. The shell uses a
   * fixed `h-full flex` layout so it fills whatever container it is
   * placed in; apply height constraints on the parent.
   */
  className?: string;
  /** Width of the conversation sidebar. Defaults to `"w-60"`. */
  sidebarClassName?: string;
}

/**
 * Full conversation management shell: a fixed sidebar listing stored
 * threads next to the `MastraChat` panel. Selecting a thread from the
 * sidebar switches the chat to that conversation and re-hydrates its
 * history. "New chat" creates a fresh thread and immediately focuses it.
 *
 * Drop this in anywhere you'd use `MastraChat` and want multi-
 * conversation support. All `MastraChatProps` (except `threadId`, which
 * is managed internally) flow through to the underlying `MastraChat`.
 */
export const ConversationShell = ({
  className,
  sidebarClassName,
  agentId,
  ...chatProps
}: ConversationShellProps) => {
  const { threads, selectedThreadId, loading, error, selectThread, createThread } =
    useConversations(agentId);

  const handleNew = async () => {
    await createThread();
  };

  return (
    <div className={cn("flex h-full min-h-0", className)}>
      <aside
        className={cn(
          "flex-shrink-0 border-r bg-muted/30",
          sidebarClassName ?? "w-60",
        )}
      >
        <ConversationList
          threads={threads}
          selectedThreadId={selectedThreadId}
          loading={loading}
          error={error}
          onSelect={selectThread}
          onNew={handleNew}
          className="h-full"
        />
      </aside>

      <div className="flex-1 min-w-0">
        <MastraChat
          {...chatProps}
          agentId={agentId}
          threadId={selectedThreadId ?? undefined}
        />
      </div>
    </div>
  );
};
