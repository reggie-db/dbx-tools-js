import {
  Button,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from "@databricks/appkit-ui/react";
import { MessageSquareTextIcon, ThumbsDownIcon, ThumbsUpIcon } from "lucide-react";
import { useState } from "react";
import type { FeedbackSubmission, FeedbackValue } from "./types.js";

// Per-message feedback action row: thumbs up/down that log immediately,
// plus a separate comment affordance that opens a popover for freeform
// text. Rendered inside the assistant bubble's action row when the host
// wires feedback (which only happens when MLflow logging is enabled and
// the turn has a captured trace id).

export const FeedbackControls = ({
  value,
  onSubmit,
}: {
  /** Last thumbs the user chose, so the active button stays highlighted. */
  value?: FeedbackValue;
  onSubmit: (submission: FeedbackSubmission) => void | Promise<void>;
}) => {
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);

  const submitComment = async () => {
    const text = comment.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await onSubmit({ comment: text });
      setComment("");
      setOpen(false);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className={cn("size-7", value === "up" && "text-success")}
            aria-label="Good response"
            aria-pressed={value === "up"}
            onClick={() => void onSubmit({ value: "up" })}
          >
            <ThumbsUpIcon className="size-3" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Good response</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className={cn("size-7", value === "down" && "text-destructive")}
            aria-label="Bad response"
            aria-pressed={value === "down"}
            onClick={() => void onSubmit({ value: "down" })}
          >
            <ThumbsDownIcon className="size-3" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Bad response</TooltipContent>
      </Tooltip>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-7"
                aria-label="Leave a comment"
              >
                <MessageSquareTextIcon className="size-3" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>Leave a comment</TooltipContent>
        </Tooltip>
        <PopoverContent align="start" className="w-80">
          <div className="grid gap-2">
            <Label className="text-xs">Share feedback</Label>
            <Textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => {
                // Cmd/Ctrl+Enter submits, matching the composer's feel.
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void submitComment();
                }
              }}
              placeholder="What worked well, or what could be better?"
              rows={3}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!comment.trim() || sending}
                onClick={() => void submitComment()}
              >
                {sending ? "Sending..." : "Send"}
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
};
