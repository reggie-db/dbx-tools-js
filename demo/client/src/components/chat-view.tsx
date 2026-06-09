import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { UIMessage } from "ai";
import type { GenieWriterEvent } from "@dbx-tools/appkit-mastra-shared";
import {
  parseMarkers,
  stripIncompleteMarkerTail,
  type ParsedMarker,
} from "@dbx-tools/appkit-mastra-shared";
import { humanizeStatus } from "@dbx-tools/genie-shared";
import { Streamdown } from "streamdown";
import { useChartFetch, useStatementFetch } from "../lib/mastra-client.js";
import {
  ArrowDownIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  MessageSquareIcon,
  RefreshCcwIcon,
  SendIcon,
  SparklesIcon,
  Trash2Icon,
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
 * Normalised progress event shape. Aliases {@link GenieWriterEvent}
 * from `@dbx-tools/appkit-mastra-shared` so the Genie agent
 * (server) and the chat UI (client) stay in lock-step on the
 * unified flat `{type, ...}` events the `tool-output` chunks
 * carry. New variants should be added there.
 */
export type ToolProgress = GenieWriterEvent;

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
  onResolveToolApproval?: (args: ApprovalDecision) => void | Promise<void>;
  /**
   * Out-of-band approval requests keyed by assistant message id, for
   * transports that don't surface approvals as `UIMessage` parts.
   * The `/stream` page populates this from Mastra's
   * `tool-call-approval` chunk so the same {@link ToolApprovalCard}
   * UI works without injecting synthetic data parts. Each entry is
   * merged with any approvals already discovered in `message.parts`.
   */
  pendingApprovalsByMessage?: Record<string, PendingApproval[]>;
  /**
   * Wipe the current chat thread. When provided, the header renders
   * a "Clear" button that calls this and shows a confirmation
   * prompt first. The handler is responsible for both the
   * server-side delete (typically {@link clearMastraHistory}) and
   * resetting client-side transcript / tool-event state so the
   * blank slate sticks across the next render. Omit to hide the
   * button entirely (read-only embeds, history-less agents).
   */
  onClear?: () => void | Promise<void>;
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
 * Turn a snake/camel tool id into a Title Cased label the user can
 * read. Genie tools land on this surface as flat ids
 * (`ask_genie`, `get_statement`, `prepare_chart`) plus per-space
 * suffixes for non-default aliases (`ask_genie_sales`).
 *
 * Examples:
 *   `ask_genie`     -> `Ask Genie`
 *   `ask_genie_sales` -> `Ask Genie Sales`
 *   `myCoolTool`    -> `My Cool Tool`
 */
const humanizeToolName = (toolName: string): string =>
  toolName
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
 * instead of stalling on a generic "Calling X". The wire event
 * carries the raw {@link MessageStatus} enum; we humanize it here
 * with {@link humanizeStatus} so the pill stays in lock-step with
 * the server-side label generator.
 */
const runningLabelFor = (event: ToolEvent): string => {
  const latest = [...(event.progress ?? [])]
    .reverse()
    .find((p): p is Extract<ToolProgress, { type: "status" }> => p.type === "status");
  return latest
    ? capitalizeFirst(humanizeStatus(latest.status))
    : `Calling ${humanizeToolName(event.toolName)}`;
};

const getReasoningText = (parts: UIMessage["parts"]): string =>
  parts
    .filter((p): p is { type: "reasoning"; text: string } => p.type === "reasoning")
    .map((p) => p.text)
    .join("\n\n");

/**
 * One Genie attachment's worth of progress: the reasoning thoughts
 * that landed on it, the SQL query if any, and the per-attachment
 * text response Genie produced (a "text" attachment carries prose;
 * a "query" attachment can co-emit prose via the same path).
 * Bucketing thinking + query + text together by `attachment_id`
 * keeps the rendered detail view aligned with the underlying wire
 * structure (data sourcing, description, steps, SQL, and the prose
 * interpretation all stay next to each other for the same query
 * instead of intermixing across queries).
 *
 * The `key` is the wire `attachment_id` when Genie supplied one;
 * for the rare anonymous attachment (Genie's "main answer" text
 * sometimes arrives without an id) we fall back to a synthetic
 * `__anon` bucket. That bucket only ever receives events that
 * weren't tied to a query attachment in the first place, so the
 * conflation is harmless.
 */
type AttachmentBucket = {
  key: string;
  thinking: Extract<ToolProgress, { type: "thinking" }>[];
  /**
   * Genie emits one SQL string per query attachment. When it
   * rewrites the SQL mid-turn the later event supersedes the
   * earlier one (so the bucket always shows the final SQL).
   */
  query?: Extract<ToolProgress, { type: "query" }>;
  /**
   * Genie may emit one text snapshot per attachment (typed
   * "text" attachments, plus prose that accompanies a query).
   * Later snapshots supersede earlier ones - we render the final
   * value, which matches how the SDK presents it on
   * `attachment.text.content`.
   */
  text?: Extract<ToolProgress, { type: "text" }>;
};

/**
 * One Genie sub-call's worth of progress, keyed by the assigned
 * `message_id`. Every event coming back from a single
 * `genieEventChat` turn shares the same `message_id` (including
 * the `question` event, which {@link genieEventChat} defers until
 * the first snapshot so it can carry that id). Grouping by
 * `message_id` keeps each LLM-driven sub-call (question + all its
 * attachments) visually distinct from the next sub-call's
 * sub-question and attachments.
 *
 * `messageId` is optional only to keep the wire flexible: events
 * before Genie assigns one (none expected today, since `question`
 * is emitted from the first snapshot) end up in a leading anon
 * group. The grouping algorithm assigns subsequent events to the
 * group whose id matches their `message_id`, opening a new group
 * the first time a new id appears.
 */
type MessageGroup = {
  messageId?: string;
  /** Prompt this Genie call asked, from the `question` event. */
  question?: string;
  attachments: AttachmentBucket[];
  /** Errors emitted under this `message_id` (turn-scoped). */
  errors: Extract<ToolProgress, { type: "error" }>[];
};

/**
 * Shape of the detail rows we extract from a single tool's progress
 * stream. Pulled out so the pill header can show a one-line summary
 * (e.g. `2 queries`) without expanding the collapsible. Charts and
 * suggested follow-up questions are intentionally excluded: charts
 * are resolved out-of-band via the chart cache (see
 * {@link ChartSlot}); suggestions live at message scope (see
 * {@link collectSuggestions}).
 *
 * `thinking` entries are de-duplicated server-side already
 * (`packages/genie-shared/src/event.ts` keys on
 * `(thought_type, content)` per attachment) so we can render them
 * verbatim without an extra dedupe pass here.
 *
 * `groups` preserves first-seen order so the rendered detail view
 * walks Genie sub-calls in the order the LLM dispatched them.
 * Within a group, `attachments` preserves first-seen order too so
 * queries render in the order Genie produced them.
 */
type ToolDetailSummary = {
  groups: MessageGroup[];
};

const ANON_GROUP_KEY = "__anon-group";
const ANON_ATTACHMENT_KEY = "__anon";

const summarizeProgress = (progress: ToolProgress[]): ToolDetailSummary => {
  const groupByMessageId = new Map<string, MessageGroup>();
  const groups: MessageGroup[] = [];

  // Resolve the group an event belongs to. When the event carries a
  // `message_id` we trust it as the canonical key; we open a new
  // group the first time a new id appears so out-of-order arrivals
  // (or `question` re-emits, currently impossible but the union
  // allows it) all converge. When there's no `message_id` (e.g. an
  // anonymous status event before the first snapshot lands) we
  // funnel into a single anon group keyed by ANON_GROUP_KEY.
  const groupFor = (messageId: string | undefined): MessageGroup => {
    const key = messageId ?? ANON_GROUP_KEY;
    let group = groupByMessageId.get(key);
    if (!group) {
      group = {
        ...(messageId ? { messageId } : {}),
        attachments: [],
        errors: [],
      };
      groupByMessageId.set(key, group);
      groups.push(group);
    }
    return group;
  };

  // Per-group attachment bucket resolution. Attachments scoped to
  // different `message_id`s can collide on `attachment_id` (Genie
  // restarts numbering per message), so the bucket map is owned by
  // the group, not the summary.
  const bucketFor = (
    group: MessageGroup,
    attachmentId: string | undefined,
  ): AttachmentBucket => {
    const key = attachmentId ?? ANON_ATTACHMENT_KEY;
    let bucket = group.attachments.find((b) => b.key === key);
    if (!bucket) {
      bucket = { key, thinking: [] };
      group.attachments.push(bucket);
    }
    return bucket;
  };

  for (const p of progress) {
    switch (p.type) {
      case "question": {
        // Latest question wins (today's emitter only fires once per
        // turn, but the union allows future re-emits to update the
        // displayed prompt without orphaning attachments).
        const g = groupFor(p.message_id);
        g.question = p.content;
        break;
      }
      case "thinking": {
        const g = groupFor(p.message_id);
        bucketFor(g, p.attachment_id).thinking.push(p);
        break;
      }
      case "query": {
        const g = groupFor(p.message_id);
        bucketFor(g, p.attachment_id).query = p;
        break;
      }
      case "text": {
        const g = groupFor(p.message_id);
        bucketFor(g, p.attachment_id).text = p;
        break;
      }
      case "error": {
        // Mastra's error event is camelCase (`messageId`) where the
        // wire-derived events are snake_case (`message_id`); align
        // here so an errored Genie call still files under its group.
        const g = groupFor(p.messageId);
        g.errors.push(p);
        break;
      }
      default:
        break;
    }
  }
  return { groups };
};

/**
 * Read the question text for an `ask_genie` tool event. Prefers
 * the `started` event (emitted by `ask_genie` the instant it
 * runs, before any Genie round-trip) so the question appears in
 * the UI immediately; falls back to the wire `question` event
 * for transports that don't carry `started`. Returns `undefined`
 * for non-`ask_genie` tools so callers can skip rendering the
 * inline question line.
 */
const askGenieQuestion = (event: ToolEvent): string | undefined => {
  if (!event.toolName.startsWith("ask_genie")) return undefined;
  for (const p of event.progress ?? []) {
    if (p.type === "started" && p.content) return p.content;
  }
  for (const p of event.progress ?? []) {
    if (p.type === "question" && p.content) return p.content;
  }
  return undefined;
};

/**
 * Strip Genie's `THOUGHT_TYPE_*` prefix and turn the remaining
 * upper-snake into a Title Cased label users can read at a glance.
 *
 * Examples:
 *   `THOUGHT_TYPE_DESCRIPTION`     -> `Description`
 *   `THOUGHT_TYPE_DATA_SOURCING`   -> `Data Sourcing`
 *   `THOUGHT_TYPE_UNDERSTANDING`   -> `Understanding`
 */
const humanizeThoughtType = (kind: string): string =>
  kind
    .replace(/^THOUGHT_TYPE_/i, "")
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

/**
 * Genie attaches one of three payload kinds per attachment slot:
 * `query` (SQL), `text` (prose answer), or `suggested_questions`.
 * `isQueryAttachment` true means this bucket got a SQL query, so
 * it earns a numbered "Query N" card in the UI; prose-only or
 * thinking-only buckets render as plain markdown below the
 * numbered queries because labelling them "Query N" misleads
 * users into thinking Genie ran an extra query when it didn't.
 */
const isQueryAttachment = (b: AttachmentBucket): boolean => Boolean(b.query);

/** True when a bucket has any renderable content (thinking, SQL, or prose). */
const isAttachmentRenderable = (b: AttachmentBucket): boolean =>
  b.thinking.length > 0 || Boolean(b.query) || Boolean(b.text);

/** True when a group has any renderable content (question, attachments, or errors). */
const isGroupRenderable = (g: MessageGroup): boolean =>
  Boolean(g.question) ||
  g.attachments.some(isAttachmentRenderable) ||
  g.errors.length > 0;

/**
 * Body of one Genie sub-call (one `message_id` group). Pulled out
 * so the same render can live either inline (when there's only one
 * group) or wrapped in a Collapsible sub-pill (when there are
 * multiple). Default-quiet layout: only the question stays visible
 * without interaction; every other lane is a Collapsible that
 * starts closed.
 *
 *   1. The LLM's sub-question for this Genie call, always
 *      visible, styled as a blockquote so it reads as provenance.
 *   2. One numbered "Query N" Collapsible per query attachment
 *      (or just "Query" when there's one). Opens to reveal
 *      reasoning thoughts, an inner SQL Collapsible, and any
 *      prose Genie attached directly to the query.
 *   3. One "Answer N" Collapsible per prose-only attachment
 *      (Genie's natural-language summary, follow-up questions).
 *      Opens to reveal thinking + the markdown body.
 *   4. Errors that landed under this `message_id`, always
 *      visible (red text - users need to see failures, not click
 *      to find them).
 *
 * `omitQuestion` skips the question blockquote when the surrounding
 * sub-pill already shows it in its trigger so we don't render the
 * same text twice.
 */
const MessageGroupBody = ({
  group,
  omitQuestion,
}: {
  group: MessageGroup;
  omitQuestion?: boolean;
}) => {
  const renderableAttachments = group.attachments.filter(isAttachmentRenderable);
  // Split renderable attachments into the two visual lanes: numbered
  // query cards vs flat prose. The partition preserves first-seen
  // order within each lane so queries still render in the order
  // Genie produced them and the prose still reads in dispatch order.
  const queryBuckets = renderableAttachments.filter(isQueryAttachment);
  const proseBuckets = renderableAttachments.filter((b) => !isQueryAttachment(b));
  return (
    <div className="flex flex-col gap-1.5">
      {!omitQuestion && group.question && (
        <div className="rounded border-l-2 border-primary/40 bg-background/40 px-2 py-1 text-[11px] italic leading-snug text-muted-foreground">
          {group.question}
        </div>
      )}
      {queryBuckets.map((bucket, i) => (
        // Each query bucket is a single Collapsible (default
        // closed) so the expanded group reads as just the
        // question + a short stack of "Query N" / "Answer" rows.
        // Click any row to drill into its thinking + SQL + text.
        // SQL itself stays a nested Collapsible (default closed)
        // for the same reason: code is the heaviest content here,
        // and most readers only want a glance.
        <Collapsible
          key={bucket.key}
          className="rounded border border-border/60 bg-background/40"
        >
          <CollapsibleTrigger className="group flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] uppercase tracking-wide text-muted-foreground hover:text-foreground">
            <ChevronDownIcon className="size-3 shrink-0 transition-transform group-data-[state=closed]:-rotate-90" />
            <span>{queryBuckets.length > 1 ? `Query ${i + 1}` : "Query"}</span>
            {bucket.query?.title ? (
              <span className="min-w-0 flex-1 truncate normal-case text-muted-foreground/70">
                {bucket.query.title}
              </span>
            ) : null}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="flex flex-col gap-2 px-2 pb-2 text-xs">
              {bucket.thinking.length > 0 && (
                <ul className="flex flex-col gap-1.5 border-l-2 border-border/60 pl-3 text-muted-foreground">
                  {bucket.thinking.map((p, j) => (
                    <li
                      key={`think-${j}`}
                      className="whitespace-pre-wrap break-words leading-snug"
                    >
                      <span className="font-medium text-foreground/80">
                        {humanizeThoughtType(p.thought_type)}:
                      </span>{" "}
                      {p.text}
                    </li>
                  ))}
                </ul>
              )}
              {bucket.query && (
                <Collapsible className="rounded border border-border/60 bg-background/30">
                  <CollapsibleTrigger className="group flex w-full items-center gap-1 px-2 py-1 text-left text-muted-foreground hover:text-foreground">
                    <ChevronDownIcon className="size-3 transition-transform group-data-[state=closed]:-rotate-90" />
                    <span>SQL</span>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="px-2 pb-2">
                      <SqlBlock sql={bucket.query.sql} />
                    </div>
                    {bucket.query.description && (
                      <div className="px-2 pb-2">
                        <ToolMarkdown>{bucket.query.description}</ToolMarkdown>
                      </div>
                    )}
                  </CollapsibleContent>
                </Collapsible>
              )}
              {bucket.text && <ToolMarkdown>{bucket.text.text}</ToolMarkdown>}
            </div>
          </CollapsibleContent>
        </Collapsible>
      ))}
      {proseBuckets.map((bucket, i) => (
        // Prose-only attachments (Genie's natural-language answer
        // and clarifying follow-up question attachments) get the
        // same Collapsible treatment as queries. Label as "Answer"
        // when there's only one prose bucket; multiple buckets
        // (rare - typically interpretation + a follow-up question)
        // get numbered so each row is addressable.
        <Collapsible
          key={bucket.key}
          className="rounded border border-border/60 bg-background/40"
        >
          <CollapsibleTrigger className="group flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] uppercase tracking-wide text-muted-foreground hover:text-foreground">
            <ChevronDownIcon className="size-3 shrink-0 transition-transform group-data-[state=closed]:-rotate-90" />
            <span>{proseBuckets.length > 1 ? `Answer ${i + 1}` : "Answer"}</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="flex flex-col gap-1 px-2 pb-2">
              {bucket.thinking.length > 0 && (
                <ul className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                  {bucket.thinking.map((p, j) => (
                    <li
                      key={`think-${j}`}
                      className="whitespace-pre-wrap break-words leading-snug"
                    >
                      <span className="font-medium text-foreground/80">
                        {humanizeThoughtType(p.thought_type)}:
                      </span>{" "}
                      {p.text}
                    </li>
                  ))}
                </ul>
              )}
              {bucket.text && <ToolMarkdown>{bucket.text.text}</ToolMarkdown>}
            </div>
          </CollapsibleContent>
        </Collapsible>
      ))}
      {group.errors.map((p, i) => (
        <p key={`err-${i}`} className="text-xs text-destructive">
          {p.error}
        </p>
      ))}
    </div>
  );
};

/**
 * Expanded detail view for one tool call. Walks the message
 * groups Genie produced (question + attachments + errors) and
 * renders each as a Collapsible card via {@link MessageGroupBody}.
 *
 * `omitQuestion` strips the inline question blockquote when the
 * caller already surfaces the question in the row header (the
 * typical case under {@link ToolCallRow}, since the question
 * is the most useful thing to keep always-visible).
 *
 * When `isRunning` is true and there's at least some content, a
 * compact spinner row pinned at the bottom signals "more events
 * still arriving" so users don't think the partial state is the
 * final answer.
 *
 * Charts produced by `prepare_chart` / `render_data` render at
 * message scope (alongside suggested questions), not inside the
 * pill.
 */
const ToolProgressDetails = ({
  summary,
  isRunning,
  omitQuestion,
}: {
  summary: ToolDetailSummary;
  isRunning: boolean;
  omitQuestion?: boolean;
}) => {
  const renderableGroups = summary.groups.filter(isGroupRenderable);
  if (renderableGroups.length === 0 && !isRunning) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {renderableGroups.map((group, gi) => (
        <MessageGroupBody
          key={group.messageId ?? `anon-${gi}`}
          group={group}
          omitQuestion={omitQuestion}
        />
      ))}
      {isRunning && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3" />
          <span>Streaming...</span>
        </div>
      )}
    </div>
  );
};

