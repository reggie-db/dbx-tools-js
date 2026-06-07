/**
 * Wire-format zod schemas + types and high-level event vocabulary
 * for `@dbx-tools/genie`.
 *
 * Two related layers live here:
 *
 *   1. Genie wire shapes derived from `@dbx-tools/sdk-shared`'s
 *      `dashboards.zod.ts` (which is regenerated from the upstream
 *      `@databricks/sdk-experimental` `apis/dashboards/model.d.ts`
 *      on every `bun run prebuild`). We extend the SDK schemas
 *      where Genie ships fields on the wire that the SDK doesn't
 *      currently type:
 *
 *        - `GenieMessage.auto_regenerate_count: number` (stamped
 *          on every wire message, omitted from the SDK shape).
 *        - `GenieQueryAttachment.thoughts: GenieThought[]` (the
 *          streamed reasoning payload with `DESCRIPTION`,
 *          `DATA_SOURCING`, `STEPS`, and `UNDERSTANDING` thought
 *          kinds).
 *        - `GenieAttachment.attachment_type: AttachmentType`
 *          (a derived discriminator literal so callers can
 *          `switch (att.attachment_type)` instead of probing
 *          which sub-key is populated; populated by
 *          {@link tagAttachment}).
 *
 *   2. Event vocabulary for the high-level `genieEventChat`
 *      driver. Each event is a flat `z.object` with a `type`
 *      literal discriminator and snake_case payload fields hoisted
 *      to the top level (no `payload` wrapper). Events that share
 *      the attachment-scoped location use
 *      {@link GenieChatLocationSchema} as a base; events that
 *      don't carry an `attachment_id` (status, result) omit it.
 *      {@link GenieChatEventSchema} bundles the variants into one
 *      discriminated union.
 *
 * Pure types: no runtime imports beyond zod + the generated
 * sdk-type schemas, no Node-only code, safe for browser bundles.
 */

import {
  genieAttachmentSchema as sdkGenieAttachmentSchema,
  genieMessageSchema as sdkGenieMessageSchema,
  genieQueryAttachmentSchema as sdkGenieQueryAttachmentSchema,
  messageStatusSchema,
} from "@dbx-tools/sdk-shared";
import { stringUtils } from "@dbx-tools/shared";
import { z } from "zod";

/* ----------------------------- statuses ---------------------------- */

/** SDK `MessageStatus` enum value (e.g. `SUBMITTED`, `ASKING_AI`, `COMPLETED`). */
export type MessageStatus = z.infer<typeof messageStatusSchema>;

/* ----------------------------- thoughts ---------------------------- */

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

/**
 * One reasoning step on a query attachment. See
 * {@link GenieThoughtType} for the known `thought_type` values.
 */
export const GenieThoughtSchema = z.object({
  thought_type: z.custom<GenieThoughtType>((v) => typeof v === "string"),
  content: z.string(),
});
export type GenieThought = z.infer<typeof GenieThoughtSchema>;

/* ----------------------- attachment discriminator ---------------------- */

/**
 * Discriminator for what's inside a `GenieAttachment`. Genie only
 * ever populates one of `query` / `text` / `suggested_questions`
 * per attachment. Open via `(string & {})` so a new server-side
 * type doesn't break compilation; the three known types still
 * narrow correctly under `switch`.
 *
 * Lifted into the schema as the optional
 * {@link GenieAttachmentSchema}.`attachment_type` field
 * (populated by {@link tagAttachment}) so consumers can branch
 * on a literal instead of probing which sub-object key is
 * present. Also surfaced on {@link AttachmentEvent}'s payload as
 * `attachment_type` (vs a bare `type`) to keep the field clear of
 * the event-union discriminator key.
 */
export const ATTACHMENT_TYPES = [
  "query",
  "text",
  "suggested_questions",
] as const satisfies readonly string[];
export type KnownAttachmentType = (typeof ATTACHMENT_TYPES)[number];
export type AttachmentType = KnownAttachmentType | (string & {});

/* ------------------- widened wire schemas + types ------------------ */

/**
 * `GenieQueryAttachment` widened with the `thoughts[]` field the
 * Genie wire exposes but the SDK doesn't currently type. Every
 * other field (`description`, `query`, `statement_id`,
 * `query_result_metadata`, `title`, `parameters`,
 * `last_updated_timestamp`, `id`) flows through verbatim from
 * the SDK schema.
 */
export const GenieQueryAttachmentSchema = sdkGenieQueryAttachmentSchema.extend({
  thoughts: z.array(GenieThoughtSchema).optional(),
});
export type GenieQueryAttachment = z.infer<typeof GenieQueryAttachmentSchema>;

