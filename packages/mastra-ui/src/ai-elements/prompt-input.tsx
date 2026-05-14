"use client";

import { ArrowUpIcon, SquareIcon } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useState,
  type ComponentProps,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { Button } from "../components/button.js";
import { cn } from "../lib/utils.js";

// Slimmed-down version of
// https://github.com/mastra-ai/ui-dojo/blob/main/src/components/ai-elements/prompt-input.tsx
// (Apache-2.0). The upstream component wires up file attachments, model
// selectors, and web-search toggles via Radix Select / Dropdown
// primitives; this fork keeps only the bits required for a text-only
// chat input, so we don't pull in the heavier Radix surface.

export type PromptInputProps = ComponentProps<"form">;

export const PromptInput = ({
  className,
  ...props
}: PromptInputProps) => (
  <form
    className={cn(
      "relative flex w-full flex-col gap-2 rounded-xl border bg-background p-2 shadow-sm focus-within:ring-2 focus-within:ring-ring",
      className,
    )}
    {...props}
  />
);

export type PromptInputTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  /** Submit the form when the user presses Enter (without Shift). */
  submitOnEnter?: boolean;
};

export const PromptInputTextarea = forwardRef<
  HTMLTextAreaElement,
  PromptInputTextareaProps
>(
  (
    { className, submitOnEnter = true, onKeyDown, ...props },
    ref,
  ) => {
    const handleKeyDown = useCallback(
      (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (
          submitOnEnter &&
          event.key === "Enter" &&
          !event.shiftKey &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }
        onKeyDown?.(event);
      },
      [onKeyDown, submitOnEnter],
    );
    return (
      <textarea
        ref={ref}
        rows={1}
        className={cn(
          "w-full resize-none bg-transparent px-2 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        onKeyDown={handleKeyDown}
        {...props}
      />
    );
  },
);
PromptInputTextarea.displayName = "PromptInputTextarea";

export type PromptInputToolbarProps = ComponentProps<"div">;

export const PromptInputToolbar = ({
  className,
  ...props
}: PromptInputToolbarProps) => (
  <div
    className={cn("flex items-center justify-between gap-2 px-1", className)}
    {...props}
  />
);

export type PromptInputSubmitProps = Omit<ComponentProps<typeof Button>, "children"> & {
  status?: "ready" | "submitted" | "streaming" | "error";
  children?: ReactNode;
};

export const PromptInputSubmit = ({
  status = "ready",
  className,
  children,
  ...props
}: PromptInputSubmitProps) => {
  const isStreaming = status === "submitted" || status === "streaming";
  return (
    <Button
      type="submit"
      size="icon"
      className={cn("size-9 rounded-full", className)}
      aria-label={isStreaming ? "Stop" : "Send"}
      {...props}
    >
      {children ??
        (isStreaming ? (
          <SquareIcon className="size-4" />
        ) : (
          <ArrowUpIcon className="size-4" />
        ))}
    </Button>
  );
};

/**
 * Headless helper that wraps `<PromptInput>` and exposes a single
 * `onSubmit(text)` callback. Keeps callers from re-implementing the
 * controlled textarea + clear-on-submit dance.
 */
export interface PromptInputControlProps {
  onSubmit: (text: string) => void;
  status?: "ready" | "submitted" | "streaming" | "error";
  placeholder?: string;
  disabled?: boolean;
  /** Stop the active stream when the submit button is clicked in
   *  streaming state. Bind to `useChat`'s `stop` callback. */
  onStop?: () => void;
}

export function PromptInputControl({
  onSubmit,
  onStop,
  status = "ready",
  placeholder = "Ask anything...",
  disabled,
}: PromptInputControlProps) {
  const [value, setValue] = useState("");
  const isStreaming = status === "submitted" || status === "streaming";

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isStreaming) {
      onStop?.();
      return;
    }
    const text = value.trim();
    if (!text) return;
    onSubmit(text);
    setValue("");
  };

  return (
    <PromptInput onSubmit={handleSubmit}>
      <PromptInputTextarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
      />
      <PromptInputToolbar>
        <div className="flex-1" />
        <PromptInputSubmit
          status={status}
          disabled={disabled || (!isStreaming && value.trim().length === 0)}
        />
      </PromptInputToolbar>
    </PromptInput>
  );
}
