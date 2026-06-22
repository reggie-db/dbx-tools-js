import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from "@databricks/appkit-ui/react";
import { CheckIcon, CopyIcon } from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { format as formatSql } from "sql-formatter";
import { Streamdown } from "streamdown";
import { createShikiPlugin, highlightToHtml } from "../lib/shiki-plugin.js";
import {
  DataGrid,
  TABLE_WRAPPER_CLASSES,
  colorizeDelta,
  type DataRow,
} from "./data-grid.js";

// Markdown rendering for the chat: the streaming `Streamdown` engine
// wired with shiki highlighting and AppKit table primitives, plus the
// standalone syntax-highlighted SQL block and a compact copy button.

/**
 * Minimal hast node shape we walk to lift a GFM markdown table out of
 * Streamdown's parsed tree (handed to component overrides as the
 * `node` prop). Only the fields the extractor reads are modeled; the
 * real node carries more.
 */
interface MarkdownNode {
  type?: string;
  tagName?: string;
  value?: string;
  children?: MarkdownNode[];
}

/** Concatenate all descendant text of a hast node (cell -> plain string). */
function markdownNodeText(node: MarkdownNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(markdownNodeText).join("");
}

/**
 * Lift a markdown `<table>` hast node into the column/row shape
 * {@link DataGrid} consumes. Header cells become column keys; blank or
 * duplicate headers are made unique (`Column N`, `Name (2)`) so each
 * key can double as both the row-record key and the tanstack column
 * id. Rich cell content (links, bold, code) is flattened to text - the
 * grid sorts and exports on plain values. Returns `null` for anything
 * that isn't a parseable table with at least one header cell.
 */
function markdownTableData(
  node: MarkdownNode | undefined,
): { columns: string[]; rows: DataRow[] } | null {
  if (!node || node.tagName !== "table") return null;
  const sections = node.children ?? [];
  const sectionRows = (tag: string): MarkdownNode[] =>
    sections
      .find((s) => s.tagName === tag)
      ?.children?.filter((r) => r.tagName === "tr") ?? [];

  const headerCells = (sectionRows("thead")[0]?.children ?? []).filter(
    (c) => c.tagName === "th" || c.tagName === "td",
  );
  if (headerCells.length === 0) return null;

  const columns: string[] = [];
  const seen = new Map<string, number>();
  for (const [i, cell] of headerCells.entries()) {
    let name = markdownNodeText(cell).trim() || `Column ${i + 1}`;
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count > 0) name = `${name} (${count + 1})`;
    columns.push(name);
  }

  const rows: DataRow[] = sectionRows("tbody").map((tr) => {
    const cells = (tr.children ?? []).filter(
      (c) => c.tagName === "td" || c.tagName === "th",
    );
    const row: DataRow = {};
    columns.forEach((col, i) => {
      const cell = cells[i];
      row[col] = cell ? markdownNodeText(cell).trim() : "";
    });
    return row;
  });

  return { columns, rows };
}

/**
 * Static AppKit-Table rendering of a markdown table - the fallback
 * when a table can't be lifted into a {@link DataGrid}, and the
 * renderer tool-detail copy uses unconditionally (a sort/column/export
 * toolbar would dwarf the tiny inline pills it renders in).
 */
const plainMarkdownTable = ({
  children,
  ...rest
}: React.HTMLAttributes<HTMLTableElement>) => (
  <div className={TABLE_WRAPPER_CLASSES}>
    <Table {...rest}>{children}</Table>
  </div>
);

/**
 * Cell/section overrides shared by every markdown table renderer: map
 * the GFM table parts onto AppKit's Table primitives so chat tables
 * match the rest of the app instead of inheriting
 * `@tailwindcss/typography`'s defaults. The `td` override also runs
 * each cell through `colorizeDelta` so signed numeric tokens (e.g.
 * `+1.8%`, `-3.1 pts`) render in green/red. These only take effect on
 * the {@link plainMarkdownTable} path; the {@link DataGrid} path builds
 * its own cells from the parsed data.
 */
const MARKDOWN_TABLE_PARTS = {
  thead: ({ children, ...rest }: React.HTMLAttributes<HTMLTableSectionElement>) => (
    <TableHeader {...rest}>{children}</TableHeader>
  ),
  tbody: ({ children, ...rest }: React.HTMLAttributes<HTMLTableSectionElement>) => (
    <TableBody {...rest}>{children}</TableBody>
  ),
  tfoot: ({ children, ...rest }: React.HTMLAttributes<HTMLTableSectionElement>) => (
    <TableFooter {...rest}>{children}</TableFooter>
  ),
  tr: ({ children, ...rest }: React.HTMLAttributes<HTMLTableRowElement>) => (
    <TableRow {...rest}>{children}</TableRow>
  ),
  th: ({ children, ...rest }: React.HTMLAttributes<HTMLTableCellElement>) => (
    <TableHead {...rest}>{children}</TableHead>
  ),
  td: ({ children, ...rest }: React.HTMLAttributes<HTMLTableCellElement>) => {
    const colored = Array.isArray(children)
      ? children.map((c, i) => (
          <React.Fragment key={i}>{colorizeDelta(c)}</React.Fragment>
        ))
      : colorizeDelta(children as React.ReactNode);
    return <TableCell {...rest}>{colored}</TableCell>;
  },
};