/**
 * `GenieAttachment` with:
 *
 *   - `query` re-typed to the thoughts-aware
 *     {@link GenieQueryAttachmentSchema}.
 *   - `attachment_type` discriminator literal
 *     ({@link AttachmentType}) so consumers can `switch
 *     (att.attachment_type)` to narrow which sub-object is
 *     populated. Optional on the wire (Genie doesn't send it),
 *     but every attachment that flows through {@link
 *     tagAttachment} - including all of the ones
 *     `genieEventChat` emits - has it filled in.
 *
 * `attachment_id`, `text`, and `suggested_questions` pass through
 * unchanged. `attachment_id` is genuinely optional on the wire:
 * the first text attachment Genie emits per turn (the "main
 * answer text") arrives with no id, only the follow-up text
 * attachment gets one.
 */
export const GenieAttachmentSchema = sdkGenieAttachmentSchema.extend({
  query: GenieQueryAttachmentSchema.optional(),
  attachment_type: z.custom<AttachmentType>((v) => typeof v === "string").optional(),
});
export type GenieAttachment = z.infer<typeof GenieAttachmentSchema>;

/**
 * `GenieMessage` widened with:
 *
 *   - `auto_regenerate_count`: number stamped on every wire
 *     message that the SDK type omits at v0.17.
 *   - `attachments`: re-typed to the local
 *     {@link GenieAttachmentSchema} so
 *     `attachment.query?.thoughts` (and the
 *     `attachment_type` discriminator) is reachable without a
 *     cast.
 *
 * Every other field (`id`, `space_id`, `conversation_id`,
 * `user_id`, `created_timestamp`, `last_updated_timestamp`,
 * `status`, `content`, `message_id`, `query_result`, `error`,
 * `feedback`) passes through from the SDK schema.
 */
export const GenieMessageSchema = sdkGenieMessageSchema.extend({
  attachments: z.array(GenieAttachmentSchema).optional(),
  auto_regenerate_count: z.number().optional(),
});
export type GenieMessage = z.infer<typeof GenieMessageSchema>;

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

/**
 * Convert a raw Genie wire status (`FETCHING_METADATA`,
 * `ASKING_AI`, `EXECUTING_QUERY`, ...) into a short, sentence-cased
 * label safe to drop into a UI pill. Known states get a curated
 * label; unknown states fall back to `stringUtils.tokenizeWithOptions`
 * so new states still render cleanly without code changes.
 *
 * Pure (no Node-only deps), safe for browser bundles. Both the
 * Genie agent (server) and any UI that subscribes to status events
 * call this so labels stay in lock-step across the wire.
 */
export function humanizeStatus(status: MessageStatus): string {
  switch (status) {
    case "FETCHING_METADATA":
      return "Fetching metadata";
    case "ASKING_AI":
      return "Asking Genie";
    case "EXECUTING_QUERY":
      return "Running SQL query";
    case "FILTERING_CONTEXT":
      return "Filtering context";
    case "PENDING_WAREHOUSE":
      return "Waiting for warehouse";
    case "COMPLETED":
      return "Completed";
    case "FAILED":
      return "Failed";
    case "CANCELLED":
      return "Cancelled";
    default:
      return [
        ...stringUtils.tokenizeWithOptions(
          { capitalize: true, lowerCase: true },
          status,
        ),
      ].join(" ");
  }
}

/* ----------------------- attachment type helper ---------------------- */

/**
 * Inspect a {@link GenieAttachment} and return the
 * {@link AttachmentType} of payload it carries. Returns the first
 * known sub-object that's present; if none of the known ones are
 * populated, falls back to the first non-bookkeeping key
 * (forward-compat for types we don't model yet), else `"unknown"`.
 *
 * Honors a pre-tagged `attachment_type` if one is already on the
 * value (e.g. from a prior {@link tagAttachment} pass) so this is
 * idempotent across re-detections.
 */
export function detectAttachmentType(att: GenieAttachment): AttachmentType {
  if (att.attachment_type) return att.attachment_type;
  if (att.query) return "query";
  if (att.text) return "text";
  if (att.suggested_questions) return "suggested_questions";
  for (const k of Object.keys(att)) {
    if (k !== "attachment_id" && k !== "attachment_type") return k;
  }
  return "unknown";
}

/**
 * Return a copy of `att` with `attachment_type` filled in from
 * {@link detectAttachmentType}. Consumers that want a discriminator
 * literal up-front (e.g. `switch (att.attachment_type)`) call this
 * once when an attachment first arrives.
 */
export function tagAttachment(att: GenieAttachment): GenieAttachment {
  if (att.attachment_type) return att;
  return { ...att, attachment_type: detectAttachmentType(att) };
}

/* ------------------------- GenieChat events ------------------------ */

