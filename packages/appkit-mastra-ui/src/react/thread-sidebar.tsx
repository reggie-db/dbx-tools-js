import { MASTRA_THREAD_TITLE_MAX } from "@dbx-tools/appkit-mastra-shared";
import {
  Button,
  Input,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from "@databricks/appkit-ui/react";
import {
  MessageSquarePlusIcon,
  PanelLeftIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";
import type { ThreadSummary } from "./types.js";

// Presentational conversation list. Renders the threads a resource owns
// so the user can switch between them, start a new one, rename one, and
// delete one. All state is owned by the caller (the `useMastraChat`
// driver) and fed in through props; this component only reports intent
// back out (rename is edited inline against local draft state here).

/** Props for {@link ThreadSidebar}. */
export interface ThreadSidebarProps {
  /** Threads to list, newest first. */
  threads: ThreadSummary[];
  /** Id of the active thread, rendered highlighted. */
  activeThreadId?: string;
  /** True while the initial list loads (shows a spinner in place of the list). */
  isLoading?: boolean;
  /** Switch to a thread. */
  onSelect: (threadId: string) => void;
  /** Start a fresh conversation. Hidden when omitted. */
  onNew?: () => void;
  /** Delete a thread. Per-row trash affordance hidden when omitted. */
  onDelete?: (threadId: string) => void;
  /** Rename a thread. Per-row edit affordance (inline text field) hidden when omitted. */
  onRename?: (threadId: string, title: string) => void;
  /** Collapse the sidebar. Renders the hide button in the header when provided. */
  onHide?: () => void;
  /** Extra classes merged onto the sidebar root. */
  className?: string;
}

/**
 * Conversation sidebar: a "New chat" button over a scrollable list of
 * the caller's threads. Each row shows the thread title (or a
 * placeholder for an as-yet-untitled new thread) and a relative
 * last-activity hint, with a hover rename affordance (inline text field,
 * commit on Enter / blur, cancel on Escape) and a two-click delete latch
 * so a stray click can't drop a conversation. Pair with
 * {@link ThreadSidebarProps} from the `useMastraChat` driver, which owns
 * the data and selection.
 */
export const ThreadSidebar = ({
  threads,
  activeThreadId,
  isLoading = false,
  onSelect,
  onNew,
  onDelete,
  onRename,
  onHide,
  className,
}: ThreadSidebarProps) => {
  // Thread id armed for deletion (first trash click). A second click on
  // the same row confirms; clicking elsewhere / another row resets it.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // Thread id whose title is being edited inline, and the working draft
  // for that row's text field. Only ever one row edits at a time.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");

  const handleDeleteClick = (e: React.MouseEvent, threadId: string) => {
    e.stopPropagation();
    if (!onDelete) return;
    if (confirmDeleteId !== threadId) {
      setConfirmDeleteId(threadId);
      return;
    }
    setConfirmDeleteId(null);
    onDelete(threadId);
  };

  // Enter edit mode for a row, seeding the draft with its current title
  // (blank for an as-yet-untitled thread). Cancels any armed delete.
  const startEdit = (e: React.MouseEvent, thread: ThreadSummary) => {
    e.stopPropagation();
    setConfirmDeleteId(null);
    setEditingId(thread.id);
    setDraftTitle(thread.title?.trim() ?? "");
  };

  // Commit the draft, firing `onRename` only when it's non-empty and
  // actually changed, then leave edit mode. Called on Enter and on blur.
  const commitEdit = (threadId: string) => {
    const title = draftTitle.trim();
    setEditingId(null);
    if (!onRename || !title) return;
    const current = threads.find((t) => t.id === threadId)?.title?.trim() ?? "";
    if (title !== current) onRename(threadId, title);
  };

  return (
    <div
      className={cn(
        "flex h-full w-64 shrink-0 flex-col border-r border-border bg-muted/30",
        className,
      )}
    >
      {(onNew || onHide) && (
        <div className="flex items-center gap-2 p-2">
          {onNew && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onNew}
              className="flex-1 justify-start gap-2"
            >
              <MessageSquarePlusIcon className="size-4" />
              New chat
            </Button>
          )}
          {onHide && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={onHide}
                  aria-label="Hide conversations"
                  className={cn("size-8 shrink-0", !onNew && "ml-auto")}
                >
                  <PanelLeftIcon className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Hide conversations</TooltipContent>
            </Tooltip>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 [scrollbar-gutter:stable]">
        {isLoading && threads.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
            <Spinner className="size-3" />
            <span>Loading conversations...</span>
          </div>
        ) : threads.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            No conversations yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {threads.map((thread) => {
              const isActive = thread.id === activeThreadId;
              const isConfirming = confirmDeleteId === thread.id;
              const isEditing = editingId === thread.id;
              if (isEditing) {
                return (
                  <li key={thread.id}>
                    <div className="px-2 py-1">
                      <Input
                        // eslint-disable-next-line jsx-a11y/no-autofocus -- focus the field the user just opened
                        autoFocus
                        value={draftTitle}
                        maxLength={MASTRA_THREAD_TITLE_MAX}
                        aria-label="Conversation name"
                        onChange={(e) => setDraftTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            commitEdit(thread.id);
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setEditingId(null);
                          }
                        }}
                        onBlur={() => commitEdit(thread.id)}
                        className="h-8 text-sm"
                      />
                    </div>
                  </li>
                );
              }
              return (
                <li key={thread.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelect(thread.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect(thread.id);
                      }
                    }}
                    className={cn(
                      "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                      "hover:bg-accent hover:text-accent-foreground",
                      isActive && "bg-accent text-accent-foreground",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{threadTitle(thread)}</div>
                      {thread.updatedAt && (
                        <div className="truncate text-xs text-muted-foreground">
                          {relativeTime(thread.updatedAt)}
                        </div>
                      )}
                    </div>
                    {onRename && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={(e) => startEdit(e, thread)}
                            aria-label="Rename conversation"
                            className={cn(
                              "size-6 shrink-0",
                              "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                            )}
                          >
                            <PencilIcon className="size-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Rename conversation</TooltipContent>
                      </Tooltip>
                    )}
                    {onDelete && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant={isConfirming ? "destructive" : "ghost"}
                            size="icon"
                            onClick={(e) => handleDeleteClick(e, thread.id)}
                            onBlur={() =>
                              setConfirmDeleteId((id) => (id === thread.id ? null : id))
                            }
                            aria-label={
                              isConfirming
                                ? "Confirm delete conversation"
                                : "Delete conversation"
                            }
                            className={cn(
                              "size-6 shrink-0",
                              !isConfirming &&
                                "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                            )}
                          >
                            <Trash2Icon className="size-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {isConfirming
                            ? "Click again to delete this conversation"
                            : "Delete conversation"}
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};

/** Title for a thread row, falling back to a placeholder when unnamed. */
function threadTitle(thread: ThreadSummary): string {
  const title = thread.title?.trim();
  return title && title.length > 0 ? title : "New conversation";
}

/**
 * Render an ISO-8601 timestamp as a coarse "time ago" hint
 * (`just now`, `5m ago`, `3h ago`, `2d ago`, or a locale date for
 * anything older than a week). Invalid input renders nothing.
 */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}
