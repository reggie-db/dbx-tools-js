import { Button, cn } from "@databricks/appkit-ui/react";
import { useRef, useState } from "react";

// Auto-expanding textarea + send button. Submits on Enter (Shift+Enter for
// newline). Mirrors @databricks/appkit-ui's GenieChatInput so the embedded
// chat matches the Genie chat visually.

export interface AgentChatInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

const MAX_HEIGHT_PX = 200;

export function AgentChatInput({
  onSend,
  disabled = false,
  placeholder = "Ask a question...",
  className,
}: AgentChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleInput = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const clamped = Math.min(textarea.scrollHeight, MAX_HEIGHT_PX);
    textarea.style.height = `${clamped}px`;
    textarea.style.overflowY =
      textarea.scrollHeight > MAX_HEIGHT_PX ? "auto" : "hidden";
  };

  return (
    <div className={cn("flex gap-2 p-4 border-t shrink-0", className)}>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onInput={handleInput}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        className={cn(
          "flex-1 resize-none overflow-hidden rounded-md border border-input bg-background px-3 py-2",
          "text-sm placeholder:text-muted-foreground",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      />
      <Button
        onClick={handleSubmit}
        disabled={disabled || !value.trim()}
        size="default"
        className="self-end"
      >
        Send
      </Button>
    </div>
  );
}
