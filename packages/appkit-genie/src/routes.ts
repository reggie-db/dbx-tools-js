import type express from "express";
import type { ToolProgressBus } from "./progress-bus.js";

// Sent every `HEARTBEAT_MS` so dev-server proxies / browsers don't tear the
// idle stream down between long-running tool calls.
const HEARTBEAT_MS = 25_000;

// Matches AppKit's RouteConfig.handler signature (two-arg, returns Promise).
type RouteHandler = (
  req: express.Request,
  res: express.Response,
) => Promise<void>;

export function progressSseHandler(bus: ToolProgressBus): RouteHandler {
  return async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    res.write(`: connected ${new Date().toISOString()}\n\n`);

    const unsubscribe = bus.subscribe((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    const heartbeat = setInterval(() => {
      res.write(`: hb ${Date.now()}\n\n`);
    }, HEARTBEAT_MS);

    // Keep the promise pending until the client disconnects so AppKit's route
    // runner doesn't treat handler return as "response complete".
    await new Promise<void>((resolve) => {
      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        resolve();
      };
      req.on("close", cleanup);
      res.on("close", cleanup);
    });
  };
}
