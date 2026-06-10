import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from "@databricks/appkit-ui/react";
import { stringUtils } from "@dbx-tools/shared";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronsUpDownIcon,
  Columns3Icon,
  DownloadIcon,
} from "lucide-react";
import React, { useMemo, useState } from "react";

// Interactive result table plus the cell/label/CSV helpers it and the
// markdown table renderer share. Built on `@tanstack/react-table` over
// AppKit's `Table` primitives so every table in the chat - statement
// results and lifted markdown tables alike - reads as the same block.

/** A statement row: column name -> cell value, as `StatementData.rows` arrives. */
export type DataRow = Record<string, unknown>;

/**
 * Color-code numeric deltas like `+1.8%`, `-3.1%`, or `+0.6 pts` inside
 * a single table cell. Matches the *first* signed numeric token in the
 * cell; if no match, returns the children unchanged.
 *
 * Patterns recognized (case insensitive, allow comma/decimal):
 *   +1.8%   -3.1%   +0.6 pts   -0.9 pts
 */
const DELTA_PATTERN = /^([+\u2212-])\s*\d[\d,.\s]*(?:%|\s*pts?)?$/i;

export function colorizeDelta(content: React.ReactNode): React.ReactNode {
  if (typeof content !== "string") return content;
  const text = content.trim();
  const match = DELTA_PATTERN.exec(text);
  if (!match) return content;
  const sign = match[1];
  if (sign === "+") return <span className="font-medium text-success">{content}</span>;
  if (sign === "-" || sign === "\u2212")
    return <span className="font-medium text-destructive">{content}</span>;
  return content;
}

/**
 * Render a cell value: blank for nullish, otherwise the string form
 * run through {@link colorizeDelta} so signed deltas keep their
 * green/red treatment.
 */
export function renderDataCell(value: unknown): React.ReactNode {
  return colorizeDelta(value == null ? "" : String(value));
}

/**
 * Turn a raw statement column name into a human-readable header by
 * tokenizing it (camelCase / snake_case / kebab / etc. all split) and
 * Title-Casing each token: `total_revenue` -> "Total Revenue",
 * `aiScore` -> "AI Score" (the tokenizer special-cases `ai`). Falls
 * back to the original string when tokenization yields nothing (e.g. a
 * punctuation-only column name). The raw name is still used as the
 * column id, accessor key, and CSV header, so only the on-screen label
 * is prettified.
 */
export function humanizeLabel(
  value: string,
  options?: stringUtils.TokenizeOptions,
): string {
  const tokens = [
    ...stringUtils.tokenizeWithOptions(
      { lowerCase: true, capitalize: true, ...options },
      value,
    ),
  ];
  return tokens.length > 0 ? tokens.join(" ") : value;
}

/**
 * Serialize already-ordered `rows` to a CSV over `columns` and trigger
 * a browser download. Fields are quoted only when they contain a
 * comma, double-quote, or newline (RFC-4180 minimal quoting); embedded
 * quotes are doubled. The blob URL is revoked right after the click so
 * we don't leak object URLs across repeated exports.
 */
