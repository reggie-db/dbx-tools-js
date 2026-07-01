/**
 * MLflow user-feedback logging: detect whether MLflow tracing is wired
 * for this deployment, and log a thumbs / comment as a trace
 * *assessment* via the Databricks MLflow REST API.
 *
 * Feedback attaches to a trace, and the plugin's spans reach MLflow
 * through the same OTel pipeline as every other AppKit span (see
 * `observability.ts`). MLflow derives its trace id from the OpenTelemetry
 * trace id (`tr-<hex(otelTraceId)>`), so the server stamps the active
 * trace id on each turn's response and the client sends it back here.
 *
 * There is no MLflow JS SDK, so this posts to the assessments REST
 * endpoint directly using the OBO-scoped workspace client (the feedback
 * is thus attributed to the signed-in user). Trace export is
 * asynchronous, so the just-finished trace may not exist in MLflow yet
 * when the user reacts; the log call retries briefly on "not found"
 * before giving up softly.
 */

import { commonUtils, logUtils, type appkitUtils } from "@dbx-tools/shared";

import { DEFAULT_COMMENT_NAME, DEFAULT_FEEDBACK_NAME } from "@dbx-tools/appkit-mastra-shared";
import { databricksFetch } from "./rest.js";

const log = logUtils.logger("mastra/mlflow");

/** Workspace client carried on an AppKit execution context. */
type WorkspaceClient = appkitUtils.WorkspaceClientLike;

/** Assessments REST path for a trace. `3.0` is the current MLflow API version. */
const assessmentsPath = (traceId: string): string =>
  `/api/3.0/mlflow/traces/${encodeURIComponent(traceId)}/assessments`;

/** Number of times to retry a "trace not found" response before giving up. */
const NOT_FOUND_RETRIES = 3;
/** Base backoff between "trace not found" retries, in ms (grows linearly). */
const NOT_FOUND_BACKOFF_MS = 1200;

/**
 * Whether MLflow feedback logging is available for this deployment.
 *
 * Enabled when an OTLP exporter endpoint is configured (traces are
 * actually shipped somewhere) AND an MLflow experiment is named - the
 * two signals that the OTLP backend is MLflow and traces will
 * materialize there. Both are standard env vars, so no plugin config is
 * required; a deployment opts in simply by wiring MLflow tracing.
 */
export function mlflowEnabled(): boolean {
  const hasExporter = Boolean(
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ||
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim(),
  );
  const hasExperiment = Boolean(
    process.env.MLFLOW_EXPERIMENT_ID?.trim() || process.env.MLFLOW_EXPERIMENT_NAME?.trim(),
  );
  return hasExporter && hasExperiment;
}

/** Parameters for {@link logFeedback}. */
export interface LogFeedbackParams {
  /** MLflow trace id the assessment attaches to (`tr-<hex>`). */
  traceId: string;
  /** Assessment name; defaults per whether a value or a comment is sent. */
  name?: string;
  /** Thumbs / rating / label value. Omit for a comment-only submission. */
  value?: boolean | number | string;
  /** Freeform comment: the rationale alongside a value, or the value itself when none. */
  comment?: string;
  /** Identity the feedback is attributed to (user email / id). */
  sourceId?: string;
}

/**
 * Log a HUMAN feedback assessment to a trace. Returns the created
 * assessment id on success, or `undefined` when the trace can't be
 * found (even after retrying for export lag) or the request otherwise
 * fails - callers surface that as a soft "not recorded" rather than an
 * error, keeping the chat usable.
 */
export async function logFeedback(
  client: WorkspaceClient,
  params: LogFeedbackParams,
): Promise<string | undefined> {
  // A comment with no thumbs value is logged as text feedback; a value
  // (with an optional comment as the rationale) is the thumbs path.
  const hasValue = params.value !== undefined;
  const name =
    params.name?.trim() || (hasValue ? DEFAULT_FEEDBACK_NAME : DEFAULT_COMMENT_NAME);
  const value = hasValue ? params.value : params.comment;
  const assessment: Record<string, unknown> = {
    trace_id: params.traceId,
    assessment_name: name,
    source: {
      source_type: "HUMAN",
      source_id: params.sourceId?.trim() || "user",
    },
    feedback: { value },
    ...(hasValue && params.comment?.trim() ? { rationale: params.comment } : {}),
  };
  const body = { assessment };

  for (let attempt = 0; attempt <= NOT_FOUND_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await databricksFetch(client, assessmentsPath(params.traceId), {
        method: "POST",
        body,
      });
    } catch (err) {
      log.warn("feedback request failed", {
        traceId: params.traceId,
        error: commonUtils.errorMessage(err),
      });
      return undefined;
    }
    if (res.ok) {
      const parsed = await safeJson(res);
      const assessmentId =
        (parsed as { assessment?: { assessment_id?: unknown } })?.assessment
          ?.assessment_id ?? (parsed as { assessment_id?: unknown })?.assessment_id;
      return typeof assessmentId === "string" ? assessmentId : "";
    }
    // Trace export is async; a fresh trace may not exist yet. Retry a
    // few times with a short backoff before giving up softly.
    if (res.status === 404 && attempt < NOT_FOUND_RETRIES) {
      await delay(NOT_FOUND_BACKOFF_MS * (attempt + 1));
      continue;
    }
    log.warn("feedback not recorded", {
      traceId: params.traceId,
      status: res.status,
      body: await safeText(res),
    });
    return undefined;
  }
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await safeText(res);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
