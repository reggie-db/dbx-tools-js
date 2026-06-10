/**
 * Mastra observability wired through the same OTel pipeline AppKit's
 * built-in plugins (e.g. `agents`) use, via `@mastra/otel-bridge`.
 *
 * How traces flow:
 *
 * 1. `@databricks/appkit` boots a global `NodeSDK` in
 *    `TelemetryManager.initialize()` (during `createApp`) when
 *    `OTEL_EXPORTER_OTLP_ENDPOINT` is set in the process env.
 * 2. Every AppKit plugin span (e.g. the `agents` plugin's
 *    `executeStream`) is created via the global OTel tracer
 *    (`trace.getTracer(<plugin>)`), so it lands on that NodeSDK and
 *    is shipped through its OTLP exporter.
 * 3. The Mastra `OtelBridge` ALSO creates real OTel spans on the same
 *    global tracer for every Mastra operation (agent runs, model
 *    calls, tool invocations, workflow steps). They inherit the
 *    ambient OTel context, so when Mastra is invoked from inside an
 *    AppKit HTTP span the trace stays connected.
 *
 * Net effect: Mastra spans get exactly the treatment AppKit's
 * `agents` plugin gets. No custom OTLP pipeline lives in this
 * package; the OTLP endpoint, headers, and resource attributes are
 * driven by the standard OTel env vars
 * (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`,
 * `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, ...) and consumed
 * by AppKit's `TelemetryManager`. Set those once and both AppKit and
 * Mastra spans end up at the same backend.
 *
 * When `OTEL_EXPORTER_OTLP_ENDPOINT` is unset the bridge's spans go
 * to the global noop tracer, mirroring how the `agents` plugin
 * silently no-ops in the same situation.
 */

import { logUtils, projectUtils } from "@dbx-tools/shared";
import { Observability } from "@mastra/observability";
import { OtelBridge } from "@mastra/otel-bridge";

import { TRACE_REQUEST_CONTEXT_KEYS } from "./config.js";

const log = logUtils.logger("mastra/observability");

const DEFAULT_SERVICE_NAME = "mastra";

export interface BuildObservabilityOptions {
  /**
   * Service name attached to the Mastra `Observability` config. Used
   * as the tracer scope name on bridged OTel spans (the `service.name`
   * resource attribute is owned by AppKit's `TelemetryManager` instead
   * - it reads `OTEL_SERVICE_NAME` / `DATABRICKS_APP_NAME` at
   * `createApp` time).
   *
   * Defaults to project name then `"mastra"`.
   */
  serviceName?: string;
  /**
   * `RequestContext` keys to extract as span metadata on every Mastra
   * trace. Defaults to {@link TRACE_REQUEST_CONTEXT_KEYS} (user id,
   * thread id, request id, environment, model override, ...).
   *
   * Supports dot notation for nested values per the Mastra docs.
   */
  requestContextKeys?: readonly string[];
}

/**
 * Build a Mastra `Observability` whose spans ride AppKit's global
 * OTel pipeline via `@mastra/otel-bridge`.
 *
 * Returns `undefined` only if someone explicitly opts out in the
 * future; today it always returns an `Observability` because the
 * bridge degrades gracefully (no-op tracer) when no global OTel SDK
 * is registered. Callers can spread `...(observability ? { observability } : {})`
 * either way to stay forward-compatible.
 */
export async function buildObservability(
  options?: BuildObservabilityOptions,
): Promise<Observability | undefined> {
  const serviceName =
    options?.serviceName ?? (await projectUtils.name()) ?? DEFAULT_SERVICE_NAME;
  const requestContextKeys = [
    ...(options?.requestContextKeys ?? TRACE_REQUEST_CONTEXT_KEYS),
  ];

  // The OTel HTTP exporter treats `OTEL_EXPORTER_OTLP_ENDPOINT` as a
  // *base* URL and appends the signal path itself (e.g.
  // `http://localhost:6006` -> `http://localhost:6006/v1/traces`). Log
  // the resolved POST URL so misconfigurations (e.g. accidentally
  // setting the base var to a `/v1/traces`-suffixed URL, which makes
  // the SDK POST to `.../v1/traces/v1/traces` and Phoenix 404s) are
  // obvious in startup output.
  const otelBase = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const otelTracesOverride = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const resolvedTracesUrl = otelTracesOverride
    ? otelTracesOverride
    : otelBase
      ? `${otelBase.replace(/\/+$/, "")}/v1/traces`
      : undefined;
  log.info("Mastra observability wired through OTel bridge", {
    serviceName,
    requestContextKeys,
    otelBase: otelBase ?? "<unset>",
    resolvedTracesUrl: resolvedTracesUrl ?? "<noop; OTLP endpoint unset>",
  });

  return new Observability({
    configs: {
      serviceName: {
        serviceName,
        bridge: new OtelBridge(),
        requestContextKeys,
      },
    },
  });
}
