import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { Streamdown } from "streamdown";
import {
  ArrowDownIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  MessageSquareIcon,
  RefreshCcwIcon,
  SendIcon,
  SparklesIcon,
  UserIcon,
  XIcon,
} from "lucide-react";
import {
  Avatar,
  AvatarFallback,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
  Item,
  ItemContent,
  ItemMedia,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@databricks/appkit-ui/react";
import ReactECharts from "echarts-for-react";

const DEFAULT_SUGGESTIONS = [
  "Tell me about Spirited Away",
  "Who are the main characters in Princess Mononoke?",
  "Summarize the plot of Howl's Moving Castle",
];

const BOTTOM_THRESHOLD_PX = 24;
/**
 * Distance from the top of the scroll container at which we trigger
 * `onLoadMore`. Sized to give the lazy fetch a head-start before the
 * user actually hits the top so the reveal feels seamless.
 */
const TOP_LOAD_MORE_THRESHOLD_PX = 120;

export type ChatStatus = "submitted" | "streaming" | "ready" | "error";

/**
 * Lifecycle of a single tool invocation surfaced inline in the assistant
 * bubble. `running` while we wait for the backend, `done` on `tool-result`,
 * `error` on `tool-error`. `progress` is an in-order log of mid-flight
 * events the tool itself pushed through Mastra's `ctx.writer`.
 */
export type ToolEvent = {
  id: string;
  toolName: string;
  status: "running" | "done" | "error";
  progress?: ToolProgress[];
};

/**
 * Normalised progress event shape; mirrors `GenieProgress` in the Mastra
 * Genie tool wrapper. Open union so new tools can publish new kinds
 * without breaking existing renders.
 */
export type ToolProgress =
  | { kind: "started"; conversationId: string; messageId: string; spaceId: string }
  | { kind: "status"; status: string; label: string }
  | { kind: "sql"; sql: string; title?: string; description?: string; statementId?: string }
  /**
   * Chart event emitted by `render_data` and Genie's
   * `drainGenieStream`. The producer fires two events per
   * `chartId`: the first carries `data` (the raw rows), the
   * second - on chart-planner success - carries `option` (the
   * Echarts spec). The client merges them by `chartId`. All
   * fields except `chartId` are optional so each event can
   * populate just what it knows.
   */
  | {
      kind: "chart";
      chartId: string;
      title?: string;
      description?: string;
      data?: Array<Record<string, unknown>>;
      option?: Record<string, unknown>;
    }
  | { kind: "text"; content: string }
  | { kind: "suggested"; questions: string[] }
  | { kind: "error"; error: string };

/** Subset of a Model Serving endpoint surfaced in the model picker. */
export type ChatModelOption = { name: string };

export type ChatViewProps = {
  messages: UIMessage[];
  status: ChatStatus;
  sendMessage: (message: { text: string }) => void;
  regenerate?: () => void;
  suggestions?: string[];
  toolEventsByMessage?: Record<string, ToolEvent[]>;
  /** Available model endpoints. Pass an empty array (or omit) to hide the picker. */
  models?: ChatModelOption[];
  /** Currently selected model name; empty string means "use server default". */
  model?: string;
  onModelChange?: (model: string) => void;
  /**
   * Optional infinite-scroll-up handler. Fired when the user scrolls
   * within {@link TOP_LOAD_MORE_THRESHOLD_PX} of the top of the
   * transcript. The parent is expected to fetch the next older page
   * and prepend it to `messages`; the view preserves the visual
   * scroll position across the prepend so the reveal feels like
   * paging up through history rather than a layout jump.
   */
  onLoadMore?: () => void;
  /** True while a {@link onLoadMore} fetch is in flight. */
  isLoadingMore?: boolean;
  /** True when more history is still available (drives the trigger). */
  hasMore?: boolean;
  /** True while the *initial* history page is loading. */
  isLoadingHistory?: boolean;
  /**
   * Resolve an approval-gated tool call. Fired when the user clicks
   * Approve or Deny on the inline approval card. The handler must
   * resume the suspended Mastra workflow on its own:
   *
   * - With `useChat` + `chatRoute()`, call
   *   `sendMessage(undefined, { body: { resumeData: { approved }, runId } })`
   *   so chatRoute hits `agent.resumeStream(resumeData)` and the
   *   suspended tool call wakes up.
   * - With `mastraClient.getAgent(...).stream()`, call
   *   `agent.approveToolCall({ runId, toolCallId })` /
   *   `agent.declineToolCall({ runId, toolCallId })` to get a fresh
   *   stream Response and pipe it through the same chunk handler.
   *
   * Both paths require the `runId` Mastra emitted with the approval
   * chunk - the field is always populated when the card was rendered
   * from a live `data-tool-call-approval` part or an out-of-band
   * `pendingApprovalsByMessage` entry. It will be missing only for
   * approvals reconstructed from history (where the original runId
   * is lost), in which case the handler should surface a "this
   * approval is stale, please re-ask the model" message rather than
   * trying to resume a workflow that no longer exists.
   */
  onResolveToolApproval?: (
    args: ApprovalDecision,
  ) => void | Promise<void>;
  /**
   * Out-of-band approval requests keyed by assistant message id, for
   * transports that don't surface approvals as `UIMessage` parts.
   * The `/stream` page populates this from Mastra's
   * `tool-call-approval` chunk so the same {@link ToolApprovalCard}
   * UI works without injecting synthetic data parts. Each entry is
   * merged with any approvals already discovered in `message.parts`.
   */
  pendingApprovalsByMessage?: Record<string, PendingApproval[]>;
};

/** Payload {@link ChatViewProps.onResolveToolApproval} receives. */
export type ApprovalDecision =
  | {
      approved: true;
      toolName: string;
      toolCallId: string;
      /**
       * Mastra run id from the approval chunk. Required to resume
       * the suspended workflow; absent only when the card was
       * reconstructed from history (no live runId available).
       */
      runId?: string;
      input: unknown;
    }
  | {
      approved: false;
      toolName: string;
      toolCallId: string;
      runId?: string;
      input: unknown;
      reason: string;
    };

/**
 * Strip noisy provider prefixes (e.g. `genie_default_`) and turn
 * snake/camel into a Title Cased label the user can read.
 *
 * Examples:
 *   `genie_default_query`   -> `Query`
 *   `genie`                 -> `Genie`
 *   `myCoolTool`            -> `My Cool Tool`
 */
const humanizeToolName = (toolName: string): string =>
  toolName
    .replace(/^[a-z0-9]+_(?:default|primary)_/i, "")
    .replace(/[._]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");

/**
 * Capitalize the first character of a label without touching the rest
 * (preserves `EXECUTING_QUERY`-style backend status labels).
 */
const capitalizeFirst = (s: string): string =>
  s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Track the freshest status label a running tool has published so the
 * inline pill follows the backend (FETCHING_METADATA -> EXECUTING_QUERY)
 * instead of stalling on a generic "Calling X".
 */
const runningLabelFor = (event: ToolEvent): string => {
  const latest = [...(event.progress ?? [])]
    .reverse()
    .find((p): p is Extract<ToolProgress, { kind: "status" }> => p.kind === "status");
  return latest ? capitalizeFirst(latest.label) : `Calling ${humanizeToolName(event.toolName)}`;
};

const getReasoningText = (parts: UIMessage["parts"]): string =>
  parts
    .filter((p): p is { type: "reasoning"; text: string } => p.type === "reasoning")
    .map((p) => p.text)
    .join("\n\n");

/**
 * Shape of the detail rows we extract from a single tool's progress
 * stream. Pulled out so the pill header can show a one-line summary
 * (e.g. `2 queries`) without expanding the collapsible. Charts and
 * suggested follow-up questions are intentionally excluded - both
 * live at message scope (charts via {@link collectCharts}, suggestions
 * via {@link collectSuggestions}).
 */
type ToolDetailSummary = {
  sql: Extract<ToolProgress, { kind: "sql" }>[];
  text: Extract<ToolProgress, { kind: "text" }>[];
  errors: Extract<ToolProgress, { kind: "error" }>[];
};

const summarizeProgress = (progress: ToolProgress[]): ToolDetailSummary => {
  const summary: ToolDetailSummary = { sql: [], text: [], errors: [] };
  for (const p of progress) {
    switch (p.kind) {
      case "sql":
        summary.sql.push(p);
        break;
      case "text":
        summary.text.push(p);
        break;
      case "error":
        summary.errors.push(p);
        break;
      default:
        break;
    }
  }
  return summary;
};

/**
 * Build the one-line collapsed summary shown next to the pill header.
 * Examples:
 *   `1 query`
 *   `2 queries · error`
 *   `error`
 * Returns null when there's nothing worth surfacing inline.
 */
const headlineFor = (s: ToolDetailSummary): string | null => {
  const parts: string[] = [];
  if (s.sql.length === 1) parts.push("1 query");
  else if (s.sql.length > 1) parts.push(`${s.sql.length} queries`);
  if (s.errors.length > 0) parts.push("error");
  return parts.length === 0 ? null : parts.join(" · ");
};

/**
 * Expanded detail view for a tool call. Rendered inside a Collapsible
 * owned by `ToolEventPill`; the SQL block keeps its own nested
 * collapsible so the (often long) statement only renders when the
 * user opts in. Charts produced by `render_data` render at message
 * scope (alongside suggested questions), not inside the pill.
 */
const ToolProgressDetails = ({ summary }: { summary: ToolDetailSummary }) => {
  if (
    summary.sql.length === 0 &&
    summary.text.length === 0 &&
    summary.errors.length === 0
  ) {
    return null;
  }
  return (
    <div className="mt-2 flex flex-col gap-2">
      {summary.sql.map((p, i) => (
        <Collapsible
          key={`sql-${i}`}
          className="rounded border border-border/60 bg-background/40 text-xs"
        >
          <CollapsibleTrigger className="flex w-full items-center gap-1 px-2 py-1 text-left text-muted-foreground hover:text-foreground">
            <ChevronDownIcon className="size-3" />
            <span>SQL{p.title ? `: ${p.title}` : ""}</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="px-2 pb-2">
              <SqlBlock sql={p.sql} />
            </div>
            {p.description && (
              <div className="px-2 pb-2">
                <ToolMarkdown>{p.description}</ToolMarkdown>
              </div>
            )}
          </CollapsibleContent>
        </Collapsible>
      ))}
      {summary.text.map((p, i) => (
        <ToolMarkdown key={`text-${i}`}>{p.content}</ToolMarkdown>
      ))}
      {summary.errors.map((p, i) => (
        <p key={`err-${i}`} className="text-xs text-destructive">
          {p.error}
        </p>
      ))}
    </div>
  );
};

const ToolEventPill = ({ event }: { event: ToolEvent }) => {
  const isRunning = event.status === "running";
  const isError = event.status === "error";
  const summary = summarizeProgress(event.progress ?? []);
  const headline = headlineFor(summary);
  const hasDetails =
    summary.sql.length > 0 ||
    summary.text.length > 0 ||
    summary.errors.length > 0;

  // Header label: "Calling Genie" / "Called Genie" / "Failed Genie".
  // Running tools defer to the latest backend status label.
  const verb = isRunning
    ? runningLabelFor(event)
    : `${isError ? "Failed" : "Called"} ${humanizeToolName(event.toolName)}`;

  return (
    <div className="rounded-md border border-border/40 bg-background/30 px-2 py-1.5">
      <Collapsible>
        <CollapsibleTrigger
          // Disable the toggle entirely when there's nothing to expand
          // so the pill doesn't pretend to be interactive.
          disabled={!hasDetails}
          className={cn(
            "group flex w-full items-center gap-2 text-left text-xs text-muted-foreground",
            hasDetails && "cursor-pointer hover:text-foreground",
          )}
        >
          {/*
           * Lead with the rotating chevron when the row is expandable
           * so the affordance is unambiguous; without this users read
           * the check/X as a completed-status badge and miss that the
           * row has more detail. Falls back to a fixed-width spacer so
           * non-expandable rows still align with their neighbors.
           */}
          {hasDetails ? (
            <ChevronDownIcon className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
          ) : (
            <span className="size-3 shrink-0" aria-hidden />
          )}
          {isRunning ? (
            <Spinner className="size-3" />
          ) : isError ? (
            <XIcon className="size-3 text-destructive" />
          ) : (
            <CheckIcon className="size-3" />
          )}
          <span className={cn(isRunning && "animate-pulse")}>{verb}</span>
          {headline && (
            <span className="truncate text-muted-foreground/70">
              · {headline}
            </span>
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ToolProgressDetails summary={summary} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
};

const ToolEventList = ({ events }: { events: ToolEvent[] }) => (
  <div className="mb-2 flex flex-col gap-2">
    {events.map((event) => (
      <ToolEventPill key={event.id} event={event} />
    ))}
  </div>
);

/**
 * Flatten and de-duplicate the suggested follow-up questions emitted
 * across all tool events on an assistant message. Within each event,
 * the **last** `suggested` progress entry wins (Genie tends to publish
 * an evolving list and the final one is the refined version). Across
 * events we union and dedupe while preserving first-seen order so
 * earlier tools' suggestions still surface.
 */
/**
 * Merged chart record after walking every tool's progress. Each
 * `chartId` typically gets two writer events from the producer: a
 * dataset event with `data` and a spec event with `option`; this
 * record carries whichever fields have arrived so far.
 *
 * `sourceToolDone` flips true when the tool that emitted the
 * dataset event has reached `done` / `error` status; the chart
 * slot uses it to distinguish "still streaming, wait for the
 * option" from "tool finished without an option" (planner
 * failed - render the dataset-only fallback).
 */
type MergedChart = Extract<ToolProgress, { kind: "chart" }> & {
  sourceToolDone: boolean;
};

/**
 * Flatten `chart` events emitted across every tool on this
 * assistant turn so they render at message scope (next to the
 * markdown answer and the suggested-question buttons) instead of
 * being buried inside a tool pill. Two events per `chartId`
 * (dataset, then option) are merged into one record; later
 * events shallow-overwrite earlier ones so the option lands on
 * top of the data. Order is first-seen by `chartId` so charts
 * appear in the order the model requested them.
 */
const collectCharts = (events: ToolEvent[] | undefined): MergedChart[] => {
  if (!events || events.length === 0) return [];
  const order: string[] = [];
  const byId = new Map<string, MergedChart>();
  for (const event of events) {
    const toolDone = event.status !== "running";
    for (const p of event.progress ?? []) {
      if (p.kind !== "chart") continue;
      const existing = byId.get(p.chartId);
      if (!existing) {
        order.push(p.chartId);
        byId.set(p.chartId, { ...p, sourceToolDone: toolDone });
      } else {
        // Merge each arriving field; keep `chartId` stable.
        // `sourceToolDone` is monotonic - once any contributing
        // event's tool is done we treat the chart as finalized.
        byId.set(p.chartId, {
          ...existing,
          ...p,
          sourceToolDone: existing.sourceToolDone || toolDone,
        });
      }
    }
  }
  return order
    .map((id) => byId.get(id))
    .filter((c): c is MergedChart => c !== undefined);
};

const collectSuggestions = (events: ToolEvent[] | undefined): string[] => {
  if (!events || events.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const event of events) {
    const last = [...(event.progress ?? [])]
      .reverse()
      .find(
        (p): p is Extract<ToolProgress, { kind: "suggested" }> =>
          p.kind === "suggested",
      );
    if (!last) continue;
    for (const q of last.questions) {
      if (seen.has(q)) continue;
      seen.add(q);
      out.push(q);
    }
  }
  return out;
};

const RoleAvatar = ({ role }: { role: UIMessage["role"] }) => (
  <Avatar className="size-7">
    <AvatarFallback>
      {role === "assistant" ? (
        <SparklesIcon className="size-4" />
      ) : (
        <UserIcon className="size-4" />
      )}
    </AvatarFallback>
  </Avatar>
);

/**
 * Color-code numeric deltas like `+1.8%`, `-3.1%`, or `+0.6 pts` inside
 * a single table cell. Matches the *first* signed numeric token in the
 * cell; if no match, returns the children unchanged.
 *
 * Patterns recognized (case insensitive, allow comma/decimal):
 *   +1.8%   -3.1%   +0.6 pts   -0.9 pts
 */
const DELTA_PATTERN = /^([+\u2212-])\s*\d[\d,.\s]*(?:%|\s*pts?)?$/i;

function colorizeDelta(content: React.ReactNode): React.ReactNode {
  if (typeof content !== "string") return content;
  const text = content.trim();
  const match = DELTA_PATTERN.exec(text);
  if (!match) return content;
  const sign = match[1];
  if (sign === "+") return <span className="font-medium text-emerald-500">{content}</span>;
  if (sign === "-" || sign === "\u2212")
    return <span className="font-medium text-rose-500">{content}</span>;
  return content;
}

/**
 * Wrapper class layered on every markdown table. AppKit's `Table`
 * family already owns borders, hover, and color tokens - we only add:
 *   - `not-prose` to escape `@tailwindcss/typography`'s table styles
 *     (margins, font-weight, etc.) which fight the AppKit defaults
 *   - compact `text-xs` + `tabular-nums` so columns of numbers align
 *   - right-alignment for every column except the first label column
 *   - `max-w-full overflow-x-auto` so wide tables scroll *inside* the
 *     bubble instead of pushing the whole chat past its max width.
 *     Belt-and-suspenders with the `min-w-0` we set on `ItemContent`
 *     in the assistant bubble.
 */
const TABLE_WRAPPER_CLASSES = cn(
  "not-prose my-4 max-w-full overflow-x-auto text-xs tabular-nums",
  "[&_th:not(:first-child)]:text-right [&_td:not(:first-child)]:text-right",
);

/**
 * Map streamed markdown table elements onto AppKit's Table primitives
 * so chat tables match the rest of the app instead of inheriting
 * `@tailwindcss/typography`'s defaults. The `td` override also runs
 * each cell through `colorizeDelta` so signed numeric tokens (e.g.
 * `+1.8%`, `-3.1 pts`) render in green/red.
 */
const MARKDOWN_COMPONENTS = {
  table: ({ children, ...rest }: React.HTMLAttributes<HTMLTableElement>) => (
    <div className={TABLE_WRAPPER_CLASSES}>
      <Table {...rest}>{children}</Table>
    </div>
  ),
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
      ? children.map((c, i) => <React.Fragment key={i}>{colorizeDelta(c)}</React.Fragment>)
      : colorizeDelta(children as React.ReactNode);
    return <TableCell {...rest}>{colored}</TableCell>;
  },
};

/**
 * Streamdown ships GFM (tables, task lists, strikethrough, autolink),
 * shiki syntax highlighting, KaTeX math, Mermaid diagrams, copy/
 * download controls on code + tables, and incremental-parse handling
 * for partial markdown chunks - all out of the box. We layer on the
 * project's heading rhythm and route tables through AppKit's Table
 * primitives via {@link MARKDOWN_COMPONENTS}, then disable the noisy
 * in-block copy/download buttons since this UI lives inside a chat
 * bubble that already has its own copy button.
 */
const AssistantMarkdown = ({ children }: { children: string }) => (
  <Streamdown
    components={MARKDOWN_COMPONENTS}
    controls={false}
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
 * mapping, but with `text-xs`, muted foreground, and collapsed
 * paragraph / list margins so a few short lines don't take more
 * vertical space than the SQL block above them.
 */
const ToolMarkdown = ({ children }: { children: string }) => (
  <Streamdown
    components={MARKDOWN_COMPONENTS}
    controls={false}
    className={cn(
      "prose prose-sm dark:prose-invert max-w-none break-words",
      "text-xs text-muted-foreground",
      "prose-p:my-1 prose-p:leading-snug",
      "prose-ul:my-1 prose-ol:my-1 prose-li:my-0 prose-li:leading-snug",
      "prose-headings:my-1 prose-headings:text-xs prose-headings:font-semibold",
      "prose-code:text-[11px] prose-code:font-medium",
    )}
  >
    {children}
  </Streamdown>
);

/**
 * Render a SQL string as a syntax-highlighted code block via shiki
 * (bundled with `Streamdown`). Building a fenced markdown string is
 * cheaper than reaching for shiki directly and keeps the rendering
 * consistent with the rest of the chat. We strip Streamdown's
 * default copy/download chrome since the surrounding Collapsible
 * already owns the affordances for this preview.
 */
const SqlBlock = ({ sql }: { sql: string }) => (
  <Streamdown
    controls={false}
    className={cn(
      "prose prose-sm dark:prose-invert max-w-none break-words",
      "prose-pre:my-0 prose-pre:p-2 prose-pre:text-xs prose-pre:rounded-none",
      "prose-pre:bg-transparent prose-code:text-xs",
      "[&_pre]:max-w-full [&_pre]:overflow-x-auto",
    )}
  >
    {`\`\`\`sql\n${sql}\n\`\`\``}
  </Streamdown>
);

/**
 * Frame shared by every chart-slot state so the layout stays
 * stable as a slot transitions from queueing → rendering →
 * rendered (or → render-failed). Width tracks the bubble; height
 * is fixed so Echarts has a deterministic canvas regardless of
 * the parent's flex layout. `not-prose` opts out of Tailwind
 * Typography.
 */
const CHART_FRAME_CLASSES =
  "not-prose my-3 max-w-full rounded border border-border/60 bg-background/40 p-2";
const CHART_HEIGHT_PX = 320;

/**
 * Loading state for a chart slot: dashed-border frame matching
 * the eventual rendered footprint, with a spinner + status. Used
 * before the dataset event arrives and while the planner is
 * still running.
 */
const ChartLoading = ({
  chartId,
  title,
  status,
}: {
  chartId: string;
  title?: string;
  status: string;
}) => (
  <div
    className={cn(
      CHART_FRAME_CLASSES,
      "flex flex-col items-center justify-center border-dashed bg-background/30",
    )}
    style={{ height: CHART_HEIGHT_PX }}
  >
    {title && (
      <div className="mb-1 px-1 text-xs font-medium text-muted-foreground">
        {title}
      </div>
    )}
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Spinner className="size-4" />
      <span>
        {status} <code className="text-[10px]">{chartId}</code>
      </span>
    </div>
  </div>
);

/**
 * Render-failed fallback. Shown when the source tool has finished
 * but no `option` ever landed for this chartId - i.e. the
 * server-side planner threw. Keeps the same frame footprint so
 * the layout doesn't shift when we transition into this state.
 */
const ChartUnavailable = ({
  chartId,
  title,
}: {
  chartId: string;
  title?: string;
}) => (
  <div
    className={cn(
      CHART_FRAME_CLASSES,
      "flex flex-col items-center justify-center border-destructive/40 bg-destructive/5",
    )}
    style={{ height: CHART_HEIGHT_PX }}
  >
    {title && (
      <div className="mb-1 px-1 text-xs font-medium text-muted-foreground">
        {title}
      </div>
    )}
    <div className="px-2 text-center text-xs text-destructive">
      Couldn't render chart <code className="text-[10px]">{chartId}</code>.
    </div>
  </div>
);

/**
 * Inline chart slot. Each `[[chart:<chartId>]]` marker in the
 * assistant's reply resolves to one of these. The slot is purely
 * driven by writer events the producer (Genie / `render_data`)
 * emits via `emitChartWithPlanning`: a dataset event with rows
 * lands first, then a follow-up event with the resolved Echarts
 * `option` lands when the planner finishes. Both arrive
 * pre-merged in {@link MergedChart}; this component just picks
 * the right state.
 *
 * State table (with `isMessageSettled` from the parent bubble):
 *
 * | chart event | option | tool done | settled | render        |
 * | :---------: | :----: | :-------: | :-----: | ------------- |
 * |     -       |   -    |     -     |   no    | "Queueing"    |
 * |     -       |   -    |     -     |   yes   | unavailable * |
 * |     ✓       |   -    |    no     |    -    | "Rendering"   |
 * |     ✓       |   -    |   yes     |    -    | unavailable   |
 * |     ✓       |   ✓    |    -      |    -    | full chart    |
 *
 * \* The "no chart event + settled" row is the hallucinated-
 * chartId case: the model emitted `[[chart:<id>]]` referencing a
 * chartId from a prior turn that's no longer connected to a
 * live chart. The instructions tell the model not to do this,
 * but the UI still degrades gracefully if it slips through.
 *
 * No HTTP fetching, no per-slot caching - the option is in the
 * stream by the time the parent tool finishes (drainGenieStream
 * awaits `Promise.allSettled` on every planner before returning).
 */
const ChartSlot = ({
  chartId,
  chart,
  isMessageSettled,
}: {
  chartId: string;
  chart?: MergedChart;
  /**
   * True when the assistant message hosting this slot has
   * stopped streaming (status returned to `ready` / `error`, or
   * a newer message took the active streaming slot). Used to
   * decide whether a missing chart event is "still arriving"
   * (skeleton) or "never arrived" (unavailable).
   */
  isMessageSettled: boolean;
}) => {
  if (!chart) {
    // Marker present but no chart event for this id. While the
    // message is still streaming, this is the normal "waiting
    // for the writer chunk" state. After the message settles,
    // it's a stale chartId (model hallucinated it from prior
    // turn history); show the unavailable frame instead of
    // spinning forever.
    return isMessageSettled ? (
      <ChartUnavailable chartId={chartId} />
    ) : (
      <ChartLoading chartId={chartId} status="Queueing chart" />
    );
  }
  if (chart.option) {
    return (
      <div className={CHART_FRAME_CLASSES}>
        {chart.title && (
          <div className="mb-1 px-1 text-xs font-medium text-muted-foreground">
            {chart.title}
          </div>
        )}
        <ReactECharts
          option={chart.option}
          style={{ height: CHART_HEIGHT_PX, width: "100%" }}
          notMerge
          lazyUpdate
        />
      </div>
    );
  }
  if (chart.sourceToolDone) {
    // Tool that emitted the dataset has finished without ever
    // emitting an option - planner failed server-side.
    return <ChartUnavailable chartId={chartId} title={chart.title} />;
  }
  return (
    <ChartLoading
      chartId={chartId}
      title={chart.title}
      status="Rendering chart"
    />
  );
};

/**
 * Marker the LLM is instructed to embed in its markdown reply at
 * the position a `render_data` chart should appear. Captured
 * group is the `chartId` returned by the tool. Allowed id chars
 * are `[A-Za-z0-9_-]` so short hex / nanoid / uuid all work.
 */
const CHART_MARKER_RE = /\[\[chart:([A-Za-z0-9_-]+)\]\]/g;

/** One slice of an assistant message: either prose or a chart spot. */
type RenderSegment =
  | { kind: "text"; text: string }
  | { kind: "chart"; chartId: string; chart: MergedChart }
  | { kind: "pending"; chartId: string };

/**
 * Split the assistant's full markdown text on `[[chart:<id>]]`
 * markers, returning an ordered list of prose segments interleaved
 * with chart slots. Markers with a matching {@link MergedChart}
 * resolve to a `chart` segment; markers whose chart hasn't
 * streamed in yet become a `pending` segment so the layout stays
 * stable.
 *
 * Marker matching is greedy and tolerant of partial-stream chunks:
 * an unclosed `[[chart:abc` simply falls through as plain text and
 * matches once the closing `]]` arrives in a later chunk.
 */
const splitTextWithCharts = (
  text: string,
  chartsById: Map<string, MergedChart>,
): RenderSegment[] => {
  const segments: RenderSegment[] = [];
  let lastIdx = 0;
  for (const match of text.matchAll(CHART_MARKER_RE)) {
    const start = match.index ?? 0;
    if (start > lastIdx) {
      segments.push({ kind: "text", text: text.slice(lastIdx, start) });
    }
    const chartId = match[1] ?? "";
    const chart = chartsById.get(chartId);
    segments.push(
      chart ? { kind: "chart", chartId, chart } : { kind: "pending", chartId },
    );
    lastIdx = start + match[0].length;
  }
  if (lastIdx < text.length) {
    segments.push({ kind: "text", text: text.slice(lastIdx) });
  }
  return segments;
};

/**
 * Render the assistant's markdown with charts placed at their
 * inline marker positions. Each prose segment is its own
 * {@link AssistantMarkdown} so streaming chunks still incrementally
 * parse correctly, and chart slots break the markdown flow with a
 * full-width block element. Charts whose `[[chart:<id>]]` marker
 * the model forgot to place are appended below as a fallback so a
 * missing marker can't silently hide the chart.
 */
const MarkdownWithCharts = ({
  text,
  charts,
  isMessageSettled,
}: {
  text: string;
  charts: MergedChart[];
  isMessageSettled: boolean;
}) => {
  const chartsById = new Map(charts.map((c) => [c.chartId, c]));
  const segments = splitTextWithCharts(text, chartsById);
  const placedIds = new Set(
    segments
      .filter((s): s is Extract<RenderSegment, { kind: "chart" }> => s.kind === "chart")
      .map((s) => s.chartId),
  );
  const orphans = charts.filter((c) => !placedIds.has(c.chartId));

  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === "text") {
          if (seg.text.trim().length === 0) return null;
          return <AssistantMarkdown key={`t-${i}`}>{seg.text}</AssistantMarkdown>;
        }
        if (seg.kind === "chart") {
          return (
            <ChartSlot
              key={`c-${seg.chartId}`}
              chartId={seg.chartId}
              chart={seg.chart}
              isMessageSettled={isMessageSettled}
            />
          );
        }
        // Marker present but no chart event for this id. While
        // the message is still streaming, ChartSlot shows a
        // queueing state. Once the message settles, it shows the
        // unavailable frame (model hallucinated a stale chartId).
        return (
          <ChartSlot
            key={`p-${seg.chartId}`}
            chartId={seg.chartId}
            isMessageSettled={isMessageSettled}
          />
        );
      })}
      {orphans.map((c) => (
        <ChartSlot
          key={`o-${c.chartId}`}
          chartId={c.chartId}
          chart={c}
          isMessageSettled={isMessageSettled}
        />
      ))}
    </>
  );
};

