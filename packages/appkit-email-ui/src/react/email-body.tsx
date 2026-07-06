// Compact, muted Markdown renderer for an email body. Shared by the
// read-only approval preview and the compose view's live preview so both
// render the drafted Markdown identically (links, lists, emphasis, and
// tables rather than raw syntax).

import { cn } from "@databricks/appkit-ui/react";
import { Streamdown } from "streamdown";

/** Props for {@link EmailBody}. */
export interface EmailBodyProps {
  children: string;
  /** Extra classes merged onto the prose container. */
  className?: string;
}

/** Render an email body (Markdown) as compact, muted prose. */
export const EmailBody = ({ children, className }: EmailBodyProps) => (
  <Streamdown
    controls={false}
    className={cn(
      "prose prose-sm dark:prose-invert max-w-none break-words",
      "text-[11px] leading-snug text-muted-foreground",
      "[&_strong]:text-foreground [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_ul]:pl-4 [&_ol]:pl-4",
      className,
    )}
  >
    {children}
  </Streamdown>
);