/**
 * Where on the wire an event was observed. Spread into every
 * attachment-scoped event payload so subscribers can route, log,
 * or correlate without re-walking the message.
 *
 * Fields:
 *   - `space_id`: the Genie space the conversation lives in.
 *   - `conversation_id`: conversation id once Genie has assigned one.
 *   - `message_id`: Genie message id for the active turn.
 *   - `attachment_id`: attachment the event came from. Optional
 *     because Genie sometimes emits an anonymous main-answer
 *     attachment without an id; those still get events, just with
 *     `attachment_id` undefined.
 */
export const GenieChatLocationSchema = z.object({
  space_id: z.string(),
  conversation_id: z.string().optional(),
  message_id: z.string().optional(),
  attachment_id: z.string().optional(),
});
export type GenieChatLocation = z.infer<typeof GenieChatLocationSchema>;

/**
 * Lifecycle event: the question this turn is asking Genie. Fires
 * once per `genieEventChat` call, the first time the underlying
 * `genieChat` loop yields a `GenieMessage`. Carries the prompt
 * text Genie echoed back on `message.content` and the assigned
 * `message_id` so subscribers can group every subsequent event
 * for this turn under one stable key. `conversation_id` is
 * populated for both opening and follow-up turns (Genie assigns
 * it on `startConversation`).
 *
 * Deferred (instead of fired synchronously on entry) so the
 * `message_id` is available when the event lands - that one round
 * trip costs ~200ms but lets UIs render question / thinking /
 * query / text as a single grouped block per Genie call instead
 * of a flat stream.
 *
 * `attachment_id` is intentionally absent - questions are turn
 * scoped, not attachment scoped.
 */
export const QuestionEventSchema = GenieChatLocationSchema.omit({
  attachment_id: true,
}).extend({
  type: z.literal("question"),
  content: z.string(),
});
export type QuestionEvent = z.infer<typeof QuestionEventSchema>;

/**
 * Lifecycle event: raw `GenieMessage` snapshot for the active
 * turn. Fires once per poll yield. The full message shape
 * (including the widened thought / regen / attachment-type
 * fields) is exposed inline as `message`; consumers narrow on
 * `event.type === "message"` and reach for `event.message`.
 */
export const MessageEventSchema = z.object({
  type: z.literal("message"),
  message: GenieMessageSchema,
});
export type MessageEvent = z.infer<typeof MessageEventSchema>;

/**
 * Top-level `message.status` transitioned. Fires for every
 * distinct status seen on the wire (e.g. `SUBMITTED` ->
 * `FILTERING_CONTEXT` -> `ASKING_AI` -> `PENDING_WAREHOUSE` ->
 * `ASKING_AI` -> `COMPLETED`).
 */
export const StatusEventSchema = GenieChatLocationSchema.omit({
  attachment_id: true,
}).extend({
  type: z.literal("status"),
  status: messageStatusSchema,
  previous_status: messageStatusSchema.optional(),
});
export type StatusEvent = z.infer<typeof StatusEventSchema>;

/**
 * A new attachment slot appeared in `message.attachments[]`.
 * Fires exactly once per attachment (matched by `attachment_id`,
 * positionally for anonymous attachments) the first time we see
 * it. The slot's payload kind lands in `attachment_type` so the
 * outer `type` discriminator stays unambiguous.
 */
export const AttachmentEventSchema = GenieChatLocationSchema.extend({
  type: z.literal("attachment"),
  index: z.number(),
  attachment_type: z.custom<AttachmentType>((v) => typeof v === "string"),
});
export type AttachmentEvent = z.infer<typeof AttachmentEventSchema>;

/**
 * A new reasoning step appeared on a query attachment
 * (`attachments[i].query.thoughts[i]`). Deduplicated per
 * `(thought_type, content)` tuple within an attachment so
 * subscribers don't see the same thought multiple times - Genie
 * sometimes mutates existing thought slots in place, so the diff
 * is value-based rather than positional.
 */
export const ThinkingEventSchema = GenieChatLocationSchema.extend({
  type: z.literal("thinking"),
  text: z.string(),
  thought_type: z.custom<GenieThoughtType>((v) => typeof v === "string"),
});
export type ThinkingEvent = z.infer<typeof ThinkingEventSchema>;

/**
 * A text-attachment `content` field appeared or changed
 * (`attachments[i].text.content`). Fires whenever the snapshot
 * value differs from the previous one for the same attachment.
 */
export const TextEventSchema = GenieChatLocationSchema.extend({
  type: z.literal("text"),
  text: z.string(),
});
export type TextEvent = z.infer<typeof TextEventSchema>;

