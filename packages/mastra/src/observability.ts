/**
 * Mastra observability wiring backed by Databricks-managed MLflow.
 *
 * Mastra's `Observability` registry accepts any
 * `@mastra/observability` `BaseExporter`. We use `OtelExporter` from
 * `@mastra/otel-exporter` (Mastra's first-party OTLP shim) with the
 * `custom` provider pointed at the workspace's MLflow tracking
 * endpoint, plus the target experiment id forwarded as the
 * `x-mlflow-experiment-id` header.
 *
 * Configuration is layered, mirroring `dbx_ai.agents._auto_instrument`:
 *
 * 1. Explicit `MlflowConfig` argument passed in by the caller wins.
 * 2. `MLFLOW_TRACKING_URI` and `MLFLOW_EXPERIMENT_ID` environment
 *    variables. If both are present they are used as-is and no
 *    workspace round-trip happens.
 * 3. Fall back to discovery via `getExecutionContext()`:
 *      - `trackingUri` defaults to the current workspace host. This is
 *        the equivalent of `mlflow.set_tracking_uri("databricks")` in
 *        Python: traces target the workspace's managed MLflow.
 *      - `experimentId` is resolved from `MLFLOW_EXPERIMENT_NAME`
 *        when set, otherwise from the project name. Bare names are
 *        expanded into `/Users/<me>/<name>` and `/Shared/<name>`
 *        candidate paths before lookup, and a missing experiment is
 *        created at the user path so traces always have a home.
 *
 * If discovery fails (no execution context, no resolvable experiment)
 * this returns `undefined` so the caller can omit `observability`
 * from the `new Mastra({...})` constructor and Mastra keeps its noop
 * default.
 */

import { getExecutionContext } from "@databricks/appkit";
import type { WorkspaceClient } from "@databricks/sdk-experimental";
import { httpUtils, logUtils, projectUtils } from "@dbx-tools/appkit-shared";
import { Observability } from "@mastra/observability";
import { OtelExporter } from "@mastra/otel-exporter";

import { TRACE_REQUEST_CONTEXT_KEYS } from "./config.js";

const log = logUtils.logger("mastra/observability");

const SHARED_PATH = "/Shared/";
const USERS_PATH = "/Users/";

export interface MlflowConfig {
  trackingUri: string;
  experimentId: string;
}

// Minimal structural type for an MLflow experiment lookup result.
// Picks the only field we depend on so we don't have to deep-import
// from `@databricks/sdk-experimental/dist/apis/ml`.
type ExperimentLike = { experiment_id?: string; name?: string };

export interface BuildObservabilityOptions {
  /** MLflow target overrides. See {@link resolveMlflowConfig}. */
  mlflow?: Partial<MlflowConfig>;
  /**
   * `RequestContext` keys to extract as span metadata on every
   * trace. Defaults to {@link TRACE_REQUEST_CONTEXT_KEYS} (user id,
   * thread id, environment, model override, ...).
   *
   * Supports dot notation for nested values per the Mastra docs.
   */
  requestContextKeys?: readonly string[];
}

/**
 * Build a Mastra `Observability` that streams traces to the workspace's
 * managed MLflow OTLP collector. Returns `undefined` when neither an
 * explicit config nor the environment / execution context can produce
 * both a tracking URI and an experiment id, so callers can simply omit
 * the field from the `Mastra` constructor.
 *
 * Trace metadata enrichment: every span automatically inherits the
 * `RequestContext` keys listed in {@link TRACE_REQUEST_CONTEXT_KEYS}
 * (user id, thread id, deployment environment, model override, ...).
 * `MastraServer.registerAuthMiddleware` is responsible for stamping
 * those keys on the per-request `RequestContext`.
 */
export async function buildObservability(
  options?: BuildObservabilityOptions,
): Promise<Observability | undefined> {
  const resolved = await resolveMlflowConfig(options?.mlflow);
  if (!resolved) {
    log.debug("MLflow config unavailable; skipping observability wiring");
    return undefined;
  }
  const requestContextKeys = [
    ...(options?.requestContextKeys ?? TRACE_REQUEST_CONTEXT_KEYS),
  ];
  log.info("MLflow observability resolved", {
    trackingUri: resolved.trackingUri,
    experimentId: resolved.experimentId,
    requestContextKeys,
  });

  const otelExporter = new OtelExporter({
    provider: {
      custom: {
        endpoint: resolved.trackingUri,
        protocol: "http/protobuf",
        headers: {
          "x-mlflow-experiment-id": resolved.experimentId,
        },
      },
    },
  });

  const serviceName = [
    await projectUtils.name(),
    httpUtils.toURL(resolved.trackingUri)?.hostname,
  ]
    .filter(Boolean)
    .join("_");

  return new Observability({
    configs: {
      mlflow: {
        serviceName,
        exporters: [otelExporter],
        requestContextKeys,
      },
    },
  });
}