/**
 * Tools that are approval-gated server-side (`requireApproval: true`).
 * Any tool-invocation part on this list that lands in
 * `state: 'input-available'` triggers the approval card. Add a new
 * gated tool's id here to wire it into the same flow.
 */
const APPROVAL_GATED_TOOLS = new Set<string>(["send_email"]);

/**
 * Inline approval prompt rendered above the assistant's prose when
 * a tool with `requireApproval: true` is paused in the agent loop.
 * Approve fires {@link onResolveToolApproval} with the input the
 * model passed in; Deny fires it with `approved: false` and a
 * fixed reason. The parent (Chat / Stream pages) translates that
 * into the AI-SDK-V5 `addToolOutput` call (or the equivalent for
 * other transports), which resolves the suspended tool call and
 * resumes the agent.
 */
const ToolApprovalCard = ({
  toolName,
  toolCallId,
  runId,
  input,
  onResolve,
  disabled,
}: {
  toolName: string;
  toolCallId: string;
  runId?: string;
  input: unknown;
  onResolve?: (decision: ApprovalDecision) => void | Promise<void>;
  disabled?: boolean;
}) => {
  const [pending, setPending] = useState(false);
  const handle = (approved: boolean) => {
    if (!onResolve || pending) return;
    setPending(true);
    Promise.resolve(
      approved
        ? onResolve({ approved: true, toolName, toolCallId, runId, input })
        : onResolve({
            approved: false,
            toolName,
            toolCallId,
            runId,
            input,
            reason: "User denied the request from the chat UI.",
          }),
    ).finally(() => setPending(false));
  };

  // Pretty preview for the known email shape; everything else falls
  // back to a generic JSON dump so a new approval-gated tool works
  // without touching this component.
  const isEmail = toolName === "send_email";
  const email = isEmail ? (input as Partial<EmailInput>) : null;

  return (
    <div className="not-prose my-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-amber-700 dark:text-amber-300">
        <MessageSquareIcon className="size-3.5" />
        <span>Approval needed: {humanizeToolName(toolName)}</span>
      </div>
      {email ? (
        <dl className="space-y-1 text-xs">
          {email.to && (
            <div className="flex gap-2">
              <dt className="w-16 shrink-0 text-muted-foreground">To</dt>
              <dd className="truncate">{email.to}</dd>
            </div>
          )}
          {email.subject && (
            <div className="flex gap-2">
              <dt className="w-16 shrink-0 text-muted-foreground">Subject</dt>
              <dd className="truncate font-medium">{email.subject}</dd>
            </div>
          )}
          {email.body && (
            <div className="flex gap-2">
              <dt className="w-16 shrink-0 text-muted-foreground">Body</dt>
              <dd className="whitespace-pre-wrap break-words text-foreground">
                {email.body}
              </dd>
            </div>
          )}
        </dl>
      ) : (
        <pre className="overflow-x-auto rounded bg-background/40 p-2 text-[11px]">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
      <div className="mt-3 flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="default"
          disabled={disabled || pending || !onResolve}
          onClick={() => handle(true)}
        >
          <CheckIcon className="size-3" />
          Approve
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || pending || !onResolve}
          onClick={() => handle(false)}
        >
          <XIcon className="size-3" />
          Deny
        </Button>
        {!onResolve && (
          <span className="ml-1 text-[11px] text-muted-foreground">
            (approval handler not wired on this page)
          </span>
        )}
      </div>
    </div>
  );
};

/** Args shape for `send_email`. Mirrors the server tool's input schema. */
type EmailInput = {
  to: string;
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
};

/**
 * One approval-gated tool call paused mid-turn. `runId` is the
 * Mastra workflow id needed to resume; it's always present when the
 * card was constructed from a live source (chatRoute's
 * `data-tool-call-approval` part or `pendingApprovalsByMessage`),
 * and absent only for approvals reconstructed from a history load
 * where the original runId is lost.
 */
export type PendingApproval = {
  toolName: string;
  toolCallId: string;
  /** Mastra run id from the approval chunk. */
  runId?: string;
  input: unknown;
};

/**
 * Pull every approval-pending tool call out of an assistant
 * message's parts. Mastra's `chatRoute()` (v5 and v6) emits a
 * dedicated `data-tool-call-approval` data part carrying
 * `{ runId, toolCallId, toolName, args }` whenever a
 * `requireApproval: true` tool is paused; that's what `useChat`
 * deserializes into `message.parts`. We read those parts directly
 * (matching the canonical Mastra UI Dojo example,
 * `mastra-ai/ui-dojo/.../tool-approval.tsx`) and additionally filter
 * by {@link APPROVAL_GATED_TOOLS} so unrelated `data-*` parts don't
 * render a card.
 */
const collectPendingApprovals = (parts: UIMessage["parts"]): PendingApproval[] => {
  const out: PendingApproval[] = [];
  for (const part of parts ?? []) {
    const type = (part as { type?: unknown }).type;
    if (type !== "data-tool-call-approval") continue;
    const data = (part as { data?: unknown }).data;
    if (!data || typeof data !== "object") continue;
    const d = data as {
      toolName?: unknown;
      toolCallId?: unknown;
      runId?: unknown;
      args?: unknown;
    };
    if (typeof d.toolName !== "string") continue;
    if (!APPROVAL_GATED_TOOLS.has(d.toolName)) continue;
    if (typeof d.toolCallId !== "string") continue;
    out.push({
      toolName: d.toolName,
      toolCallId: d.toolCallId,
      runId: typeof d.runId === "string" ? d.runId : undefined,
      input: d.args,
    });
  }
  return out;
};

/**
 * Merge inline approvals (from `message.parts`) with out-of-band
 * approvals supplied by the parent (used by the `/stream` page,
 * which doesn't store approvals as data parts). De-dupes by
 * `toolCallId` so a card never appears twice.
 */
const mergePendingApprovals = (
  fromParts: PendingApproval[],
  fromExternal: PendingApproval[] | undefined,
): PendingApproval[] => {
  if (!fromExternal || fromExternal.length === 0) return fromParts;
  const seen = new Set(fromParts.map((a) => a.toolCallId));
  return [...fromParts, ...fromExternal.filter((a) => !seen.has(a.toolCallId))];
};

type AssistantBubbleProps = {
  message: UIMessage;
  isLast: boolean;
  status: ChatStatus;
  events?: ToolEvent[];
  regenerate?: () => void;
  /** Click handler for tool-suggested follow-up questions. */
  onSuggestionClick?: (question: string) => void;
  /** Approve / deny handler for inline {@link ToolApprovalCard}s. */
  onResolveToolApproval?: (decision: ApprovalDecision) => void | Promise<void>;
  /**
   * Out-of-band approvals for this specific message (Stream page).
   * Merged with inline `data-tool-call-approval` parts.
   */
  externalApprovals?: PendingApproval[];
};

const AssistantBubble = ({
  message,
  isLast,
  status,
  events,
  regenerate,
  onSuggestionClick,
  onResolveToolApproval,
  externalApprovals,
}: AssistantBubbleProps) => {
  const reasoning = getReasoningText(message.parts);
  const isReasoningStreaming =
    isLast && status === "streaming" && message.parts.at(-1)?.type === "reasoning";
  const textParts = message.parts.filter(
    (p): p is { type: "text"; text: string } => p.type === "text",
  );
  const fullText = textParts.map((p) => p.text).join("");
  const hasText = fullText.length > 0;
  // Suggestions are deferred until the turn is settled so they don't
  // pop in mid-stream. A bubble is "settled" if it isn't the active
  // streaming target - either the agent has returned to `ready` /
  // `error`, or a newer message has taken over the `isLast` slot.
  const isStreamingThisBubble =
    isLast && (status === "streaming" || status === "submitted");
  const suggestions = isStreamingThisBubble ? [] : collectSuggestions(events);
  // Charts publish `chart` events from the `render_data` tool. The
  // model is instructed to embed `[[chart:<id>]]` markers in its
  // reply at the desired position; {@link MarkdownWithCharts} splits
  // the text on those markers and drops the chart in at the right
  // spot. Charts whose marker hasn't streamed in yet show a
  // skeleton so the layout doesn't shift; charts without a matching
  // marker render at the end as a fallback. Suggested questions
  // stay gated on settle to avoid pop-in mid-stream.
  const charts = collectCharts(events);
  const pendingApprovals = mergePendingApprovals(
    collectPendingApprovals(message.parts),
    externalApprovals,
  );

  return (
    <Item className="items-start gap-3 border-none bg-transparent p-0">
      <ItemMedia>
        <RoleAvatar role="assistant" />
      </ItemMedia>
      {/*
       * `min-w-0` is required so wide content (markdown tables, long
       * code blocks) can shrink to fit instead of pushing the whole
       * bubble past the chat's `max-w-4xl`. Flex children default to
       * `min-width: auto`, which sizes to content and overflows.
       */}
      <ItemContent className="min-w-0 gap-2">
        {reasoning && (
          <Collapsible defaultOpen={isReasoningStreaming}>
            <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ChevronDownIcon className="size-3" />
              <span>{isReasoningStreaming ? "Thinking..." : "Thoughts"}</span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-1 border-l-2 border-border/60 pl-3 text-xs text-muted-foreground whitespace-pre-wrap">
                {reasoning}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
        {pendingApprovals.map((p) => (
          <ToolApprovalCard
            key={p.toolCallId}
            toolName={p.toolName}
            toolCallId={p.toolCallId}
            runId={p.runId}
            input={p.input}
            onResolve={onResolveToolApproval}
          />
        ))}
        {events && events.length > 0 && <ToolEventList events={events} />}
        {(hasText || charts.length > 0) && (
          <MarkdownWithCharts
            text={fullText}
            charts={charts}
            isMessageSettled={!isStreamingThisBubble}
          />
        )}
        {isLast && hasText && (
          <div className="flex items-center gap-1">
            {regenerate && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    onClick={() => regenerate()}
                  >
                    <RefreshCcwIcon className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Retry</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  onClick={() => navigator.clipboard.writeText(fullText)}
                >
                  <CopyIcon className="size-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Copy</TooltipContent>
            </Tooltip>
          </div>
        )}
        {suggestions.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {suggestions.map((q) => (
              <Button
                key={q}
                type="button"
                size="sm"
                variant="outline"
                className="h-auto rounded-full px-3 py-1 text-xs font-normal"
                onClick={() => onSuggestionClick?.(q)}
                disabled={!onSuggestionClick}
              >
                {q}
              </Button>
            ))}
          </div>
        )}
      </ItemContent>
    </Item>
  );
};

const UserBubble = ({ message }: { message: UIMessage }) => {
  const text = message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
  return (
    <Item className="items-start gap-3 border-none bg-transparent p-0">
      <ItemMedia>
        <RoleAvatar role="user" />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <div className="rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap break-words">
          {text}
        </div>
      </ItemContent>
    </Item>
  );
};

/**
 * Sentinel for "no explicit model" in the Select. Radix's `SelectItem`
 * forbids an empty string `value`, so we map `""` <-> `__default__`
 * across the dropdown boundary.
 */
const DEFAULT_MODEL_VALUE = "__default__";

export const ChatView = ({
  messages,
  status,
  sendMessage,
  regenerate,
  suggestions = DEFAULT_SUGGESTIONS,
  toolEventsByMessage = {},
  models,
  model,
  onModelChange,
  onLoadMore,
  isLoadingMore = false,
  hasMore = false,
  isLoadingHistory = false,
  onResolveToolApproval,
  pendingApprovalsByMessage = {},
}: ChatViewProps) => {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  // Scroll-anchor state for prepending older messages. When the
  // parent answers an `onLoadMore` call we capture the pre-prepend
  // `scrollHeight`/`scrollTop`; once the new DOM nodes mount we shift
  // `scrollTop` so the previously-visible content stays in place
  // (instead of jumping to the bottom of the new transcript).
  const prependAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(
    null,
  );
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;

  // Auto-scroll to bottom whenever a new chunk lands, but only while the
  // user is already pinned to the bottom. Lets them scroll up to read
  // history mid-stream without the view yanking them back. Skip the
  // adjust when an older page was just prepended (the anchor restore
  // below owns that case).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (prependAnchorRef.current) return;
    if (!isAtBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, toolEventsByMessage, isAtBottom]);

  // Restore the visual scroll position after a prepend. Runs in
  // `useLayoutEffect` so the adjustment happens before the browser
  // paints; an effect would let the new content flash at the top.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = prependAnchorRef.current;
    prependAnchorRef.current = null;
    if (!el || !anchor) return;
    const delta = el.scrollHeight - anchor.scrollHeight;
    el.scrollTop = anchor.scrollTop + delta;
  }, [messages]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setIsAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD_PX);
    // Lazy-load older messages once the user gets close to the top.
    // Capture the anchor *before* firing the callback so the parent's
    // synchronous state updates don't beat us to the layout effect.
    if (
      el.scrollTop <= TOP_LOAD_MORE_THRESHOLD_PX &&
      hasMore &&
      !isLoadingMore &&
      loadMoreRef.current
    ) {
      prependAnchorRef.current = {
        scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop,
      };
      loadMoreRef.current();
    }
  };

  const scrollToBottom = () => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    sendMessage({ text });
    setInput("");
  };

  const lastMessage = messages.at(-1);
  const lastEvents = lastMessage ? toolEventsByMessage[lastMessage.id] : undefined;
  const lastAssistantHasContent =
    lastMessage?.role === "assistant" &&
    (lastMessage.parts.some(
      (p) =>
        (p.type === "text" || p.type === "reasoning") &&
        Boolean((p as { text?: string }).text),
    ) ||
      (lastEvents?.length ?? 0) > 0);
  const isWaiting =
    (status === "submitted" || status === "streaming") && !lastAssistantHasContent;

  const showModelPicker = Boolean(
    models && models.length > 0 && onModelChange,
  );

  return (
    <TooltipProvider delayDuration={200}>
      <div className="mx-auto flex h-full max-w-4xl flex-col p-0 md:p-6">
        {showModelPicker && (
          <div className="flex items-center justify-end gap-2 px-4 pb-2 pt-1 text-xs text-muted-foreground">
            <span>Model</span>
            <Select
              value={model ? model : DEFAULT_MODEL_VALUE}
              onValueChange={(v) =>
                onModelChange?.(v === DEFAULT_MODEL_VALUE ? "" : v)
              }
            >
              <SelectTrigger size="sm" className="w-[260px]">
                <SelectValue placeholder="Server default" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_MODEL_VALUE}>
                  Server default
                </SelectItem>
                {models!.map((m) => (
                  <SelectItem key={m.name} value={m.name}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="relative flex-1 overflow-y-auto"
        >
          {messages.length === 0 && !isLoadingHistory ? (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <MessageSquareIcon className="size-5" />
                </EmptyMedia>
                <EmptyTitle>Start a conversation</EmptyTitle>
                <EmptyDescription>
                  Ask anything, or pick a suggestion below.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="flex flex-col gap-4 p-4">
              {(isLoadingMore || isLoadingHistory) && (
                <div className="flex items-center justify-center gap-2 py-1 text-xs text-muted-foreground">
                  <Spinner className="size-3" />
                  <span>
                    {isLoadingHistory
                      ? "Loading history..."
                      : "Loading older messages..."}
                  </span>
                </div>
              )}
              {messages.map((message, i) => {
                const isLast = i === messages.length - 1;
                if (message.role === "assistant") {
                  return (
                    <AssistantBubble
                      key={message.id}
                      message={message}
                      isLast={isLast}
                      status={status}
                      events={toolEventsByMessage[message.id]}
                      regenerate={regenerate}
                      onSuggestionClick={(text) => sendMessage({ text })}
                      onResolveToolApproval={onResolveToolApproval}
                      externalApprovals={pendingApprovalsByMessage[message.id]}
                    />
                  );
                }
                return <UserBubble key={message.id} message={message} />;
              })}
              {isWaiting && (
                <div className="flex items-center gap-2 px-3 text-xs text-muted-foreground">
                  <Spinner className="size-3" />
                  <span className="animate-pulse">Thinking...</span>
                </div>
              )}
            </div>
          )}
          {!isAtBottom && (
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={scrollToBottom}
              className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full shadow"
            >
              <ArrowDownIcon className="size-4" />
            </Button>
          )}
        </div>

        {messages.length === 0 && suggestions.length > 0 && (
          <div className="flex flex-wrap gap-2 px-4 pb-2">
            {suggestions.map((s) => (
              <Button
                key={s}
                type="button"
                size="sm"
                variant="outline"
                onClick={() => sendMessage({ text: s })}
              >
                {s}
              </Button>
            ))}
          </div>
        )}

        <form onSubmit={handleSubmit} className="px-4 pb-4 pt-2">
          <InputGroup>
            <InputGroupTextarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(e as unknown as React.FormEvent);
                }
              }}
              placeholder="Send a message..."
              rows={1}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                type="submit"
                size="icon-sm"
                variant="default"
                disabled={!input.trim() || status === "streaming" || status === "submitted"}
              >
                {status === "streaming" || status === "submitted" ? (
                  <Spinner className="size-3" />
                ) : (
                  <SendIcon className="size-3" />
                )}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </form>
      </div>
    </TooltipProvider>
  );
};
