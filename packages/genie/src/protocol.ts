/**
 * Wire-format types and event vocabulary for `@dbx-tools/genie`.
 *
 * Two related layers live here:
 *
 *   1. Wire types pulled structurally from
 *      `@databricks/sdk-experimental` v0.17. The SDK doesn't export
 *      its dashboards namespace from the top-level index, and the
 *      nested interfaces inside `apis/dashboards/model.d.ts`
 *      (`GenieAttachment`, `GenieQueryAttachment`, ...) are
 *      module-private. The only top-level shape exported from that
 *      module that `chat.ts` relies on is `GenieMessage`. We pull
 *      the nested shapes via indexed-access
 *      (`NonNullable<Parent["field"]>[number]`) off the exported
 *      parent so we don't depend on private interface names. New
 *      fields the SDK adds flow through verbatim. We only widen
 *      where Genie ships a field on the wire that the SDK doesn't
 *      currently type:
 *
 *        - `GenieMessage.auto_regenerate_count: number` (stamped
 *          on every wire message, omitted from the SDK shape).
 *        - `GenieQueryAttachment.thoughts[]` (the streamed
 *          reasoning payload with `DESCRIPTION`, `DATA_SOURCING`,
 *          `STEPS`, and `UNDERSTANDING` thought kinds).
 *
 *   2. Event vocabulary for the high-level `GenieChat` handle
 *      (`GenieChatLocation`, `ThinkingEvent`, `TextEvent`,
 *      `ResultEvent`, `GenieChatEventMap`). These live alongside
 *      the wire shapes so consumers can import payload types
 *      without pulling in `chat.ts`'s Node-only runtime
 *      (`node:events`, `WorkspaceClient`). They're typed against
 *      the widened wire shapes above so payload fields line up
 *      with what subscribers actually see on the wire.
 *
 * Pure types: no runtime imports, no Node-only code, safe for
 * browser bundles. The single runtime export is
 * {@link isTerminalStatus}.
 */

// Deep import: the dashboards module isn't surfaced from the SDK's
// top-level `index.d.ts` at v0.17. The `dist/apis/<service>/model`
// path is the codegen convention and the same path the SDK's own
// `api.d.ts` uses to reach these shapes.
import type * as dashboards from "@databricks/sdk-experimental/dist/apis/dashboards/model.js";

/* ----------- structural pulls from the SDK's exported shells ----------- */

// `GenieMessage` is the only top-level interface the SDK exports
// from the dashboards model that we need. Everything else flows
// from it via indexed access.
type SdkGenieMessage = dashboards.GenieMessage;
type SdkGenieAttachment = NonNullable<SdkGenieMessage["attachments"]>[number];
type SdkGenieQueryAttachment = NonNullable<SdkGenieAttachment["query"]>;
type SdkMessageStatus = NonNullable<SdkGenieMessage["status"]>;

/** SDK `MessageStatus` enum value (e.g. `SUBMITTED`, `ASKING_AI`, `COMPLETED`). */
export type MessageStatus = SdkMessageStatus;

/* -------------------------- thought widening -------------------------- */

/**
 * Genie's per-query "thoughts" surface. These appear on the
 * `/messages/{id}` wire under `attachments[i].query.thoughts[]` but
 * are not typed on the SDK's `GenieQueryAttachment` at v0.17.
 *
 * Known thought types observed in production polls:
 *
 *   - `THOUGHT_TYPE_DESCRIPTION`: a one-paragraph restatement of
 *     what the user asked. The final `query.description` field on
 *     the attachment carries the same text.
 *   - `THOUGHT_TYPE_DATA_SOURCING`: markdown bullets of the
 *     fully-qualified `catalog.schema.table` sources Genie chose.
 *   - `THOUGHT_TYPE_STEPS`: the high-level plan Genie wrote before
 *     running SQL (one bullet per step).
 *   - `THOUGHT_TYPE_UNDERSTANDING`: ambiguity / interpretation
 *     notes (e.g. "'revenue' could be interpreted as gross,
 *     net, or recognized revenue...").
 *
 * Open at the type level (`| (string & {})`) so a new server-side
 * thought type doesn't break compilation; the four known types
 * still narrow correctly under `switch`.
 */
export type GenieThoughtType =
  | "THOUGHT_TYPE_DESCRIPTION"
  | "THOUGHT_TYPE_DATA_SOURCING"
  | "THOUGHT_TYPE_STEPS"
  | "THOUGHT_TYPE_UNDERSTANDING"
  | (string & {});

export interface GenieThought {
  thought_type: GenieThoughtType;
  content: string;
}

/* --------------------- structural wire-shape overrides ---------------- */