async function resolveMlflowConfig(
  config?: Partial<MlflowConfig>,
): Promise<MlflowConfig | undefined> {
  let trackingUri = config?.trackingUri ?? process.env.MLFLOW_TRACKING_URI;
  let experimentId = config?.experimentId ?? process.env.MLFLOW_EXPERIMENT_ID;

  if (trackingUri && experimentId) {
    return { trackingUri, experimentId };
  }

  let client: WorkspaceClient;
  try {
    client = getExecutionContext().client;
  } catch (err) {
    log.warn("No execution context; cannot resolve MLflow defaults", { err });
    return undefined;
  }

  if (!trackingUri) {
    const host = (await client.config.getHost()).toString();
    if (!host) return undefined;
    trackingUri = host;
  }

  if (!experimentId) {
    const lookup =
      process.env.MLFLOW_EXPERIMENT_NAME ?? (await projectUtils.name());
    if (!lookup) return undefined;
    const experiment = await resolveExperiment(client, lookup);
    if (!experiment?.experiment_id) return undefined;
    experimentId = experiment.experiment_id;
  }

  return { trackingUri, experimentId };
}

/**
 * Resolve a Databricks MLflow experiment for a bare name, workspace path,
 * or numeric id. Bare names are expanded into the current user's
 * workspace path and the shared workspace path before lookup. When no
 * candidate exists, the experiment is auto-created at the user path
 * (or the original path when already qualified) so traces never get
 * dropped on the floor.
 */
async function resolveExperiment(
  client: WorkspaceClient,
  lookup: string,
): Promise<ExperimentLike | undefined> {
  const candidates: string[] = [lookup];
  let userName: string | undefined;
  const isQualified =
    lookup.startsWith(USERS_PATH) || lookup.startsWith(SHARED_PATH);
  if (!isQualified) {
    try {
      userName = (await client.currentUser.me()).userName ?? undefined;
    } catch (err) {
      log.warn("Could not resolve current user for experiment lookup", { err });
    }
    if (userName) candidates.push(`${USERS_PATH}${userName}/${lookup}`);
    candidates.push(`${SHARED_PATH}${lookup}`);
  }

  for (const candidate of candidates) {
    const existing = await getExperiment(client, candidate);
    if (existing?.experiment_id) {
      log.debug("Resolved MLflow experiment", {
        lookup,
        candidate,
        experimentId: existing.experiment_id,
      });
      return existing;
    }
  }

  const createPath = isQualified
    ? lookup
    : userName
      ? `${USERS_PATH}${userName}/${lookup}`
      : `${SHARED_PATH}${lookup}`;
  try {
    const created = await client.experiments.createExperiment({
      name: createPath,
    });
    if (created.experiment_id) {
      log.info("Created MLflow experiment", {
        path: createPath,
        experimentId: created.experiment_id,
      });
      return { experiment_id: created.experiment_id, name: createPath };
    }
  } catch (err) {
    log.warn("Failed to create MLflow experiment", { path: createPath, err });
  }
  return undefined;
}

/**
 * Single-candidate lookup: tries the numeric id path when the lookup
 * looks like a digit string, then falls back to lookup by name. Both
 * branches swallow "not found" so the caller can iterate candidates.
 */
async function getExperiment(
  client: WorkspaceClient,
  lookup: string,
): Promise<ExperimentLike | undefined> {
  if (/^\d+$/.test(lookup)) {
    try {
      const resp = await client.experiments.getExperiment({
        experiment_id: lookup,
      });
      return resp.experiment;
    } catch {
      /* fall through to name lookup */
    }
  }
  try {
    const resp = await client.experiments.getByName({
      experiment_name: lookup,
    });
    return resp.experiment;
  } catch {
    return undefined;
  }
}
