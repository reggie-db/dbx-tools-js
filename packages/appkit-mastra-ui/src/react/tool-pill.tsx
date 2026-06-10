import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Spinner,
  cn,
} from "@databricks/appkit-ui/react";
import { humanizeStatus } from "@dbx-tools/genie-shared";
import { CheckIcon, ChevronDownIcon, XIcon } from "lucide-react";
import { SqlBlock, ToolMarkdown } from "./markdown.js";
import type { ToolEvent, ToolProgress } from "./types.js";

// Consolidated tool-session pill and its Genie progress detail view:
// groups the wire events one assistant turn produced into per-sub-call
// cards (question + numbered queries + prose answers + errors).

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
export const humanizeToolName = (toolName: string): string =>
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
 * carries the raw status enum; we humanize it here with
 * {@link humanizeStatus} so the pill stays in lock-step with the
 * server-side label generator.
 */
const runningLabelFor = (event: ToolEvent): string => {
  const latest = [...(event.progress ?? [])]
    .reverse()
    .find((p): p is Extract<ToolProgress, { type: "status" }> => p.type === "status");
  return latest
    ? capitalizeFirst(humanizeStatus(latest.status))
    : `Calling ${humanizeToolName(event.toolName)}`;
};

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
 * the `question` event, which `genieEventChat` defers until
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
 * are resolved out-of-band via the chart cache; suggestions live at
 * message scope.
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
 * Charts produced by `prepare_chart` / `render_data` render at
 * message scope (alongside suggested questions), not inside the
 * pill.
 */
const ToolProgressDetails = ({
  summary,
  omitQuestion,
}: {
  summary: ToolDetailSummary;
  omitQuestion?: boolean;
}) => {
  const renderableGroups = summary.groups.filter(isGroupRenderable);
  if (renderableGroups.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {renderableGroups.map((group, gi) => (
        <MessageGroupBody
          key={group.messageId ?? `anon-${gi}`}
          group={group}
          omitQuestion={omitQuestion}
        />
      ))}
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
          <ToolProgressDetails summary={summary} omitQuestion />
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
export const ToolSessionPill = ({ events }: { events: ToolEvent[] }) => {
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