/**
 * Status icon for one tool event, shared between the inner
 * {@link ToolCallRow} and the outer {@link ToolSessionPill} so
 * the affordances stay in lock-step.
 */
const ToolStatusIcon = ({ status }: { status: "running" | "done" | "error" }) => {
  if (status === "running") return <Spinner className="size-3 text-primary" />;
  if (status === "error") return <XIcon className="size-3 text-destructive" />;
  return <CheckIcon className="size-3 text-muted-foreground" />;
};

/**
 * True when a tool event has anything worth expanding for. The
 * question text already rides on the row header (see
 * {@link askGenieQuestion}) so we deliberately don't count it -
 * a row whose only content is the question stays non-expandable.
 */
const hasExpandableDetails = (event: ToolEvent): boolean => {
  if (event.status === "running") return true;
  const summary = summarizeProgress(event.progress ?? []);
  return summary.groups.some(
    (g) => g.attachments.some(isAttachmentRenderable) || g.errors.length > 0,
  );
};

/**
 * One row inside {@link ToolSessionPill}. Always-visible header
 * shows the status icon, the tool's verb (`Called Ask Genie`,
 * `Calling Prepare Chart`, etc.), and - for `ask_genie` rows -
 * the question text the central agent passed to Genie so users
 * can see each sub-question at a glance without expanding.
 *
 * Rows with extra wire detail (Genie SQL, thinking, prose
 * answers, errors) expand to reveal the per-attachment cards
 * built by {@link ToolProgressDetails}. Tools with no extra
 * detail (`get_statement`, `prepare_chart`) render as a flat
 * non-expandable line so the chevron doesn't lie about
 * interactivity.
 */
