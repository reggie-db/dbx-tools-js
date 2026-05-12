// Wire-format types shared between @reggie-db/dbx-tools-appkit (server) and
// @reggie-db/dbx-tools-appkit-ui (React). This package is pure types: no
// runtime dependencies, no Node-only imports, safe for browser bundles.

/** Lifecycle phase reported by tool-progress events. */
export type ToolProgressPhase =
  | "started"
  | "status"
  | "query"
  | "completed"
  | "error";

/** Event broadcast on the in-process tool progress bus and over the SSE channel. */
export interface ToolProgressEvent {
  /** Logical tool name as seen by the chat client (e.g. `genie_store_intelligence`). */
  tool: string;
  /** Free-form lifecycle phase. */
  phase: ToolProgressPhase;
  /** Short human-readable label rendered in the tool-call card. */
  label: string;
  /** Optional structured detail (e.g. SQL, status string from Genie). */
  detail?: unknown;
  /** Epoch millis stamped by the publisher. */
  ts: number;
}
