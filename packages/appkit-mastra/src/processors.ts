/**
 * Mastra stream processors wired onto the plugin's agents.
 *
 * Two complementary processors live here:
 *
 * - An **input** processor ({@link stripStaleChartsProcessor}) that
 *   scrubs turn-scoped `chartId` fields out of prior tool results
 *   replayed from Memory, so the model can't copy a stale id into the
 *   new turn's `[chart:<id>]` markers.
 * - An **output** processor ({@link ResultProcessor}) that trims the
 *   bulky, redundant payload fields off targeted outbound stream frames
 *   before they're serialized to the SSE client.
 */

import { logUtils } from "@dbx-tools/shared";
import type {
  InputProcessor,
  ProcessInputArgs,
  Processor,
} from "@mastra/core/processors";

const log = logUtils.logger("mastra/processors");

/**
 * Recursively clone `value`, omitting any property whose key is
 * `chartId`. Arrays are mapped element-wise; primitives are
 * returned as-is. The result is structurally identical to the
 * input minus chartIds, so downstream message-shape consumers
 * keep working.
 */
function stripChartIds(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripChartIds);
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      if (key === "chartId") continue;
      out[key] = stripChartIds(val);
    }
    return out;
  }
  return value;
}

/**
 * Mastra input processor that strips `chartId` fields from every
 * tool-invocation result in prior assistant messages before they
 * reach the model.
 *
 * Why: chartIds are turn-scoped from the model's point of view -
 * each `prepare_chart` / `render_data` call mints a fresh id and
 * the host UI binds it to that turn's reply. Mastra Memory
 * replays prior tool results into the prompt; if old chartIds
 * leak through, the model is tempted to copy them verbatim into
 * the new turn's `[chart:<id>]` markers and the host UI ends up
 * rendering an unrelated chart from the chart cache (or
 * a 404 once the 1h TTL elapsed). This processor removes the
 * temptation by deleting `chartId` keys from every assistant
 * message's tool results before the prompt is built. The current
 * turn's tool results don't exist yet at `processInput` time, so
 * they pass through unmodified.
 *
 * The strip is recursive - any nested `chartId` field is removed,
 * regardless of which tool produced the result. This covers
 * `prepare_chart` / `render_data` top-level chartIds and any
 * legacy `datasets[].chartId` payloads uniformly without coupling
 * to specific tool ids.
 *
 * Wired onto every agent by default via `buildAgents`; opt out with
 * `MastraPluginConfig.stripStaleCharts: false`.
 */
export const stripStaleChartsProcessor: InputProcessor = {
  id: "strip-stale-charts",
  description:
    "Removes chartId fields from prior tool-invocation results so the model can't reuse turn-scoped ids from memory.",
  processInput(args: ProcessInputArgs) {
    let stripped = 0;
    for (const message of args.messages) {
      if (message.role !== "assistant") continue;
      const parts = message.content?.parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        // Tool-invocation parts hold the persisted tool result.
        // We don't scrub the input args (`rawInput` / `args`) because
        // the chartId there is the model's outgoing claim, not
        // anything it could re-reference; only `result` carries
        // ids that subsequent turns might copy.
        if ((part as { type?: unknown }).type !== "tool-invocation") {
          continue;
        }
        const inv = (part as { toolInvocation?: { result?: unknown } }).toolInvocation;
        if (!inv || inv.result === undefined) continue;
        const before = inv.result;
        const after = stripChartIds(before);
        // Cheap structural check via JSON length - the actual
        // strip writes a fresh object only when chartId keys
        // existed, so different stringification length is a
        // reliable signal that something was removed.
        if (
          typeof before === "object" &&
          before !== null &&
          JSON.stringify(before).length !== JSON.stringify(after).length
        ) {
          inv.result = after;
          stripped += 1;
        }
      }
    }
    if (stripped > 0) {
      log.debug("stripped", { results: stripped });
    }
    return args.messages;
  },
};

/**
 * Mastra output processor that trims the bulky, redundant payload
 * fields off targeted outbound stream frames.
 *
 * Mastra emits step / finish / tool-result frames whose payloads
 * echo the full tool `output` / `result` / assistant `messages` /
 * `response` - data the chat client already received inline and
 * doesn't need re-sent. This processor empties those keys on the
 * targeted frame types so the outbound SSE stream stays lean;
 * every other frame passes through untouched.
 */
export class ResultProcessor implements Processor {
  id = "result-processor";

  // Tell Mastra to also route tool/data parts to this processor method
  processDataParts = true;

  async processOutputStream({ part }: { part: any }): Promise<any | null> {
    // 1. Guard clause: Ensure the chunk is a valid object
    if (!part || typeof part !== "object") {
      return part;
    }

    // 2. Filter for the targeted frame types
    const targetedTypes = ["step-finish", "finish", "tool-result", "data-tool-agent"];
    if (!targetedTypes.includes(part.type)) {
      return part; // Return unchanged to pass-through
    }

    // 3. Check for the presence of a payload object
    const payload = part.payload;
    if (!payload || typeof payload !== "object") {
      return part;
    }

    // 4. Safely delete the unwanted keys from the payload reference
    const keysToDelete = ["output", "messages", "response", "result"];
    for (const key of keysToDelete) {
      if (key in payload) {
        const value = payload[key];
        if (typeof value === "object") {
          payload[key] = {};
        } else if (Array.isArray(value)) {
          payload[key] = [];
        } else {
          delete payload[key];
        }
      }
    }

    // 5. Return the modified part object. Mastra handles re-serialization
    // for the outbound SSE client stream automatically.
    return part;
  }
}
