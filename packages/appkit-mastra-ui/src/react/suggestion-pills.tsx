import { Button, cn } from "@databricks/appkit-ui/react";

// Shared rendering for suggested questions. Both the initial starter
// suggestions (above the composer when the transcript is empty) and
// the per-message follow-up suggestions use this so the two look and
// behave identically.

export interface SuggestionPillsProps {
  /** Questions to render as clickable pills. Empty renders nothing. */
  questions: string[];
  /** Invoked with the question text when a pill is clicked. */
  onSelect?: (question: string) => void;
  /** Extra classes for the wrapping flex row (layout / spacing). */
  className?: string;
}

/**
 * Render a flex-wrapped row of suggestion pills. Pills grow vertically
 * for long questions (`h-auto` + `whitespace-normal`) and keep a
 * capsule shape that scales cleanly when text wraps to multiple lines.
 * Disabled when no `onSelect` is provided.
 */
export const SuggestionPills = ({
  questions,
  onSelect,
  className,
}: SuggestionPillsProps) => {
  if (questions.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {questions.map((q) => (
        <Button
          key={q}
          type="button"
          size="sm"
          variant="outline"
          className="h-auto max-w-full whitespace-normal rounded-2xl px-3 py-1.5 text-left text-xs font-normal leading-snug"
          onClick={() => onSelect?.(q)}
          disabled={!onSelect}
        >
          {q}
        </Button>
      ))}
    </div>
  );
};
