import { EventEmitter } from "node:events";
import type {
  GenieEventLike,
  ToolProgressEvent,
  ToolProgressPhase,
} from "./types.js";

// In-process pub/sub used by long-running agent tools (the streaming Genie
// tool, primarily) to surface live progress to the chat UI. The agents
// plugin's chat SSE stream is owned by the runtime and tools cannot push
// custom events through it, so consumers mount a separate broadcast channel
// (this plugin's `/tool-progress` SSE route, or their own subscription via
// `subscribeToolProgress`).
//
// Single-process, single-channel — fine for typical AppKit deployments. For
// multi-user scoping the API would need to key by `threadId`; clients would
// pass their thread id when opening the SSE stream.

const CHANNEL = "progress";

export class ToolProgressBus {
  private readonly emitter: EventEmitter;

  constructor(maxListeners = 32) {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(maxListeners);
  }

  publish(event: Omit<ToolProgressEvent, "ts">): void {
    this.emitter.emit(CHANNEL, {
      ...event,
      ts: Date.now(),
    } satisfies ToolProgressEvent);
  }

  subscribe(handler: (event: ToolProgressEvent) => void): () => void {
    this.emitter.on(CHANNEL, handler);
    return () => this.emitter.off(CHANNEL, handler);
  }
}

// Stable label mapping for Genie's known status codes. Anything we haven't
// mapped falls through to a humanized version of the raw code (e.g.
// `FETCHING_METADATA` -> `Fetching metadata`).
const GENIE_STATUS_LABELS: Record<string, string> = {
  SUBMITTED: "Submitted to Genie",
  FETCHING_METADATA: "Fetching metadata",
  FILTERING_CONTEXT: "Filtering context",
  ASKING_AI: "Asking the model",
  PENDING_WAREHOUSE: "Waiting for warehouse",
  EXECUTING_QUERY: "Executing SQL",
  FETCHING_RESULT: "Fetching result rows",
  COMPLETED: "Genie completed",
  FAILED: "Genie failed",
  CANCELLED: "Genie cancelled",
};

function describeGenieStatus(status: string): string {
  if (GENIE_STATUS_LABELS[status]) return GENIE_STATUS_LABELS[status];
  return status
    .toLowerCase()
    .split("_")
    .map((part, idx) =>
      idx === 0 && part.length > 0
        ? part[0].toUpperCase() + part.slice(1)
        : part,
    )
    .join(" ");
}

/**
 * Translate a raw Genie SSE event into the short human label that gets
 * rendered live under a running tool-call card. Returning `null` skips
 * publishing for that event (e.g. `message_start` carries no user-meaningful
 * status by itself in some Genie versions).
 */
export function describeGenieEvent(event: GenieEventLike): {
  phase: ToolProgressPhase;
  label: string;
  detail?: unknown;
} | null {
  switch (event.type) {
    case "message_start":
      return { phase: "started", label: "Genie received the question" };
    case "status": {
      const status = event.status ?? "WORKING";
      return {
        phase: "status",
        label: describeGenieStatus(status),
        detail: status,
      };
    }
    case "query_result":
      return {
        phase: "query",
        label: "SQL ran, result rows returned",
        detail: {
          statementId: event.statementId,
          attachmentId: event.attachmentId,
        },
      };
    case "message_result":
      return {
        phase: "completed",
        label: "Genie answered",
        detail: event.message?.content,
      };
    case "error":
      return {
        phase: "error",
        label: event.error ?? "Genie error",
        detail: event.error,
      };
    default:
      return null;
  }
}
