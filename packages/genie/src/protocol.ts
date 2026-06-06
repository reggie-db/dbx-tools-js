/**
 * Wire-format types for `@dbx-tools/genie`.
 *
 * The Databricks experimental SDK (`@databricks/sdk-experimental`
 * v0.17) doesn't export the dashboards namespace from its top-level
 * index, and the nested interfaces inside
 * `apis/dashboards/model.d.ts` (`GenieAttachment`,
 * `GenieQueryAttachment`, `TextAttachment`, `Result`, ...) are
 * declared module-private. The only types that *are* exported from
 * that module are the top-level request/response shells:
 * `GenieMessage`, `GenieStartConversationResponse`,
 * `GenieGetMessageQueryResultResponse`.
 *
 * To reach the nested wire shapes without forking them or pinning a
 * brittle deep import that the SDK might reorganize, we derive them
 * via indexed-access (`NonNullable<Parent["field"]>[number]`) off the
 * exported parents. That gives us the SDK's *own* nested types,
 * structurally - so future field additions on the SDK side flow
 * straight through, and the only thing we have to maintain here is
 * the small set of overrides that capture wire fields the SDK still
 * doesn't type at this version:
 *
 * - `GenieMessage.auto_regenerate_count: number` (number stamped on
 *   every poll, omitted from the SDK shape).
 * - `GenieQueryAttachment.thoughts[]` (the streamed reasoning
 *   payload with `DESCRIPTION`, `DATA_SOURCING`, `STEPS`, and
 *   `UNDERSTANDING` thought kinds).
 *
 * Verified against captured poll dumps under `tmp/genie-poll-*.log`.
 *
 * Pure types: no runtime dependencies, no Node-only imports, safe
 * for browser bundles.
 */

// Deep import: the dashboards module isn't surfaced from the SDK's
// top-level `index.d.ts` at v0.17. The `dist/apis/<service>/model`
// path is the codegen convention and the same path the SDK's own
// `api.d.ts` uses to reach these shapes.
import type * as dashboards from "@databricks/sdk-experimental/dist/apis/dashboards/model.js";

// Zod is used only for the event-protocol section at the bottom
// of this file (envelope-validating SSE events). The wire-format
// content shapes (`GenieMessage`, `GenieAttachment`, ...) above
// stay as plain TS types sourced from the SDK.
import { z } from "zod";

/* ----------- structural pulls from the SDK's exported shells ----------- */

// These three are the only top-level interfaces the SDK exports
// from the dashboards model. Everything else flows out of them via
// indexed-access below.
type SdkGenieMessage = dashboards.GenieMessage;
type SdkGenieStartConversationResponse = dashboards.GenieStartConversationResponse;
type SdkStatementResponse = dashboards.GenieGetMessageQueryResultResponse;

// Nested wire shapes, derived structurally so we never reach into
// the SDK's private interface names. The `NonNullable<...>` wrap
// strips the optionality of the parent field; the `[number]` peels
// the array element where applicable.
type SdkGenieAttachment = NonNullable<SdkGenieMessage["attachments"]>[number];
type SdkGenieQueryAttachment = NonNullable<SdkGenieAttachment["query"]>;
type SdkGenieSuggestedQuestionsAttachment = NonNullable<
  SdkGenieAttachment["suggested_questions"]
>;
type SdkTextAttachment = NonNullable<SdkGenieAttachment["text"]>;
type SdkGenieResultMetadata = NonNullable<
  SdkGenieQueryAttachment["query_result_metadata"]
>;
type SdkResult = NonNullable<SdkGenieMessage["query_result"]>;
type SdkMessageStatus = NonNullable<SdkGenieMessage["status"]>;
type SdkMessageError = NonNullable<SdkGenieMessage["error"]>;
type SdkMessageErrorType = NonNullable<SdkMessageError["type"]>;
type SdkTextAttachmentPurpose = NonNullable<SdkTextAttachment["purpose"]>;

/* ------------------- direct re-exports (no widening) ------------------- */

export type GenieSuggestedQuestionsAttachment = SdkGenieSuggestedQuestionsAttachment;
export type TextAttachment = SdkTextAttachment;
export type TextAttachmentPurpose = SdkTextAttachmentPurpose;
export type GenieResultMetadata = SdkGenieResultMetadata;
export type MessageStatus = SdkMessageStatus;
export type MessageError = SdkMessageError;
export type MessageErrorType = SdkMessageErrorType;
export type GenieStartConversationResponse = SdkGenieStartConversationResponse;
/** Statement-execution payload returned by `getMessageAttachmentQueryResult`. */
export type StatementResponse = SdkStatementResponse;
/**
 * Top-level deprecated `GenieMessage.query_result` field. Genie
 * still populates this on the wire with `{statement_id, row_count}`
 * even though attachment-level `query_result_metadata` is the
 * preferred source.
 */
