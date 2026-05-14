"use client";

import type { ComponentProps } from "react";
import { Button } from "../components/button.js";
import { cn } from "../lib/utils.js";

// Vendored from https://github.com/mastra-ai/ui-dojo/blob/main/src/components/ai-elements/suggestion.tsx
// (Apache-2.0), dropped the ScrollArea wrapper to avoid the Radix
// ScrollArea dep. A horizontally-scrolling flex row is enough.

export type SuggestionsProps = ComponentProps<"div">;

export const Suggestions = ({ className, children, ...props }: SuggestionsProps) => (
  <div
    className={cn(
      "flex w-full flex-nowrap items-center gap-2 overflow-x-auto whitespace-nowrap pb-2",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export type SuggestionProps = Omit<ComponentProps<typeof Button>, "onClick"> & {
  suggestion: string;
  onClick?: (suggestion: string) => void;
};

export const Suggestion = ({
  suggestion,
  onClick,
  className,
  variant = "outline",
  size = "sm",
  children,
  ...props
}: SuggestionProps) => {
  const handleClick = () => onClick?.(suggestion);
  return (
    <Button
      className={cn("cursor-pointer rounded-full px-4", className)}
      onClick={handleClick}
      size={size}
      type="button"
      variant={variant}
      {...props}
    >
      {children || suggestion}
    </Button>
  );
};