/**
 * Markdown component map for the main assistant reply. Tables are
 * lifted out of the parsed `node` and rendered through the interactive
 * {@link DataGrid} (sortable, column show/hide, CSV export) so they
 * behave exactly like statement-result tables; anything that doesn't
 * parse cleanly falls back to {@link plainMarkdownTable}.
 */
const MARKDOWN_COMPONENTS = {
  ...MARKDOWN_TABLE_PARTS,
  table: ({
    node,
    children,
    ...rest
  }: React.HTMLAttributes<HTMLTableElement> & { node?: MarkdownNode }) => {
    const parsed = markdownTableData(node);
    if (parsed && parsed.columns.length > 0) {
      return (
        <DataGrid
          columns={parsed.columns}
          rows={parsed.rows}
          truncated={false}
          rowCount={parsed.rows.length}
        />
      );
    }
    return plainMarkdownTable({ children, ...rest });
  },
};

/**
 * Markdown component map for tool-detail copy (Genie summaries, SQL
 * descriptions). Same cell/section overrides, but tables stay static
 * via {@link plainMarkdownTable} - these render inside tiny muted pills
 * where a full {@link DataGrid} toolbar would be oversized.
 */
const TOOL_MARKDOWN_COMPONENTS = {
  ...MARKDOWN_TABLE_PARTS,
  table: plainMarkdownTable,
};

/**
 * Shared shiki highlighter for every `Streamdown` instance in the chat.
 * Streamdown 2.x ships highlighting as an opt-in plugin (no built-in
 * shiki), so without this the SQL/code blocks render as uncolored
 * plaintext. One instance keeps a single lazily-loaded highlighter.
 */
const SHIKI_PLUGIN = { code: createShikiPlugin() };

/**
 * Per-word fade-in applied while a reply is still streaming. Streamdown
 * wraps each newly arrived token in a `[data-sd-animate]` span and only
 * animates the delta since the previous render (tokens already on
 * screen don't re-animate), so the text eases in instead of snapping
 * in whole SSE chunks. Kept short with an `ease-out` curve so the
 * reveal is quick and smooth. The keyframes ship in
 * `streamdown/styles.css`, imported by this package's `styles.css`.
 *
 * `stagger: 0` is load-bearing. Streamdown 2.5 defaults `stagger` to
 * 40ms, and stagger has NO inter-block coordination: each block's
 * delay counter restarts at 0, so a freshly-appeared paragraph starts
 * fading at delay 0 while the previous block's staggered tail words are
 * still queued at 40ms x N - making sibling sections visibly animate in
 * parallel ("new paragraphs reveal before the previous finishes").
 * Pinning `stagger: 0` makes each batch of newly-arrived words fade
 * together within `duration`, so blocks reveal in order with no overlap
 * window. See https://github.com/vercel/streamdown/issues/482.
 */
const ANIMATE_OPTIONS = {
  animation: "fadeIn",
  sep: "word",
  duration: 120,
  easing: "ease-out",
  stagger: 0,
} as const;

/**
 * Streamdown ships GFM (tables, task lists, strikethrough, autolink),
 * KaTeX math, Mermaid diagrams, copy/download controls on code +
 * tables, and incremental-parse handling for partial markdown chunks -
 * all out of the box. Syntax highlighting is provided via the
 * {@link SHIKI_PLUGIN} `code` plugin. We layer on the project's heading
 * rhythm and route tables through AppKit's Table primitives via
 * {@link MARKDOWN_COMPONENTS}, then disable the noisy in-block copy/
 * download buttons since this UI lives inside a chat bubble that
 * already has its own copy button. `animate` opts the block into the
 * {@link ANIMATE_OPTIONS} word-by-word fade-in (and drives
 * `isAnimating` for the streaming caret); callers pass it only for the
 * actively streaming bubble so settled history renders plain.
 */
