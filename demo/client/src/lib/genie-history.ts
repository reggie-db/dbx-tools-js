import type { UIMessage } from "ai";
import type { ToolEvent, ToolProgress } from "@/components/chat-view";

// Walks a page of loaded `UIMessage`s and rebuilds the in-memory
// `ToolEvent` records that would have been collected during a live
// `agent.stream` call. Lets `<AssistantBubble>` render Genie's
// suggested-question buttons after a hard reload, since the
// streamed `tool-output` chunks themselves are gone but the final
// tool-result is persisted in the message history (the `output`
// of the `tool-${name}` part).
//
// Note: SQL pills and charts are deliberately not replayed on
// reload. Both ride writer events (`kind: "sql"` and `kind: "chart"`)
// that aren't part of the LLM-bound tool result, so after a reload
// only the durable bits (genie's answer prose, suggested follow-up
// questions) come back. This is intentional - it keeps the
// LLM-bound payload minimal and avoids persisting transient UI
// chrome.

/**
 * Shape of the Genie tool's persisted DrainResult, mirrored from
 * `packages/appkit-mastra/src/genie.ts`. The `datasets` array is metadata
 * only (chartId, title, columns, rowCount, sql); row data rides
 * writer events that aren't persisted, so charts don't replay
 * after a hard reload.
 */
type PersistedGenieResult = {
  conversationId?: string;
  genieAnswer?: string;
  datasets?: Array<{
    chartId: string;
    title?: string;
    description?: string;
    columns?: string[];
    rowCount?: number;
    sql?: string;
  }>;
  suggestedFollowUps?: string[];
  error?: string;
};

/**
 * True when `value` looks like the Genie tool's persisted DrainResult.
 * We use a structural check rather than matching on tool name because
 * Mastra mints per-space variants (`tool-genie-<alias>`) plus
 * `genie_get_conversation`, and the shared shape is what matters.
 */
const isGenieResult = (value: unknown): value is PersistedGenieResult => {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.conversationId === "string" ||
    typeof v.genieAnswer === "string" ||
    Array.isArray(v.datasets) ||
    Array.isArray(v.suggestedFollowUps)
  );
};

/**
 * Walk a tool-invocation UI part and emit the same progress events
 * that `drainGenieStream` would have published live. Order mirrors
 * the streaming case so `collectSuggestions` produces identical
 * output for replayed turns.
 *
 * Live-only events (`started`, `status`, `sql`, `text`, `chart`) are
 * deliberately skipped - they ride writer events that aren't in the
 * persisted LLM-bound payload. Only the durable bits replay.
 */
const buildProgress = (output: PersistedGenieResult): ToolProgress[] => {
  const progress: ToolProgress[] = [];
  if (output.suggestedFollowUps && output.suggestedFollowUps.length > 0) {
    progress.push({ kind: "suggested", questions: output.suggestedFollowUps });
  }
  if (output.error) {
    progress.push({ kind: "error", error: output.error });
  }
  return progress;
};

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
        if (!isGenieResult(output)) continue;
        events.push({
          id: toolCallId,
          toolName,
          status: "done",
          progress: buildProgress(output),
        });
      } else if (state === "output-error") {
        const errorText = (part as { errorText?: unknown }).errorText;
        events.push({
          id: toolCallId,
          toolName,
          status: "error",
          ...(typeof errorText === "string" && errorText
            ? { progress: [{ kind: "error", error: errorText }] }
            : {}),
        });
      }
    }
    if (events.length > 0) out[message.id] = events;
  }
  return out;
};
