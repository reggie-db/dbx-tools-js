import type { UIMessage } from "ai";
import {
  genieResultToWriterEvents,
  isGenieAgentResult,
} from "@dbx-tools/appkit-mastra-shared";
import type { ToolEvent } from "@/components/chat-view";

// Walks a page of loaded `UIMessage`s and rebuilds the in-memory
// `ToolEvent` records that would have been collected during a live
// `agent.stream` call. Lets `<AssistantBubble>` render Genie's
// terminal state (error frames) after a hard reload by extracting
// it out of the persisted tool-result (the `output` of the
// `tool-${name}` part) - the same path the live `tool-result`
// handler in `Stream.tsx` uses, via the shared translator in
// `@dbx-tools/appkit-mastra-shared`.
//
// Live-only events (`started`, `status`, `sql`, `text`,
// `suggested`, `chart`) ride writer events that aren't
// persisted; they're gone after a reload. Charts intentionally
// do NOT replay: the resolved Echarts spec is held off-band on
// the per-request `RequestContext` (and the live writer event),
// not on the persisted summary, so the chart `option` isn't
// available after the request closes. Stale `[[chart:<id>]]`
// markers in the persisted assistant text are silently dropped
// by `<MarkdownWithCharts>` on re-render.

/**
 * Pull the tool name out of a part. `tool-${name}` parts encode it
 * in the type discriminator; `dynamic-tool` parts carry it on the
 * part itself. Returns null for non-tool parts so callers can skip.
 */
const readToolName = (part: UIMessage["parts"][number]): string | null => {
  const type = (part as { type?: unknown }).type;
  if (typeof type !== "string") return null;
  if (type === "dynamic-tool") {
    const name = (part as { toolName?: unknown }).toolName;
    return typeof name === "string" ? name : null;
  }
  if (type.startsWith("tool-")) return type.slice("tool-".length);
  return null;
};

/**
 * Reconstruct the `toolEventsByMessage` entries the live stream would
 * have produced for `messages`. Skips non-Genie tools (their outputs
 * don't carry the Genie shape) and skips parts whose state isn't
 * `output-available` / `output-error`, since only those carry enough
 * detail to render anything useful.
 *
 * Returns an empty object when no Genie tool calls are found, so the
 * caller can spread it into existing state without filtering.
 */
export const synthesizeToolEventsFromHistory = (
  messages: UIMessage[],
): Record<string, ToolEvent[]> => {
  const out: Record<string, ToolEvent[]> = {};
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const events: ToolEvent[] = [];
    for (const part of message.parts ?? []) {
      const toolName = readToolName(part);
      if (!toolName) continue;
      const state = (part as { state?: unknown }).state;
      const toolCallId = (part as { toolCallId?: unknown }).toolCallId;
      if (typeof toolCallId !== "string") continue;
      if (state === "output-available") {
        const output = (part as { output?: unknown }).output;
        if (!isGenieAgentResult(output)) continue;
        events.push({
          id: toolCallId,
          toolName,
          status: "done",
          progress: genieResultToWriterEvents(output),
        });
      } else if (state === "output-error") {
        const errorText = (part as { errorText?: unknown }).errorText;
        events.push({
          id: toolCallId,
          toolName,
          status: "error",
          ...(typeof errorText === "string" && errorText
            ? { progress: [{ type: "error", error: errorText }] }
            : {}),
        });
      }
    }
    if (events.length > 0) out[message.id] = events;
  }
  return out;
};