const ToolCallRow = ({ event }: { event: ToolEvent }) => {
  const isRunning = event.status === "running";
  const isError = event.status === "error";
  const question = askGenieQuestion(event);
  const summary = summarizeProgress(event.progress ?? []);
  const expandable = hasExpandableDetails(event);
  // Inner rows defer to the live wire status when running (e.g.
  // "Executing query") so users tracking the open pill see the
  // backend's freshest state - not just the static
  // "Calling Ask Genie" label.
  const verb = isError
    ? `Failed ${humanizeToolName(event.toolName)}`
    : isRunning
      ? runningLabelFor(event)
      : `Called ${humanizeToolName(event.toolName)}`;

  const header = (
    <span className="min-w-0 flex-1">
      <span
        className={cn(
          "block truncate",
          isRunning && "animate-pulse text-foreground/90",
        )}
      >
        {verb}
      </span>
      {question && (
        <span className="mt-0.5 block break-words italic text-foreground/80">
          {question}
        </span>
      )}
    </span>
  );

  if (!expandable) {
    return (
      <div className="flex items-start gap-2 px-2 py-1 text-xs text-muted-foreground">
        {/* Fixed-width spacer keeps the icon column aligned with
         * sibling expandable rows that lead with a chevron. */}
        <span className="mt-0.5 size-3 shrink-0" aria-hidden />
        <span className="mt-0.5 shrink-0">
          <ToolStatusIcon status={event.status} />
        </span>
        {header}
      </div>
    );
  }

  return (
    <Collapsible className="rounded border border-border/40 bg-background/30">
      <CollapsibleTrigger className="group flex w-full items-start gap-2 px-2 py-1 text-left text-xs text-muted-foreground cursor-pointer hover:text-foreground">
        <ChevronDownIcon className="mt-0.5 size-3 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
        <span className="mt-0.5 shrink-0">
          <ToolStatusIcon status={event.status} />
        </span>
        {header}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-2 pb-2">
          <ToolProgressDetails summary={summary} isRunning={isRunning} omitQuestion />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

/**
 * Consolidated pill for every tool call on one assistant
 * message. The collapsed header tracks the MOST RECENT tool call
 * (its verb and tool name) so the bubble always advertises
 * "what the agent is doing now"; expanding reveals one
 * {@link ToolCallRow} per call in dispatch order so users can
 * see every step the agent took and read the question text the
 * central agent passed to each `ask_genie` call.
 *
 * Overall tone (border / ring / icon) follows the worst-case
 * state across all rows: any running event dominates (primary
 * border + ping pip), then any error (destructive border), then
 * done. The header verb itself follows the LATEST row's status
 * so users see fresh progress as new tool calls land mid-turn
 * (rather than the pill stalling on whichever row was busiest).
 */
const ToolSessionPill = ({ events }: { events: ToolEvent[] }) => {
  if (events.length === 0) return null;
  const latest = events[events.length - 1]!;
  const anyRunning = events.some((e) => e.status === "running");
  const anyError = events.some((e) => e.status === "error");
  const tone: "running" | "error" | "done" = anyRunning
    ? "running"
    : anyError
      ? "error"
      : "done";

  // Outer header uses the tool name verb (not the live wire
  // status) per the "show the most recent tool call" contract.
  // Inner rows still expose the wire status when expanded.
  const isLatestRunning = latest.status === "running";
  const isLatestError = latest.status === "error";
  const latestName = humanizeToolName(latest.toolName);
  const verb = isLatestError
    ? `Failed ${latestName}`
    : isLatestRunning
      ? `Calling ${latestName}`
      : `Called ${latestName}`;
  const countSuffix = events.length > 1 ? ` · ${events.length} calls` : "";

  return (
    <div
      className={cn(
        "rounded-md border bg-background/30 px-2 py-1.5 transition-colors",
        // Loud-but-not-jarring "in flight" treatment when any row
        // is running: primary border + soft ring. Failed sessions
        // (no longer running) pick up the destructive border;
        // settled sessions stay neutral.
        tone === "running"
          ? "border-primary/50 ring-1 ring-primary/15"
          : tone === "error"
            ? "border-destructive/40"
            : "border-border/40",
      )}
    >
      <Collapsible>
        <CollapsibleTrigger className="group flex w-full items-center gap-2 text-left text-xs text-muted-foreground cursor-pointer hover:text-foreground">
          <ChevronDownIcon className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
          <ToolStatusIcon status={tone} />
          {/*
           * Verb + count share one span so the `·` separator reads
           * as a natural inline divider. `min-w-0` lets the truncate
           * clip without forcing the row to overflow when the verb
           * is long.
           */}
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              tone === "running" && "animate-pulse text-foreground/90",
            )}
          >
            {verb}
            {countSuffix && (
              <span className="text-muted-foreground/70">{countSuffix}</span>
            )}
          </span>
          {/*
           * Trailing "live" pip on the right edge while any tool is
           * in flight. Two-layer: a static dot under an animated
           * ping ring, matching the convention native chat apps use
           * for active recording / streaming indicators.
           */}
          {tone === "running" && (
            <span className="relative ml-1 flex size-2 shrink-0" aria-hidden>
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60" />
              <span className="relative inline-flex size-2 rounded-full bg-primary" />
            </span>
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-2 flex flex-col gap-1.5">
            {events.map((event) => (
              <ToolCallRow key={event.id} event={event} />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
};

/**
 * Flatten and de-duplicate the suggested follow-up questions emitted
 * across all tool events on an assistant message. Within each event,
 * the **last** `suggested` progress entry wins (Genie tends to publish
 * an evolving list and the final one is the refined version). Across
 * events we union and dedupe while preserving first-seen order so
 * earlier tools' suggestions still surface.
 */
const collectSuggestions = (events: ToolEvent[] | undefined): string[] => {
  if (!events || events.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const event of events) {
    const last = [...(event.progress ?? [])]
      .reverse()
      .find(
        (p): p is Extract<ToolProgress, { type: "suggested_questions" }> =>
          p.type === "suggested_questions",
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
  if (sign === "+")
    return <span className="font-medium text-emerald-500">{content}</span>;
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
      ? children.map((c, i) => (
          <React.Fragment key={i}>{colorizeDelta(c)}</React.Fragment>
        ))
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
 * mapping, but everything is squeezed: smaller font, tighter leading,
 * and near-zero block margins so a few short lines don't take more
 * vertical space than the SQL block above them. Lists get a shallow
 * indent (`pl-4`) because the default `prose-sm` indent is sized for
 * chat-bubble copy and looks oversized inside a sub-pill. Strong
 * (bold) gets the foreground color so KPI names still pop against
 * the muted body.
 */
const ToolMarkdown = ({ children }: { children: string }) => (
  <Streamdown
    components={MARKDOWN_COMPONENTS}
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
 * Inline chart slot. Each `[chart:<chartId>]` marker in the
 * assistant's reply resolves to one of these. The Mastra plugin
 * caches the resolved Echarts
 * spec under the chartId; this slot fetches it via the generic
 * `embedPathTemplate` (`/embed/chart/:id`, long-poll until ready /
 * error / 404).
 *
 * Render contract:
 *
 *   - Cache entry settled with `result` -> render the full
 *     Echarts spec.
 *   - Cache entry still processing (neither `result` nor `error`
 *     set) -> render NOTHING (the hook keeps polling; the slot
 *     stays empty so prose layout is unaffected).
 *   - Cache entry settled with `error`, or 404 (unknown /
 *     TTL-expired) -> render NOTHING. Markers that can't resolve
 *     to a real chart are silently dropped rather than left as
 *     "Unavailable" placeholder frames. The Echarts `option`
 *     already carries its own `title.text`, so no separate header
 *     is needed above the chart frame.
 */
const ChartSlot = ({ chartId }: { chartId: string }) => {
  const { data: chart } = useChartFetch(chartId);
  if (!chart?.result) return null;
  return (
    <div className={CHART_FRAME_CLASSES}>
      <ReactECharts
        option={chart.result.option}
        style={{ height: CHART_HEIGHT_PX, width: "100%" }}
        notMerge
        lazyUpdate
      />
    </div>
  );
};

/**
 * Inline data-table slot. Each `[data:<statement_id>]` marker in
 * the assistant's reply resolves to one of these. A single
 * OBO-scoped fetch against `embedPathTemplate` (`/embed/data/:id`)
 * returns the columns + rows; the slot renders them through the same
 * `MARKDOWN_COMPONENTS` Table family used for markdown tables so
 * styling stays uniform across the bubble.
 *
 * Render contract (matches {@link ChartSlot}):
 *
 *   - Fetch in flight, statement unknown / 404, or empty rows
 *     -> render NOTHING. Stale markers in persisted transcripts
 *     silently drop so a reload doesn't leave dead frames.
 *   - Data settled with rows -> render an inline table with a
 *     trailing "showing N of M" footer when the server-side cap
 *     truncated the result set.
 */
const DataSlot = ({ statementId }: { statementId: string }) => {
  const { data } = useStatementFetch(statementId);
  if (!data || data.rows.length === 0) return null;
  return (
    <div className={TABLE_WRAPPER_CLASSES}>
      <Table>
        <TableHeader>
          <TableRow>
            {data.columns.map((c) => (
              <TableHead key={c}>{c}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.rows.map((row, i) => (
            <TableRow key={i}>
              {data.columns.map((c) => {
                const v = row[c];
                const text = v == null ? "" : String(v);
                return <TableCell key={c}>{colorizeDelta(text)}</TableCell>;
              })}
            </TableRow>
          ))}
        </TableBody>
        {data.truncated && (
          <TableFooter>
            <TableRow>
              <TableCell
                colSpan={data.columns.length}
                className="text-muted-foreground"
              >
                Showing {data.rows.length} of {data.rowCount} rows
              </TableCell>
            </TableRow>
          </TableFooter>
        )}
      </Table>
    </div>
  );
};

/** One slice of an assistant message: prose, a chart slot, or a data slot. */
type RenderSegment =
  | { kind: "text"; text: string }
  | { kind: "chart"; chartId: string }
  | { kind: "data"; statementId: string };

/**
 * Split the assistant's full markdown text on chart and data
 * markers, returning an ordered list of prose segments
 * interleaved with embed slots. Each marker resolves to either
 * a `chart` segment ({@link ChartSlot}) or a `data` segment
 * ({@link DataSlot}); prose between markers stays as `text`.
 *
 * Callers are responsible for buffering trailing partial markers
 * (`[chart:abc` mid-stream) via {@link stripIncompleteMarkerTail}
 * before splitting, so the prose doesn't flash the literal
 * `[chart:` prefix before the closing bracket arrives.
 */
/**
 * Map one parsed marker onto its render segment. The marker grammar
 * matches ANY `[<type>:<id>]` (and already guarantees a UUID-shaped
 * id), but rendering is type-aware - charts need ECharts, data needs
 * a Table - so map only the kinds this UI can render. Anything else
 * collapses to an empty text segment: the marker is consumed so no
 * literal `[<type>:...]` leaks into the prose, but no slot renders
 * and no `/embed/<type>/:id` request fires.
 */
const markerSegment = (marker: ParsedMarker): RenderSegment => {
  switch (marker.type) {
    case "chart":
      return { kind: "chart", chartId: marker.id };
    case "data":
      return { kind: "data", statementId: marker.id };
    default:
      return { kind: "text", text: "" };
  }
};

const splitTextWithEmbeds = (text: string): RenderSegment[] => {
  const segments: RenderSegment[] = [];
  let lastIdx = 0;
  // `parseMarkers` yields hits in source order with no overlaps (one
  // regex pass), so the spans splice in directly - no sort or
  // overlap guard needed.
  for (const marker of parseMarkers(text)) {
    if (marker.start > lastIdx) {
      segments.push({ kind: "text", text: text.slice(lastIdx, marker.start) });
    }
    segments.push(markerSegment(marker));
    lastIdx = marker.end;
  }
  if (lastIdx < text.length) {
    segments.push({ kind: "text", text: text.slice(lastIdx) });
  }
  return segments;
};

/**
 * Render the assistant's markdown with chart and data tables
 * placed at their inline marker positions. Each prose segment
 * is its own {@link AssistantMarkdown} so streaming chunks still
 * incrementally parse correctly; embed slots break the markdown
 * flow with full-width block elements.
 *
 * Each marker resolves through its own slot:
 *
 *   - `[chart:<id>]` -> {@link ChartSlot} long-polls the
 *     server-side chart cache and renders the Echarts spec
 *     inline once ready (or nothing on miss / TTL-expired).
 *   - `[data:<statement_id>]` -> {@link DataSlot} fetches the
 *     statement rows OBO-scoped and renders an inline Table
 *     (or nothing on 404 / empty result).
 *
 * Stale markers in persisted transcript text are silently
 * dropped on reload so the prose around them stays clean.
 */
const MarkdownWithEmbeds = ({ text }: { text: string }) => {
  const segments = splitTextWithEmbeds(stripIncompleteMarkerTail(text));
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === "text") {
          if (seg.text.trim().length === 0) return null;
          return <AssistantMarkdown key={`t-${i}`}>{seg.text}</AssistantMarkdown>;
        }
        if (seg.kind === "chart") {
          return <ChartSlot key={`c-${i}-${seg.chartId}`} chartId={seg.chartId} />;
        }
        return (
          <DataSlot key={`d-${i}-${seg.statementId}`} statementId={seg.statementId} />
        );
      })}
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
  // Charts and tables are placed at inline marker positions in
  // the assistant's prose. `prepare_chart` / `render_data` mint
  // a `chartId` and the model embeds `[chart:<chartId>]`; for raw
  // data the model embeds `[data:<statement_id>]` and the host UI fetches the
  // rows on its own. {@link MarkdownWithEmbeds} splits the text
  // on both markers and renders {@link ChartSlot} /
  // {@link DataSlot} inline; unknown / expired ids resolve as
  // nothing so the prose flows unaffected. Suggested questions
  // stay gated on settle to avoid pop-in mid-stream.
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
        {events && events.length > 0 && <ToolSessionPill events={events} />}
        {/*
         * Render each text part as its own block. A multi-step turn
         * carries one text part per step (see Stream.tsx segmentation),
         * so this keeps each step's preamble visually separate instead
         * of concatenating them into a single run of prose.
         */}
        {textParts.map((part, i) =>
          part.text.trim().length > 0 ? (
            <MarkdownWithEmbeds key={`text-${i}`} text={part.text} />
          ) : null,
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
                // `h-auto` lets long suggestions grow vertically;
                // `whitespace-normal` + `text-left` overrides the
                // base button's `whitespace-nowrap` so multi-line
                // questions wrap inside the pill instead of
                // overflowing the chat column. `rounded-2xl`
                // keeps a friendly capsule shape for short
                // suggestions while scaling cleanly when a long
                // question wraps to two or three lines (the full
                // `rounded-full` capsule warps awkwardly with
                // wrapped text).
                className="h-auto max-w-full whitespace-normal text-left rounded-2xl px-3 py-1.5 text-xs font-normal leading-snug"
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
  onClear,
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
    setIsAtBottom(
      el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD_PX,
    );
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
    scrollRef.current.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
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
  // Single in-flight indicator for the whole turn: visible from the
  // moment the agent run opens (`status === "submitted"`) until the
  // server signals done (`status === "ready"` / `"error"`). The label
  // refines based on what the turn is currently doing so the user
  // gets a finer-grained hint without the spinner blinking on/off
  // between text, tool, and "between-step" phases.
  const lastAssistantParts = lastMessage?.role === "assistant" ? lastMessage.parts : [];
  const lastAssistantHasContent =
    lastAssistantParts.some(
      (p) =>
        (p.type === "text" || p.type === "reasoning") &&
        Boolean((p as { text?: string }).text),
    ) || (lastEvents?.length ?? 0) > 0;
  const hasRunningTool = (lastEvents ?? []).some((e) => e.status === "running");
  const showWaiting = status === "submitted" || status === "streaming";
  const waitingLabel = !lastAssistantHasContent
    ? "Thinking..."
    : hasRunningTool
      ? "Working..."
      : "Composing response...";

  const showModelPicker = Boolean(models && models.length > 0 && onModelChange);
  const showClear = Boolean(onClear);
  const showHeader = showModelPicker || showClear;

  // Local "in-flight" + confirm latch for the clear button so the
  // user can't double-fire the DELETE and so a stray click doesn't
  // wipe history without a beat to back out. Resets back to idle
  // after the parent's `onClear` settles (success or failure).
  const [clearState, setClearState] = useState<"idle" | "confirm" | "clearing">("idle");

  const handleClearClick = async () => {
    if (clearState === "clearing" || !onClear) return;
    if (clearState === "idle") {
      setClearState("confirm");
      return;
    }
    setClearState("clearing");
    try {
      await onClear();
    } finally {
      setClearState("idle");
    }
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div className="mx-auto flex h-full max-w-4xl flex-col p-0 md:p-6">
        {showHeader && (
          <div className="flex items-center justify-end gap-3 px-4 pb-2 pt-1 text-xs text-muted-foreground">
            {showModelPicker && (
              <div className="flex items-center gap-2">
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
                    <SelectItem value={DEFAULT_MODEL_VALUE}>Server default</SelectItem>
                    {models!.map((m) => (
                      <SelectItem key={m.name} value={m.name}>
                        {m.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {showClear && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant={clearState === "confirm" ? "destructive" : "outline"}
                    size="sm"
                    onClick={handleClearClick}
                    onBlur={() =>
                      // Drop the confirm latch when focus leaves so a
                      // half-armed button doesn't sit destructive-red
                      // forever after the user clicks away.
                      setClearState((s) => (s === "confirm" ? "idle" : s))
                    }
                    disabled={clearState === "clearing"}
                    className="gap-1.5"
                  >
                    {clearState === "clearing" ? (
                      <Spinner className="size-3" />
                    ) : (
                      <Trash2Icon className="size-3" />
                    )}
                    {clearState === "confirm"
                      ? "Confirm clear"
                      : clearState === "clearing"
                        ? "Clearing..."
                        : "Clear"}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {clearState === "confirm"
                    ? "Click again to confirm; wipes this conversation."
                    : "Clear chat history for this thread"}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        )}
        <div className="relative flex flex-1 flex-col overflow-hidden">
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto"
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
                {showWaiting && (
                  <div className="flex items-center gap-2 px-3 text-xs text-muted-foreground">
                    <Spinner className="size-3" />
                    <span className="animate-pulse">{waitingLabel}</span>
                  </div>
                )}
              </div>
            )}
          </div>
          {!isAtBottom && (
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={scrollToBottom}
              className="absolute bottom-4 right-4 rounded-full shadow"
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
                disabled={
                  !input.trim() || status === "streaming" || status === "submitted"
                }
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