export type Result = SdkResult;

/* -------------------------- thought widening -------------------------- */

/**
 * Genie's per-query "thoughts" surface. These appear on the
 * `/messages/{id}` wire under `attachments[i].query.thoughts[]` but
 * are not typed on the SDK's `GenieQueryAttachment` at v0.17.
 *
 * Known thought types observed in production polls:
 *
 * - `THOUGHT_TYPE_DESCRIPTION`: a one-paragraph restatement of what
 *   the user asked. The final `query.description` field on the
 *   attachment carries the same text.
 * - `THOUGHT_TYPE_DATA_SOURCING`: markdown bullets of the
 *   fully-qualified `catalog.schema.table` sources Genie chose.
 * - `THOUGHT_TYPE_STEPS`: the high-level plan Genie wrote before
 *   running SQL (one bullet per step).
 * - `THOUGHT_TYPE_UNDERSTANDING`: ambiguity / interpretation notes
 *   ("'revenue' could be interpreted in different ways such as
 *   gross revenue, net revenue, or recognized revenue...").
 *
 * Open at the type level (`| (string & {})`) so a new server-side
 * thought kind doesn't break compilation; the four known kinds
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
 * `suggested_questions` are unchanged. Note that `attachment_id`
 * is genuinely optional on the wire: the first text attachment
 * Genie emits per turn (the "main answer text") arrives with no
 * id, only the follow-up text attachment gets one.
 */
export type GenieAttachment = Omit<SdkGenieAttachment, "query"> & {
  query?: GenieQueryAttachment;
};

/**
 * `GenieMessage` widened with:
 *
 * - `auto_regenerate_count`: number stamped on every wire message
 *   that the SDK type omits at v0.17.
 * - `attachments`: re-typed to the local {@link GenieAttachment}
 *   so `attachment.query?.thoughts` is reachable without a cast.
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
 * Terminal Genie message statuses. The polling loop stops as soon
 * as the latest message has one of these statuses.
 */
export const TERMINAL_STATUSES = ["COMPLETED", "FAILED", "CANCELLED"] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export function isTerminalStatus(s: MessageStatus | undefined): s is TerminalStatus {
  return s !== undefined && (TERMINAL_STATUSES as readonly string[]).includes(s);
}

/* ------------------------- event protocol ------------------------- */

/**
 * Every kind of event a Genie run can emit. String values match
 * the wire / log conventions and the field they correspond to on
 * a `GenieMessage` so SSE consumers can route by `event.type`
 * directly.
 */
export enum GenieEventType {
  RAW = "raw",
  UPDATED = "updated",
  STATUS = "status",
  ATTACHMENT = "attachment",
  STATEMENT_ID = "statementId",
  DESCRIPTION = "description",
  SQL = "sql",
  THOUGHT = "thought",
  TEXT = "text",
  SUGGESTED_QUESTIONS = "suggestedQuestions",
  ROW_COUNT = "rowCount",
  QUERY_RESULT = "queryResult",
  QUERY_ERROR = "queryError",
  MESSAGE_ERROR = "messageError",
  TERMINAL = "terminal",
}

/* -------------------- opaque content schemas --------------------- */

/**
 * Zod schemas for the "content" fields of events (messages,
 * attachments, thoughts, SDK statement responses). We deliberately
 * do NOT re-model these in Zod - the SDK and the upper protocol
 * section above already type them. Instead each opaque schema
 * checks the runtime shape (`object` / `string`) and types its
 * output as the canonical TS type, so:
 *
 * 1. The SDK stays the single source of truth for the rich content
 *    shapes (`GenieMessage`, `GenieAttachment`, `StatementResponse`).
 * 2. Wire validation still catches the easy mistakes (e.g. an event
 *    that arrived with `message: null` or `status: 42`).
 * 3. New fields the server adds to a `GenieMessage` flow through
 *    untouched; nothing here strips or rejects them.
 *
 * If a tighter content check is ever needed at the consumer side
 * (e.g. a browser SSE client), wrap the parsed event's content
 * fields with a more specific schema downstream.
 */
// Generic is erased at runtime, so the failure message can't be
// auto-derived from `T`. The default ZodError already includes the
// failing field's `path` (e.g. `["status"]`), which is enough to
// locate the bad content slot, so we skip the redundant per-field
// label and rely on the path.
const opaqueObject = <T>() => z.custom<T>((v) => typeof v === "object" && v !== null);
const opaqueString = <T extends string>() => z.custom<T>((v) => typeof v === "string");

