/**
 * Mastra input processor that strips `chartId` fields from every
 * tool-invocation result in prior assistant messages before they
 * reach the model.
 *
 * Why: chartIds are only meaningful within the assistant turn that
 * minted them - the writer events backing them are gone after the
 * stream closes. When the model sees old chartIds in memory recall
 * (Mastra Memory persists tool results), it's tempted to type
 * those ids into the new turn's `[[chart:<id>]]` markers, leaving
 * the chat client's chart slots stuck with no matching event. This
 * processor removes the temptation by deleting `chartId` keys from
 * every assistant message's tool results before the prompt is
 * built. The current turn's tool results don't exist yet at
 * `processInput` time, so they pass through unmodified.
 *
 * The strip is recursive - any nested `chartId` field is removed,
 * regardless of which tool produced the result. This covers Genie's
 * `datasets[].chartId` and `render_data`'s top-level `chartId`
 * uniformly without coupling to specific tool ids.
 */

import { logUtils } from "@dbx-tools/appkit-shared";
import type {
  InputProcessor,
  ProcessInputArgs,
} from "@mastra/core/processors";

const log = logUtils.logger("mastra/processor/strip-stale-charts");

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
 * Input processor that scrubs `chartId` from every tool-invocation
 * result in the message list. Wired onto every agent by default
 * via {@link buildAgents}; opt out with
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
        if (
          (part as { type?: unknown }).type !== "tool-invocation"
        ) {
          continue;
        }
        const inv = (part as { toolInvocation?: { result?: unknown } })
          .toolInvocation;
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
