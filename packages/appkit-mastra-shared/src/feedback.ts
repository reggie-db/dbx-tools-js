/**
 * Wire-format contract for the Mastra plugin's user-feedback surface:
 * the response header that carries a turn's MLflow trace id back to the
 * browser, plus the request / response schemas for the feedback route
 * (`MASTRA_ROUTES.feedback`).
 *
 * Feedback is logged to MLflow as a trace *assessment* (thumbs up/down
 * as a boolean, or a freeform comment as text), so it must be tied to a
 * trace. The plugin stamps the active OTel trace id of each turn on the
 * response as {@link MLFLOW_TRACE_ID_HEADER} (`tr-<hex>`); the client
 * captures it per assistant message and sends it back here when the
 * user reacts. Kept dependency-free so both the browser client and the
 * server plugin share one definition.
 */

import { z } from "zod";

/**
 * Response header carrying the turn's MLflow trace id (`tr-<hex>`),
 * derived from the active OpenTelemetry trace id. Present only when
 * MLflow logging is enabled and a trace was active for the request.
 * The chat client reads it off the stream response and pairs it with
 * the assistant message so a later thumbs / comment attaches to the
 * right trace.
 */
export const MLFLOW_TRACE_ID_HEADER = "x-mlflow-trace-id";

/** Assessment name used for thumbs feedback when the caller omits one. */
export const DEFAULT_FEEDBACK_NAME = "user_feedback";

/** Assessment name used for a freeform comment when no explicit value is sent. */
export const DEFAULT_COMMENT_NAME = "user_comment";

/**
 * Feedback value the assessment records. Boolean for thumbs up/down,
 * number for a rating scale, string for a short categorical label.
 * A freeform comment travels in `comment` instead (or as the value
 * when no thumbs value is present).
 */
export const MastraFeedbackValueSchema = z.union([z.boolean(), z.number(), z.string()]);
export type MastraFeedbackValue = z.infer<typeof MastraFeedbackValueSchema>;

/**
 * Request body for `POST ${basePath}/route/feedback`.
 *
 * Fields:
 *   - `traceId`: MLflow trace id the feedback attaches to (the
 *     `tr-<hex>` value the server sent via {@link MLFLOW_TRACE_ID_HEADER}).
 *   - `name`: assessment name. Defaults to {@link DEFAULT_FEEDBACK_NAME}
 *     for a value, {@link DEFAULT_COMMENT_NAME} for a comment-only submit.
 *   - `value`: the thumbs / rating value (omit for a comment-only submit).
 *   - `comment`: freeform rationale. Logged as the assessment value when
 *     `value` is absent, or as the rationale alongside a `value`.
 *
 * Refined so an empty submission (neither a value nor a non-empty
 * comment) is rejected rather than logging a meaningless assessment.
 */
export const MastraFeedbackRequestSchema = z
  .object({
    traceId: z.string().min(1),
    name: z.string().optional(),
    value: MastraFeedbackValueSchema.optional(),
    comment: z.string().optional(),
  })
  .refine((v) => v.value !== undefined || (v.comment?.trim().length ?? 0) > 0, {
    message: "feedback requires a value or a non-empty comment",
  });
export type MastraFeedbackRequest = z.infer<typeof MastraFeedbackRequestSchema>;

/**
 * Response from `POST ${basePath}/route/feedback`.
 *
 * `ok` is `true` when the assessment was recorded. It can be `false`
 * (with `ok: false`) without the call throwing - most commonly because
 * the trace hasn't finished exporting to MLflow yet (trace export is
 * asynchronous); the client surfaces a soft "try again" hint rather
 * than an error. `assessmentId` is the created assessment's id on
 * success.
 */
export const MastraFeedbackResponseSchema = z.object({
  ok: z.boolean(),
  assessmentId: z.string().optional(),
});
export type MastraFeedbackResponse = z.infer<typeof MastraFeedbackResponseSchema>;