const messageSchema = opaqueObject<GenieMessage>().describe(
  "Latest `GenieMessage` payload observed when this event was emitted.",
);
const attachmentSchema = opaqueObject<GenieAttachment>().describe(
  "SDK `GenieAttachment` (query / text / suggested_questions variant).",
);
const thoughtSchema = opaqueObject<GenieThought>().describe(
  "SDK `GenieThought` - one reasoning/understanding step on a query attachment.",
);
const statementResponseSchema = opaqueObject<StatementResponse>().describe(
  "Raw SDK `StatementResponse` returned by `getMessageAttachmentQueryResult`.",
);

const messageStatusSchema = opaqueString<MessageStatus>().describe(
  "SDK `MessageStatus` enum value (e.g. `SUBMITTED`, `ASKING_AI`, `COMPLETED`).",
);
const messageErrorTypeSchema = opaqueString<MessageErrorType>().describe(
  "SDK `MessageErrorType` enum value for `MessageError.type`.",
);
const textAttachmentPurposeSchema = opaqueString<TextAttachmentPurpose>().describe(
  'SDK `TextAttachmentPurpose` enum value (e.g. `"FOLLOW_UP_QUESTION"`).',
);
const terminalStatusSchema = z
  .enum(TERMINAL_STATUSES)
  .describe("Terminal `MessageStatus` - one of `COMPLETED`, `FAILED`, `CANCELLED`.");

/* ---------------------- per-event schemas ----------------------- */
//
// Every schema is a `z.object({...}).describe("...")`. Schema-level
// descriptions document the variant; field-level `.describe()`
// calls document the fields. Shared content schemas
// (`messageSchema`, `attachmentSchema`, ...) carry their own
// default descriptions above, so events only override the
// description where the field's meaning differs in context (e.g.
// `prev` on `UpdatedEventSchema` is the previous payload, not the
// current one).
//
// Discriminator is `type: z.literal(GenieEventType.X)` on every
// schema so the union below can route on `event.type`.

const discriminator = <T extends GenieEventType>(t: T) =>
  z.literal(t).describe("Discriminator. Switch on this to narrow the event variant.");

const attachmentIdField = z
  .string()
  .optional()
  .describe("`attachment_id` from the SDK, omitted for anonymous attachments.");

const statementIdField = z
  .string()
  .optional()
  .describe("`statement_id` for the underlying query attachment, when known.");

const RawEventSchema = z
  .object({
    type: discriminator(GenieEventType.RAW),
    message: messageSchema,
  })
  .describe(
    "Every poll, including unchanged ones. `message` carries the entire wire payload.",
  );

const UpdatedEventSchema = z
  .object({
    type: discriminator(GenieEventType.UPDATED),
    message: messageSchema,
    prev: messageSchema.describe("Payload from the prior poll, before this delta arrived."),
  })
  .describe("Poll returned a different payload than the previous one.");

const StatusEventSchema = z
  .object({
    type: discriminator(GenieEventType.STATUS),
    message: messageSchema,
    status: messageStatusSchema.describe("New top-level message status."),
    prev: messageStatusSchema
      .optional()
      .describe("Previous status, omitted on the very first transition."),
  })
  .describe("Top-level status transition (deduped to one event per new value).");

const AttachmentEventSchema = z
  .object({
    type: discriminator(GenieEventType.ATTACHMENT),
    message: messageSchema,
    attachment: attachmentSchema,
    index: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Position in `message.attachments[]`. Stable handle for the anonymous main-answer attachment.",
      ),
  })
  .describe("A previously-unseen attachment appeared on the message.");

const StatementIdEventSchema = z
  .object({
    type: discriminator(GenieEventType.STATEMENT_ID),
    message: messageSchema,
    statementId: z
      .string()
      .describe("New `statement_id` for the query attachment - use to fetch SQL rows."),
    attachmentId: attachmentIdField,
  })
  .describe("A previously-unseen `statement_id` appeared on a query attachment.");

const DescriptionEventSchema = z
  .object({
    type: discriminator(GenieEventType.DESCRIPTION),
    message: messageSchema,
    description: z
      .string()
      .describe("Final natural-language description of the query attachment."),
    attachmentId: attachmentIdField,
    statementId: statementIdField,
  })
  .describe("Query attachment's `description` finalized (or changed).");

const SqlEventSchema = z
  .object({
    type: discriminator(GenieEventType.SQL),
    message: messageSchema,
    sql: z.string().describe("Final SQL text Genie will run for this query attachment."),
    attachmentId: attachmentIdField,
    statementId: statementIdField,
  })
  .describe("Query attachment's `query` (SQL text) finalized.");

const ThoughtEventSchema = z
  .object({
    type: discriminator(GenieEventType.THOUGHT),
    message: messageSchema,
    thought: thoughtSchema,
    attachmentId: attachmentIdField,
    statementId: statementIdField,
  })
  .describe("A new thought (deduped per attachment by `thought_type` + `content`).");

