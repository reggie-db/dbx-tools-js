import type { ToolProgressPhase } from "@dbx-tools/appkit-genie-shared";

// UI-internal types. Wire-format types live in
// @dbx-tools/appkit-genie-shared so the server and UI share one definition.

/** A single tool-progress label appended to a running tool call. */
export interface ToolStatusUpdate {
  phase: ToolProgressPhase;
  label: string;
  ts: number;
}

/** A single tool invocation captured during an assistant turn. */
export interface ToolCall {
  callId: string;
  name: string;
  args: string;
  output?: string;
  status: "running" | "done" | "error";
  statusUpdates: ToolStatusUpdate[];
}

/** A single chat turn (user or assistant) rendered in the message list. */
export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls: ToolCall[];
  status: "streaming" | "done" | "error";
  errorText?: string;
}