/**
 * `GenieQueryAttachment` widened with the `thoughts[]` field the
 * Genie wire exposes but the SDK doesn't currently type. All other
 * fields (`description`, `query`, `statement_id`,
 * `query_result_metadata`, `title`, `parameters`,
 * `last_updated_timestamp`, `id`) flow through verbatim from the
 * SDK shape.
 */
export type GenieQueryAttachment = SdkGenieQueryAttachment & {
  thoughts?: GenieThought[];
};

/**
 * `GenieAttachment` with `query` re-typed to the thoughts-aware
 * {@link GenieQueryAttachment}. `attachment_id`, `text`, and
 * `suggested_questions` pass through unchanged. Note that
 * `attachment_id` is genuinely optional on the wire: the first
 * text attachment Genie emits per turn (the "main answer text")
 * arrives with no id, only the follow-up text attachment gets one.
 */
export type GenieAttachment = Omit<SdkGenieAttachment, "query"> & {
  query?: GenieQueryAttachment;
};

/**
 * `GenieMessage` widened with:
 *
 *   - `auto_regenerate_count`: number stamped on every wire message
 *     that the SDK type omits at v0.17.
 *   - `attachments`: re-typed to the local {@link GenieAttachment}
 *     so `attachment.query?.thoughts` is reachable without a cast.
 *
 * Every other field (`id`, `space_id`, `conversation_id`,
 * `user_id`, `created_timestamp`, `last_updated_timestamp`,
 * `status`, `content`, `message_id`, `query_result`, `error`,
 * `feedback`) passes through from the SDK shape.
 */
export type GenieMessage = Omit<SdkGenieMessage, "attachments"> & {
  attachments?: GenieAttachment[];
  auto_regenerate_count?: number;
};

/* ------------------------ terminal helpers ------------------------- */

/**
 * Terminal Genie message statuses. The polling loop in
 * `chat.ts` stops as soon as the latest message has one of these
 * statuses.
 */
export const TERMINAL_STATUSES = ["COMPLETED", "FAILED", "CANCELLED"] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

/** Narrow `MessageStatus | undefined` to a {@link TerminalStatus}. */
export function isTerminalStatus(s: MessageStatus | undefined): s is TerminalStatus {
  return s !== undefined && (TERMINAL_STATUSES as readonly string[]).includes(s);
}

/* ----------------------- attachment type helper ---------------------- */

/**
 * Discriminator for what's inside a `GenieAttachment`. Genie only
 * ever populates one of `query` / `text` / `suggested_questions`
 * per attachment. Open via `(string & {})` so a new server-side
 * type doesn't break compilation; the three known types still
 * narrow correctly under `switch`.
 */
export type AttachmentType =
  | "query"
  | "text"
  | "suggested_questions"
  | (string & {});

/**
 * Inspect a {@link GenieAttachment} and return the type of payload
 * it carries. Returns the first known sub-object that's present;
 * if none of the known ones are populated, falls back to the first
 * non-`attachment_id` key (forward-compat for types we don't model
 * yet), else `"unknown"`.
 */
export function detectAttachmentType(att: GenieAttachment): AttachmentType {
  if (att.query) return "query";
  if (att.text) return "text";
  if (att.suggested_questions) return "suggested_questions";
  for (const k of Object.keys(att)) {
    if (k !== "attachment_id") return k;
  }
  return "unknown";
}

/* ------------------------- GenieChat events ------------------------ */

/**
 * Where on the wire an event was observed. Common shape baked into
 * every `GenieChat` event so subscribers can route, log, or
 * correlate without re-walking the message.
 */
export interface GenieChatLocation {
  /** The Genie space the conversation lives in. */
  space_id: string;
  /** Conversation id once Genie has assigned one. */
  conversation_id?: string;
  /** Genie message id for the active turn. */
  message_id?: string;
  /**
   * Attachment the event came from. Optional because Genie
   * sometimes emits an anonymous main-answer attachment without an
   * id; those still get events, just with `attachment_id`
   * undefined.
   */
  attachment_id?: string;
}

/**
 * Top-level `message.status` transitioned. Fires for every
 * distinct status seen on the wire (e.g. `SUBMITTED` ->
 * `FILTERING_CONTEXT` -> `ASKING_AI` -> `PENDING_WAREHOUSE` ->
 * `ASKING_AI` -> `COMPLETED`).
 */
export interface StatusEvent extends Omit<GenieChatLocation, "attachment_id"> {
  /** New status. */
  status: MessageStatus;
  /** Prior status, or `undefined` for the very first snapshot of a turn. */
  previous_status?: MessageStatus;
}

/**
 * A new attachment slot appeared in `message.attachments[]`.
 * Fires exactly once per attachment (matched by `attachment_id`,
 * positionally for anonymous attachments) the first time we see
 * it. Use {@link AttachmentType} to know what payload it carries
 * without inspecting the raw message.
 */