const TextEventSchema = z
  .object({
    type: discriminator(GenieEventType.TEXT),
    message: messageSchema,
    content: z.string().describe("Text-attachment `content` as Genie produced it."),
    attachmentId: attachmentIdField,
    purpose: textAttachmentPurposeSchema
      .optional()
      .describe('SDK `TextAttachmentPurpose`, e.g. `"FOLLOW_UP_QUESTION"`.'),
  })
  .describe("Text attachment's `content` appeared or changed.");

const SuggestedQuestionsEventSchema = z
  .object({
    type: discriminator(GenieEventType.SUGGESTED_QUESTIONS),
    message: messageSchema,
    questions: z
      .array(z.string())
      .describe("Suggested follow-up questions Genie produced for this turn."),
    attachmentId: attachmentIdField,
  })
  .describe("Suggested-questions attachment appeared.");

const RowCountEventSchema = z
  .object({
    type: discriminator(GenieEventType.ROW_COUNT),
    message: messageSchema,
    rowCount: z
      .number()
      .int()
      .nonnegative()
      .describe("New `query_result_metadata.row_count` for the attachment."),
    prev: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Previous row count, omitted on the first observation."),
    attachmentId: attachmentIdField,
    statementId: statementIdField,
  })
  .describe("`query_result_metadata.row_count` moved (e.g. 0 -> 80).");

const QueryResultEventSchema = z
  .object({
    type: discriminator(GenieEventType.QUERY_RESULT),
    message: messageSchema,
    statementId: z.string().describe("Statement the rows were fetched against."),
    attachmentId: z
      .string()
      .describe("Attachment the rows belong to. Always present on this event."),
    data: statementResponseSchema,
  })
  .describe("Rows fetched for a query attachment via `getMessageAttachmentQueryResult`.");

const QueryErrorEventSchema = z
  .object({
    type: discriminator(GenieEventType.QUERY_ERROR),
    message: messageSchema,
    statementId: z.string().describe("Statement the failed fetch targeted."),
    attachmentId: z.string().describe("Attachment the failed fetch targeted."),
    error: z.unknown().describe("Whatever the fetch threw - typically `Error`, but can be anything."),
  })
  .describe("Fetching rows for a query attachment failed.");

const MessageErrorEventSchema = z
  .object({
    type: discriminator(GenieEventType.MESSAGE_ERROR),
    message: messageSchema,
    error: z.string().describe("Human-readable error string from `message.error.error`."),
    errorType: messageErrorTypeSchema
      .optional()
      .describe("SDK `MessageError.type`, renamed to avoid clashing with the discriminator."),
  })
  .describe(
    "Genie reported an error on the message body (`message.error`). " +
      "Named `messageError` rather than `error` so the SSE stream doesn't " +
      "collide with Node's `EventEmitter` reserved-name semantics for " +
      "unhandled `error` events when consumed via an EE adapter.",
  );

const TerminalEventSchema = z
  .object({
    type: discriminator(GenieEventType.TERMINAL),
    message: messageSchema.describe("Final `GenieMessage` snapshot at terminal status."),
    status: terminalStatusSchema.describe(
      "Narrowed terminal status: `COMPLETED` | `FAILED` | `CANCELLED`.",
    ),
  })
  .describe("Message reached a terminal status. Always the last event on a run.");

/* ---------------------- discriminated union ---------------------- */

export const GenieEventSchema = z
  .discriminatedUnion("type", [
    RawEventSchema,
    UpdatedEventSchema,
    StatusEventSchema,
    AttachmentEventSchema,
    StatementIdEventSchema,
    DescriptionEventSchema,
    SqlEventSchema,
    ThoughtEventSchema,
    TextEventSchema,
    SuggestedQuestionsEventSchema,
    RowCountEventSchema,
    QueryResultEventSchema,
    QueryErrorEventSchema,
    MessageErrorEventSchema,
    TerminalEventSchema,
  ])
  .describe(
    "Validated, discriminated union of every event a Genie run can emit. " +
      "Use `GenieEventSchema.parse(JSON.parse(chunk))` on an SSE client to " +
      "get a fully-typed `GenieEvent` (or a thrown `ZodError`).",
  );

/* --------------------- inferred TS event types ------------------- */

/** Discriminated union of every event - inferred from {@link GenieEventSchema}. */
export type GenieEvent = z.infer<typeof GenieEventSchema>;

/**
 * Narrow {@link GenieEvent} to the concrete event for a specific
 * {@link GenieEventType}. Useful when typing a handler keyed by
 * event type:
 *
 * ```ts
 * function onThought(event: GenieEventOf<GenieEventType.THOUGHT>) {
 *   console.log(event.thought.thought_type);
 * }
 * ```
 */
export type GenieEventOf<T extends GenieEventType> = Extract<GenieEvent, { type: T }>;


