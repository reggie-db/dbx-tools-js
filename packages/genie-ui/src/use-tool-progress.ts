import type { ToolProgressEvent } from "@dbx-tools/appkit-genie-shared";
import { useEffect, useRef } from "react";

// Subscribes to the dbx-tools tool-progress SSE channel and dispatches each
// parsed event to the supplied handler. The handler is held in a ref so a
// caller passing an inline arrow does not restart the SSE connection on every
// render; only `url` and `enabled` trigger reconnects.

export interface UseToolProgressOptions {
  /** SSE endpoint URL. Default `"/api/dbx-tools/tool-progress"`. */
  url?: string;
  /** Whether the subscription is active. Default `true`. */
  enabled?: boolean;
  /** Called for each parsed `ToolProgressEvent`. */
  onEvent: (event: ToolProgressEvent) => void;
}

export function useToolProgress({
  url = "/api/dbx-tools/tool-progress",
  enabled = true,
  onEvent,
}: UseToolProgressOptions): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource(url);
    source.onmessage = (msg) => {
      let payload: ToolProgressEvent;
      try {
        payload = JSON.parse(msg.data) as ToolProgressEvent;
      } catch {
        return;
      }
      if (!payload || typeof payload.tool !== "string") return;
      try {
        onEventRef.current(payload);
      } catch {
        /* consumer-supplied callback errors must not kill the stream */
      }
    };
    return () => source.close();
  }, [url, enabled]);
}
