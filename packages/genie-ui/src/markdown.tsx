import { cn } from "@databricks/appkit-ui/react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";

// Renders markdown via `marked` + DOMPurify, matching the approach the Genie
// chat in @databricks/appkit-ui uses. We avoid react-markdown because some of
// its dependencies have ESM resolution issues in bundlers (rolldown/vite).

marked.setOptions({ breaks: true, gfm: true });

const MARKDOWN_STYLES = cn(
  "text-sm break-words",
  "[&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0",
  "[&_pre]:bg-background/50 [&_pre]:p-2 [&_pre]:rounded [&_pre]:text-xs [&_pre]:overflow-x-auto",
  "[&_code]:text-xs [&_code]:bg-background/50 [&_code]:px-1 [&_code]:rounded",
  "[&_table]:text-xs [&_table]:block [&_table]:overflow-x-auto [&_table]:max-w-full",
  "[&_th]:px-2 [&_th]:py-1 [&_td]:px-2 [&_td]:py-1",
  "[&_table]:border-collapse [&_th]:border [&_td]:border",
  "[&_th]:border-border [&_td]:border-border",
  "[&_a]:underline",
);

export interface MarkdownProps {
  children: string;
  className?: string;
}

export function Markdown({ children, className }: MarkdownProps) {
  const html = useMemo(
    () => (children ? DOMPurify.sanitize(marked.parse(children) as string) : ""),
    [children],
  );
  if (!html) return null;
  return (
    <div
      className={cn(MARKDOWN_STYLES, className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
