import { describe, expect, it } from "bun:test";

import type { MastraWriter } from "@dbx-tools/appkit-mastra-shared";
import type { logUtils } from "@dbx-tools/shared";

import { safeWrite } from "../src/writer.js";

/** A logger that records every call so assertions can inspect them. */
function recordingLogger(): logUtils.Logger & {
  calls: Array<{ level: string; message: string; attrs?: Record<string, unknown> }>;
} {
  const calls: Array<{
    level: string;
    message: string;
    attrs?: Record<string, unknown>;
  }> = [];
  const record =
    (level: string) => (message: string, attrs?: Record<string, unknown>) =>
      void calls.push({ level, message, attrs });
  return {
    calls,
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
}

describe("safeWrite", () => {
  it("no-ops (debug) when the writer is undefined", async () => {
    const log = recordingLogger();
    await safeWrite(log, undefined, { type: "x" }, { chartId: "c1" });
    expect(log.calls).toEqual([
      { level: "debug", message: "writer:no-writer", attrs: { chartId: "c1" } },
    ]);
  });

  it("writes the chunk and logs debug on success", async () => {
    const log = recordingLogger();
    const written: unknown[] = [];
    const writer: MastraWriter = { write: (chunk) => void written.push(chunk) };
    const chunk = { type: "event" };
    await safeWrite(log, writer, chunk, { messageId: "m1" });
    expect(written).toEqual([chunk]);
    expect(log.calls).toEqual([
      { level: "debug", message: "writer:ok", attrs: { messageId: "m1" } },
    ]);
  });

  it("swallows a synchronous throw and logs warn with the error message", async () => {
    const log = recordingLogger();
    const writer: MastraWriter = {
      write: () => {
        throw new Error("stream closed");
      },
    };
    await safeWrite(log, writer, {}, { chartId: "c2" });
    expect(log.calls).toEqual([
      {
        level: "warn",
        message: "writer:error",
        attrs: { chartId: "c2", error: "stream closed" },
      },
    ]);
  });

  it("swallows a rejected promise and logs warn", async () => {
    const log = recordingLogger();
    const writer: MastraWriter = {
      write: () => Promise.reject(new Error("downstream gone")),
    };
    await safeWrite(log, writer, {});
    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]).toMatchObject({
      level: "warn",
      message: "writer:error",
      attrs: { error: "downstream gone" },
    });
  });
});