export const AssistantMarkdown = ({
  children,
  animate = false,
}: {
  children: string;
  animate?: boolean;
}) => (
  <Streamdown
    components={MARKDOWN_COMPONENTS}
    plugins={SHIKI_PLUGIN}
    controls={false}
    animated={animate ? ANIMATE_OPTIONS : false}
    isAnimating={animate}
    className={cn(
      "prose prose-sm dark:prose-invert max-w-none break-words",
      "prose-headings:font-semibold prose-headings:tracking-tight",
      "prose-h1:text-lg prose-h1:mt-4 prose-h1:mb-2",
      "prose-h2:text-base prose-h2:mt-4 prose-h2:mb-2",
      "prose-h3:text-sm prose-h3:mt-3 prose-h3:mb-1.5 prose-h3:text-muted-foreground prose-h3:uppercase prose-h3:tracking-wider",
    )}
  >
    {children}
  </Streamdown>
);

/**
 * Tighter, muted markdown variant for inline tool detail copy: Genie
 * attachment text (the natural-language summary that arrives below
 * the SQL) and SQL descriptions. Same `Streamdown` engine as
 * {@link AssistantMarkdown} so we keep GFM, shiki, and table primitive
 * mapping, but everything is squeezed: smaller font, tighter leading,
 * and near-zero block margins so a few short lines don't take more
 * vertical space than the SQL block above them. Lists get a shallow
 * indent (`pl-4`) because the default `prose-sm` indent is sized for
 * chat-bubble copy and looks oversized inside a sub-pill. Strong
 * (bold) gets the foreground color so KPI names still pop against
 * the muted body.
 */
export const ToolMarkdown = ({ children }: { children: string }) => (
  <Streamdown
    components={TOOL_MARKDOWN_COMPONENTS}
    plugins={SHIKI_PLUGIN}
    controls={false}
    className={cn(
      "prose prose-sm dark:prose-invert max-w-none break-words",
      "text-[11px] leading-snug text-muted-foreground",
      "prose-p:my-0.5 prose-p:leading-snug",
      "prose-ul:my-0.5 prose-ul:pl-4 prose-ol:my-0.5 prose-ol:pl-4",
      "prose-li:my-0 prose-li:leading-snug prose-li:marker:text-muted-foreground/60",
      "prose-headings:my-1 prose-headings:text-xs prose-headings:font-semibold",
      "prose-strong:text-foreground/90 prose-strong:font-medium",
      "prose-code:text-[10px] prose-code:font-medium",
    )}
  >
    {children}
  </Streamdown>
);

/**
 * Pretty-print a Genie SQL string for display. Genie often emits the
 * query as one long line; `sql-formatter`'s Spark dialect (the closest
 * fit to Databricks SQL) re-indents it with uppercased keywords. The
 * formatter throws on syntax it can't parse (e.g. Databricks-specific
 * constructs or a partial query), so we fall back to the raw string
 * rather than dropping the preview.
 */
function prettySql(sql: string): string {
  try {
    return formatSql(sql, { language: "spark", keywordCase: "upper" });
  } catch {
    return sql;
  }
}

/**
 * Copy-to-clipboard button with a transient confirmation state: the
 * icon flips to a check for ~1.5s after a successful copy. Shared by
 * the SQL preview (and available to any block that needs a compact
 * copy affordance).
 */
const CopyButton = ({ value, className }: { value: string; className?: string }) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => clearTimeout(timer.current ?? undefined), []);
  const onCopy = () => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      clearTimeout(timer.current ?? undefined);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className={cn("size-6", className)}
          onClick={onCopy}
        >
          {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : "Copy"}</TooltipContent>
    </Tooltip>
  );
};

/**
 * Render a SQL string as a syntax-highlighted code block. The query is
 * first run through {@link prettySql} so one-line Genie output reads as
 * formatted SQL, then highlighted to minimal inline HTML via
 * {@link highlightToHtml} (shiki). Unlike Streamdown's code renderer,
 * this emits a plain `<pre><code>` with only per-token color spans - no
 * line-number gutter or per-line wrappers - so the SQL selects and
 * copies cleanly. A {@link CopyButton} copies the formatted source. The
 * highlighter loads asynchronously, so we render uncolored text until
 * the tokens are ready to avoid a flash of empty space.
 */
export const SqlBlock = ({ sql }: { sql: string }) => {
  const formatted = useMemo(() => prettySql(sql), [sql]);
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setHtml(null);
    void highlightToHtml(formatted, "sql").then((result) => {
      if (active) setHtml(result);
    });
    return () => {
      active = false;
    };
  }, [formatted]);
  return (
    <div className="group relative">
      <CopyButton
        value={formatted}
        className="absolute right-1.5 top-1.5 z-10 bg-background/70 opacity-0 backdrop-blur transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      />
      <pre className="max-w-full overflow-x-auto rounded-md border border-border bg-background p-3 font-mono text-[11px] leading-relaxed">
        {html === null ? (
          <code>{formatted}</code>
        ) : (
          <code dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </pre>
    </div>
  );
};