function downloadCsv(columns: string[], rows: DataRow[], filename: string): void {
  const escape = (value: unknown): string => {
    const s = value == null ? "" : String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [
    columns.map(escape).join(","),
    ...rows.map((row) => columns.map((c) => escape(row[c])).join(",")),
  ].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Wrapper class layered on every chat table (markdown + statement
 * results). It frames the table as a distinct card so it reads as a
 * separate block in the conversation. AppKit's `Table` family already
 * owns row borders, hover, and color tokens - on top of that we add:
 *   - `not-prose` to escape `@tailwindcss/typography`'s table styles
 *     (margins, font-weight, etc.) which fight the AppKit defaults
 *   - a `rounded-lg` border + `bg-card` + `shadow-sm` card frame with
 *     `overflow-hidden` so the rounded corners clip the scroll area
 *   - compact `text-xs` + `tabular-nums` so columns of numbers align
 *   - right-alignment for every column except the first label column
 *   - a `max-h-[60vh]` vertical cap so tall tables scroll their body
 *     instead of running off the viewport, plus `overflow-auto` so wide
 *     tables scroll horizontally *inside* the card rather than pushing
 *     the chat past its max width. AppKit's `Table` nests the `<table>`
 *     in its own scroll container (`<div>` - the wrapper's only child),
 *     so the cap + overflow land there, making it the scroll ancestor
 *     the sticky header pins to.
 *   - a prominent, sticky header: tinted (`bg-muted`), bold, opaque
 *     (so rows don't bleed through while scrolling), and divided from
 *     the body with a bottom border.
 */
export const TABLE_WRAPPER_CLASSES = cn(
  // Card-like frame so each table reads as a distinct block in the
  // chat rather than bleeding into the surrounding prose.
  "not-prose my-4 max-w-full overflow-hidden rounded-lg border border-border bg-card shadow-sm",
  "text-xs tabular-nums",
  "[&_th:not(:first-child)]:text-right [&_td:not(:first-child)]:text-right",
  // The inner AppKit scroll container is the scroll surface for both
  // axes; cap its height so tall tables scroll their body in place.
  "[&>div]:max-h-[60vh] [&>div]:overflow-auto",
  // Make the header read as a header: opaque, tinted, bold, and pinned
  // to the top of the scroll container with a divider beneath it.
  "[&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-10",
  "[&_thead_th]:bg-muted [&_thead_th]:font-semibold [&_thead_th]:text-foreground",
  "[&_thead_th]:border-b [&_thead_th]:border-border",
);

/**
 * Card frame for {@link DataGrid} - the same rounded/bordered/elevated
 * treatment as {@link TABLE_WRAPPER_CLASSES} so interactive statement
 * tables and static markdown tables read as the same kind of block.
 */
const DATA_GRID_CARD_CLASSES = cn(
  "not-prose my-4 max-w-full overflow-hidden rounded-lg border border-border bg-card shadow-sm",
  "text-xs tabular-nums",
);

/** Toolbar strip across the top of a {@link DataGrid} card. */
const DATA_GRID_TOOLBAR_CLASSES = cn(
  "flex items-center justify-between gap-2",
  "border-b border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground",
);

/**
 * Scroll surface wrapping the {@link DataGrid} table. AppKit's `Table`
 * nests its `<table>` inside its own scroll container `<div>` (this
 * wrapper's only child), so the height cap + `overflow` must land on
 * THAT div (`[&>div]`) - not this wrapper - to make it the single
 * scroll box. Otherwise the inner container becomes a nested scroll
 * box the sticky header pins to, and the header rides up with the body
 * as the outer wrapper scrolls. With the cap on the inner div the
 * sticky header pins to it and stays put. Header cells are tinted,
 * bold, and opaque so rows don't bleed through while scrolling.
 */
const DATA_GRID_SCROLL_CLASSES = cn(
  "[&>div]:max-h-[60vh] [&>div]:overflow-auto",
  "[&_th:not(:first-child)]:text-right [&_td:not(:first-child)]:text-right",
  "[&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-10",
  "[&_thead_th]:bg-muted [&_thead_th]:font-semibold [&_thead_th]:text-foreground",
  "[&_thead_th]:border-b [&_thead_th]:border-border",
);

/**
 * Interactive table for a settled statement result, built on
 * `@tanstack/react-table` over AppKit's `Table` primitives so it
 * matches the rest of the chat. A toolbar in the card header carries
 * the row count, a column show/hide menu, and a CSV export of the
 * visible columns in the current sort order. Header cells are sort
 * toggles (click to cycle asc -> desc -> none): the active column
 * shows a direction arrow, idle columns a faded up/down glyph. All
 * state is client-side - the rows arrive once from {@link DataSlot}.
 */
export const DataGrid = ({
  columns,
  rows,
  truncated,
  rowCount,
  humanizeHeaders = false,
}: {
  columns: string[];
  rows: DataRow[];
  truncated: boolean;
  rowCount: number;
  /**
   * Title-Case raw identifier column names for display (statement
   * results). Off for markdown tables, whose headers are already
   * human-authored and would be mangled by the tokenizer.
   */
  humanizeHeaders?: boolean;
}) => {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});

  const columnDefs = useMemo<ColumnDef<DataRow>[]>(
    () =>
      columns.map(
        (col): ColumnDef<DataRow> => ({
          id: col,
          accessorFn: (row) => row[col],
          header: humanizeHeaders ? humanizeLabel(col) : col,
          cell: (info) => renderDataCell(info.getValue()),
          sortUndefined: "last",
        }),
      ),
    [columns, humanizeHeaders],
  );

  const table = useReactTable({
    data: rows,
    columns: columnDefs,
    state: { sorting, columnVisibility },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const exportCsv = () =>
    downloadCsv(
      table.getVisibleLeafColumns().map((c) => c.id),
      table.getSortedRowModel().rows.map((r) => r.original),
      "statement.csv",
    );

  return (
    <div className={DATA_GRID_CARD_CLASSES}>
      <div className={DATA_GRID_TOOLBAR_CLASSES}>
        <span>
          {truncated
            ? `Showing ${rows.length} of ${rowCount} rows`
            : `${rows.length} ${rows.length === 1 ? "row" : "rows"}`}
        </span>
        <div className="flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs">
                <Columns3Icon className="size-3.5" />
                Columns
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
              {table.getAllLeafColumns().map((column) => (
                <DropdownMenuCheckboxItem
                  key={column.id}
                  className="text-xs"
                  checked={column.getIsVisible()}
                  // Keep the menu open while toggling several columns.
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={(value) => column.toggleVisibility(!!value)}
                >
                  {String(column.columnDef.header)}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={exportCsv}
          >
            <DownloadIcon className="size-3.5" />
            Export
          </Button>
        </div>
      </div>
      <div className={DATA_GRID_SCROLL_CLASSES}>
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  return (
                    <TableHead key={header.id}>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 hover:text-foreground"
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                        {sorted === "asc" ? (
                          <ArrowUpIcon className="size-3" />
                        ) : sorted === "desc" ? (
                          <ArrowDownIcon className="size-3" />
                        ) : (
                          <ChevronsUpDownIcon className="size-3 opacity-40" />
                        )}
                      </button>
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
};