export interface AttachmentEvent extends GenieChatLocation {
  /** Index in the `attachments[]` array. */
  index: number;
  /** Which sub-object the attachment carries (`query` / `text` / `suggested_questions`). */
  type: AttachmentType;
}

/**
 * A new reasoning step appeared on a query attachment
 * (`attachments[i].query.thoughts[i]`). Deduplicated per
 * `(thought_type, content)` tuple within an attachment so
 * subscribers don't see the same thought multiple times - Genie
 * sometimes mutates existing thought slots in place (e.g.
 * re-typing index 0 from `DATA_SOURCING` to `DESCRIPTION` while
 * re-appending the original at index 1), so the diff is
 * value-based rather than positional.
 */
export interface ThinkingEvent extends GenieChatLocation {
  /** Thought content (markdown). */
  text: string;
  /** Thought type (e.g. `THOUGHT_TYPE_STEPS`). */
  thought_type: GenieThoughtType;
}

/**
 * A text-attachment `content` field appeared or changed
 * (`attachments[i].text.content`). Fires whenever the snapshot
 * value differs from the previous one for the same attachment.
 */
export interface TextEvent extends GenieChatLocation {
  /** Text-attachment content as Genie produced it. */
  text: string;
}

/**
 * SQL was finalized on a query attachment
 * (`attachments[i].query.query`). Fires once when the SQL string
 * transitions from undefined to defined, and again if Genie ever
 * rewrites it.
 */
export interface QueryEvent extends GenieChatLocation {
  /** The SQL string Genie produced. */
  sql: string;
}

/**
 * SQL was submitted to a SQL warehouse and a statement id was
 * assigned (`attachments[i].query.statement_id`). Fires when the
 * statement id transitions from undefined to defined - this is the
 * point at which `client.statementExecution.getStatement({ statement_id })`
 * becomes a valid call.
 */
export interface StatementEvent extends GenieChatLocation {
  /** Statement id for the running / completed warehouse query. */
  statement_id: string;
}

/**
 * Row count for a query attachment's result changed
 * (`attachments[i].query.query_result_metadata.row_count`). Fires
 * on every change, including the initial `undefined -> 0` and the
 * later `0 -> N` once the warehouse finishes execution.
 */
export interface RowsEvent extends GenieChatLocation {
  /** Current row count. */
  row_count: number;
  /** Prior row count, or `undefined` if this is the first observation. */
  previous_row_count?: number;
  /** Associated statement id if one has been assigned. */
  statement_id?: string;
}

/**
 * Genie produced a follow-up suggested-questions list
 * (`attachments[i].suggested_questions.questions[]`). Fires once
 * when the list appears, and again if Genie rewrites it.
 */
export interface SuggestedQuestionsEvent extends GenieChatLocation {
  /** Suggested follow-up questions in display order. */
  questions: string[];
}

/**
 * The active turn reached a terminal status. Always fires once
 * per turn (immediately after the terminal `message` event).
 */
export interface ResultEvent extends Omit<GenieChatLocation, "attachment_id"> {
  /** Narrowed terminal status: `COMPLETED` / `FAILED` / `CANCELLED`. */
  status: TerminalStatus;
  /** Final `GenieMessage` snapshot. */
  message: GenieMessage;
}

/**
 * Strongly-typed event vocabulary for `GenieChat.on` / `once` /
 * `off`. Maps event name -> payload type. Errors are not on this
 * surface: `GenieChat.run()` rejects with the underlying error, so
 * `try { await chat.run(); } catch ...` is the single handling
 * path.
 */
export interface GenieChatEventMap {
  /** Raw `GenieMessage` for every poll yield (already distinct-filtered). */
  message: GenieMessage;
  /** Top-level status transition; see {@link StatusEvent}. */
  status: StatusEvent;
  /** New attachment slot appeared; see {@link AttachmentEvent}. */
  attachment: AttachmentEvent;
  /** New thought on a query attachment; see {@link ThinkingEvent}. */
  thinking: ThinkingEvent;
  /** New / changed text-attachment content; see {@link TextEvent}. */
  text: TextEvent;
  /** SQL was finalized on a query attachment; see {@link QueryEvent}. */
  query: QueryEvent;
  /** Statement id assigned (warehouse submission); see {@link StatementEvent}. */
  statement: StatementEvent;
  /** Row count changed; see {@link RowsEvent}. */
  rows: RowsEvent;
  /** Follow-up suggested questions appeared; see {@link SuggestedQuestionsEvent}. */
  suggested_questions: SuggestedQuestionsEvent;
  /** Turn reached a terminal status; see {@link ResultEvent}. */
  result: ResultEvent;
}