/**
 * SQL was finalized on a query attachment
 * (`attachments[i].query.query`). Fires once when the SQL string
 * transitions from undefined to defined, and again if Genie ever
 * rewrites it. `title` and `description` are denormalised off the
 * attachment's `query.title` / `query.description` so consumers
 * can label the SQL pill without re-walking the message.
 */
export const QueryEventSchema = GenieChatLocationSchema.extend({
  type: z.literal("query"),
  sql: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
});
export type QueryEvent = z.infer<typeof QueryEventSchema>;

/**
 * SQL was submitted to a SQL warehouse and a statement id was
 * assigned (`attachments[i].query.statement_id`). Fires when the
 * statement id transitions from undefined to defined - this is the
 * point at which `client.statementExecution.getStatement({ statement_id })`
 * becomes a valid call.
 */
export const StatementEventSchema = GenieChatLocationSchema.extend({
  type: z.literal("statement"),
  statement_id: z.string(),
});
export type StatementEvent = z.infer<typeof StatementEventSchema>;

/**
 * Row count for a query attachment's result changed
 * (`attachments[i].query.query_result_metadata.row_count`). Fires
 * on every change, including the initial `undefined -> 0` and the
 * later `0 -> N` once the warehouse finishes execution.
 */
export const RowsEventSchema = GenieChatLocationSchema.extend({
  type: z.literal("rows"),
  row_count: z.number(),
  previous_row_count: z.number().optional(),
  statement_id: z.string().optional(),
});
export type RowsEvent = z.infer<typeof RowsEventSchema>;

/**
 * Genie produced a follow-up suggested-questions list
 * (`attachments[i].suggested_questions.questions[]`). Fires once
 * when the list appears, and again if Genie rewrites it.
 */
export const SuggestedQuestionsEventSchema = GenieChatLocationSchema.extend({
  type: z.literal("suggested_questions"),
  questions: z.array(z.string()),
});
export type SuggestedQuestionsEvent = z.infer<typeof SuggestedQuestionsEventSchema>;

/**
 * The active turn reached a terminal status. Always fires once
 * per turn (immediately after the terminal `message` event).
 * Carries the final `GenieMessage` snapshot inline so subscribers
 * don't need to keep their own copy of the last message.
 */
export const ResultEventSchema = GenieChatLocationSchema.omit({
  attachment_id: true,
}).extend({
  type: z.literal("result"),
  status: z.enum(TERMINAL_STATUSES),
  message: GenieMessageSchema,
});
export type ResultEvent = z.infer<typeof ResultEventSchema>;

/**
 * Discriminated union yielded by `genieEventChat`. Each variant
 * is a single flat object with `type` as the discriminator and
 * the payload fields hoisted directly to the top level - no
 * `payload` wrapper. Consumers narrow on `type` and read fields
 * inline:
 *
 * @example
 * for await (const event of genieEventChat(spaceId, "Top stores?")) {
 *   switch (event.type) {
 *     case "thinking":
 *       console.log(event.thought_type, event.text);
 *       break;
 *     case "result":
 *       console.log("done:", event.status);
 *       break;
 *   }
 * }
 *
 * Stream order per turn:
 *
 *   1. `question` (synchronous, before the first SDK call)
 *      carrying the prompt this turn sent to Genie.
 *   2. `message` for every poll yield (raw `GenieMessage` on
 *      `event.message`).
 *   3. Any derived events the snapshot diff produced (`status`,
 *      `attachment`, `thinking`, `text`, `query`, `statement`,
 *      `rows`, `suggested_questions`) in that fixed order.
 *   4. On the terminal snapshot, a final `result` event.
 *
 * Errors propagate via the generator throwing (`try`/`catch` the
 * `for await`), not via an `error` variant on this union.
 */
export const GenieChatEventSchema = z.discriminatedUnion("type", [
  QuestionEventSchema,
  MessageEventSchema,
  StatusEventSchema,
  AttachmentEventSchema,
  ThinkingEventSchema,
  TextEventSchema,
  QueryEventSchema,
  StatementEventSchema,
  RowsEventSchema,
  SuggestedQuestionsEventSchema,
  ResultEventSchema,
]);
export type GenieChatEvent = z.infer<typeof GenieChatEventSchema>;

/** Discriminator type for {@link GenieChatEvent}. */
export type GenieChatEventType = GenieChatEvent["type"];

/**
 * Field set for a given {@link GenieChatEventType} - the variant
 * with the `type` discriminator stripped. Used by detectors in
 * `event.ts` so each detector returns just the payload fields and
 * the orchestrator stamps `type` at yield time.
 */
export type GenieChatEventFields<T extends GenieChatEventType> = Omit<
  Extract<GenieChatEvent, { type: T }>,
  "type"
>;
