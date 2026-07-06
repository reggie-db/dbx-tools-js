import { describe, expect, test } from "bun:test";
import { buildObservability, isOtlpTracingConfigured } from "../src/observability.js";

describe("isOtlpTracingConfigured", () => {
  test("false when neither OTLP env var is set", () => {
    const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const traces = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    try {
      expect(isOtlpTracingConfigured()).toBe(false);
    } finally {
      if (base) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = base;
      else delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      if (traces) process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = traces;
      else delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    }
  });
});

describe("buildObservability", () => {
  test("returns undefined when OTLP endpoint is unset (auto mode)", async () => {
    const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const traces = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    try {
      expect(await buildObservability()).toBeUndefined();
    } finally {
      if (base) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = base;
      else delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      if (traces) process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = traces;
      else delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    }
  });

  test("returns undefined when explicitly disabled", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    try {
      expect(await buildObservability({ enabled: false })).toBeUndefined();
    } finally {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    }
  });
});
