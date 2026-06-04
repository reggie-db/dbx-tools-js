/**
 * Mastra observability wiring for the `@dbx-tools/appkit-phoenix`
 * sibling plugin.
 *
 * Mastra's `Observability` registry accepts any
 * `@mastra/observability` `BaseExporter`. We use `OtelExporter` from
 * `@mastra/otel-exporter` (Mastra's first-party OTLP shim) with the
 * `custom` provider pointed at Phoenix's local collector URL. No
 * Arize-specific wrapper is needed - Phoenix is a vanilla
 * OpenInference-compatible OTLP/HTTP receiver.
 *
 * Discovery is structural so this module doesn't depend on
 * `@dbx-tools/appkit-phoenix` at compile time: we look up the
 * registered plugin by its registered name (`"phoenix"`) and read its
 * `exports().collectorEndpoint()` if it is shaped like the phoenix
 * plugin. The phoenix package is therefore an *optional* sibling -
 * apps that don't install it just get an undefined observability
 * config and Mastra runs without OTLP export.
 */

import type { pluginUtils } from "@dbx-tools/appkit-shared";
import { Observability } from "@mastra/observability";
import { OtelExporter } from "@mastra/otel-exporter";

/** Plugin name the phoenix plugin registers under (matches `phoenix()`). */
const PHOENIX_PLUGIN_NAME = "phoenix";

/** Structural shape of the bits of `phoenix().exports()` we touch. */
interface PhoenixExportsLike {
  collectorEndpoint?(): string | undefined;
}

/** Structural shape of an AppKit plugin instance with `exports()`. */
interface PluginWithExports {
  exports?(): unknown;
}

/**
 * If the sibling `phoenix` plugin is registered AND has booted with a
 * usable collector URL, return a Mastra `Observability` configured to
 * stream traces + logs there. Otherwise return `undefined` so the
 * caller can omit the field on the `new Mastra({...})` constructor.
 *
 * The exporter uses `provider.custom` with `http/protobuf`, which is
 * what Phoenix's `/v1/traces` endpoint speaks natively. Switching
 * Phoenix to gRPC would be a one-line `protocol: "grpc"` change and
 * a different exported URL.
 */
export function buildPhoenixObservability(
  context: pluginUtils.PluginContextLike | undefined,
  serviceName: string,
): Observability | undefined {
  const endpoint = readPhoenixEndpoint(context);
  if (!endpoint) return undefined;

  return new Observability({
    configs: {
      phoenix: {
        serviceName,
        exporters: [
          new OtelExporter({
            provider: {
              custom: {
                endpoint,
                protocol: "http/protobuf",
              },
            },
          }),
        ],
      },
    },
  });
}

/**
 * Pull the OTLP collector URL out of the registered `phoenix` plugin.
 * Tolerant of the plugin being absent (returns `undefined`) and of a
 * future shape change in its exports (anything that's not a string
 * is ignored). The lookup is keyed off the registered plugin *name*
 * so this file does not depend on `@dbx-tools/appkit-phoenix`.
 */
function readPhoenixEndpoint(
  context: pluginUtils.PluginContextLike | undefined,
): string | undefined {
  if (!context) return undefined;
  const plugin = context.getPlugins().get(PHOENIX_PLUGIN_NAME) as
    | PluginWithExports
    | undefined;
  const exports_ = plugin?.exports?.() as PhoenixExportsLike | undefined;
  const url = exports_?.collectorEndpoint?.();
  return typeof url === "string" ? url : undefined;
}
