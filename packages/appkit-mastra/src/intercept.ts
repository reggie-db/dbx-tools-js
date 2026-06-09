/**
 * Server-side Server-Sent-Events frame interceptor for the native
 * Mastra agent `/stream` endpoint.
 *
 * The Mastra stream (`@mastra/express`) emits one `data: <json>\n\n`
 * SSE frame per chunk, where the decoded JSON carries a
 * discriminating `type` (`text-delta`, `reasoning-delta`,
 * `tool-call`, `step-finish`, ...) and is terminated by a
 * `data: [DONE]` sentinel. {@link installStreamEventInterceptor} wraps
 * an Express response and runs a caller-supplied
 * {@link StreamFrameInterceptor} over each decoded frame so the caller
 * can keep, rewrite, or drop it; every non-`data:` byte (SSE
 * keep-alive comments, the `[DONE]` sentinel, blank padding) passes
 * through verbatim.
 *
 * The wrap is inert unless the response turns out to be a streamed
 * `200 text/event-stream` body, so non-streaming JSON routes and
 * error responses are never touched.
 */

import { StringDecoder } from "node:string_decoder";

import type express from "express";

/** SSE event separator used by the Mastra stream wire format. */
const FRAME_DELIMITER = "\n\n";

/**
 * Matches a whole SSE frame whose `data:` payload is a JSON object,
 * capturing it in three parts: the `data:` field prefix (including
 * whatever inter-token whitespace the producer used), the JSON object
 * body, and any trailing whitespace. Anchored end-to-end so it only
 * matches a single self-contained object frame; anything else (SSE
 * comments, the `[DONE]` sentinel, text/array payloads) fails the
 * match and is forwarded verbatim without a parse attempt. On rewrite
 * the captured prefix/suffix are re-emitted as-is so only the body
 * changes.
 */
const DATA_OBJECT_RE = /^(data:\s*)(\{[\s\S]*\})(\s*)$/;

/**
 * Per-frame interceptor invoked with the `JSON.parse`d object of every
 * `data: {json}` frame on the Mastra `/stream` response. The return
 * value decides the frame's fate:
 *
 * - `true`: forward the frame's original bytes unchanged (no
 *   re-serialization).
 * - `false`: drop the frame entirely.
 * - `{ replace }`: re-emit the frame with the original `data:` prefix
 *   and trailing whitespace preserved and only the JSON body replaced
 *   by `JSON.stringify(replace)`.
 */
export type StreamFrameInterceptor = (
  chunk: unknown,
) => { replace: unknown } | true | false;

/**
 * True when `res` is a `200 text/event-stream` body - the only
 * response shape we intercept. Content-type based so it tracks the
 * Mastra `/stream` route without hard-coding the path, and naturally
 * skips the JSON routes (history, models, charts, statements) and any
 * non-200 error response.
 */
function isEventStream(res: express.Response): boolean {
  if (res.statusCode !== 200) return false;
  const contentType = String(res.getHeader("content-type") ?? "").toLowerCase();
  return contentType.includes("text/event-stream");
}

/**
 * Run `interceptor` over a single SSE frame. Forwards anything that
 * isn't a parseable `data: {json}` object frame verbatim (comments,
 * the `[DONE]` sentinel, blank padding, unparseable / non-object
 * payloads) so the interceptor only ever sees real chunk objects.
 * Returns the frame string to emit, or `undefined` to drop the frame.
 */
function interceptFrame(
  frame: string,
  interceptor: StreamFrameInterceptor,
): string | undefined {
  const match = DATA_OBJECT_RE.exec(frame);
  if (!match) return frame;
  const [, prefix, body, suffix] = match;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body!);
  } catch {
    // Forward unparseable payloads untouched - feeding a partial /
    // malformed frame to the interceptor risks corrupting bytes the
    // client could still have handled.
    return frame;
  }
  const result = interceptor(parsed);
  if (result === true) return frame;
  if (result === false) return undefined;
  // Preserve the exact captured prefix/suffix so only the JSON body
  // changes; the framing the client parses stays byte-identical.
  return `${prefix}${JSON.stringify(result.replace)}${suffix}`;
}

/**
 * Wrap `res.write` / `res.end` so each SSE frame on a streamed Mastra
 * response is run through `interceptor` (keep / rewrite / drop).
 *
 * Interception only engages once the response is confirmed to be a
 * `200 text/event-stream` body (decided lazily on the first write,
 * after the handler has set status + content-type); any other
 * response streams through unchanged. A {@link StringDecoder}
 * reassembles multi-byte UTF-8 sequences that straddle chunk
 * boundaries, and a running buffer holds the trailing partial frame
 * until its `\n\n` arrives.
 */
export function installStreamEventInterceptor(
  res: express.Response,
  interceptor: StreamFrameInterceptor,
): void {
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  const decoder = new StringDecoder("utf8");
  let engaged: boolean | undefined;
  let buffer = "";

  // Append decoded text, emit every whole `\n\n`-delimited frame the
  // interceptor keeps, and retain any trailing partial frame in
  // `buffer`. On `final`, the residual buffer is flushed as the last
  // frame so a stream that doesn't end on a delimiter isn't dropped.
  const intercept = (text: string, final: boolean): string => {
    buffer += text;

    const out: string[] = [];

    let idx: number;
    while ((idx = buffer.indexOf(FRAME_DELIMITER)) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + FRAME_DELIMITER.length);

      const kept = interceptFrame(frame, interceptor);
      if (kept !== undefined) {
        out.push(kept, FRAME_DELIMITER);
      }
    }

    if (final && buffer.length > 0) {
      const kept = interceptFrame(buffer, interceptor);
      if (kept !== undefined) out.push(kept);
      buffer = "";
    }

    return out.length === 0 ? "" : out.join("");
  };

  const toText = (chunk: unknown): string => {
    if (typeof chunk === "string") return chunk;
    if (Buffer.isBuffer(chunk)) return decoder.write(chunk);
    if (chunk instanceof Uint8Array) {
      return decoder.write(
        Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      );
    }
    return "";
  };

  res.write = function patchedWrite(
    chunk: unknown,
    encodingOrCb?: BufferEncoding | ((error?: Error | null) => void),
    cb?: (error?: Error | null) => void,
  ): boolean {
    if (engaged === undefined) engaged = isEventStream(res);
    if (!engaged) {
      return origWrite(chunk as never, encodingOrCb as never, cb as never);
    }
    const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
    const out = intercept(toText(chunk), false);
    if (out.length === 0) {
      // The chunk only advanced a partial frame; nothing to forward
      // yet. Honor the write callback so backpressure-aware writers
      // don't stall waiting on an ack that never comes.
      if (callback) queueMicrotask(() => callback());
      return true;
    }
    return origWrite(out, callback as never);
  } as typeof res.write;

  res.end = function patchedEnd(
    chunk?: unknown | (() => void),
    encodingOrCb?: BufferEncoding | (() => void),
    cb?: () => void,
  ): express.Response {
    if (engaged === undefined) engaged = isEventStream(res);
    if (!engaged) {
      return origEnd(chunk as never, encodingOrCb as never, cb as never);
    }
    const callback =
      typeof chunk === "function"
        ? chunk
        : typeof encodingOrCb === "function"
          ? encodingOrCb
          : cb;
    const text =
      (typeof chunk !== "function" && chunk !== undefined ? toText(chunk) : "") +
      decoder.end();
    const out = intercept(text, true);
    if (out.length > 0) origWrite(out);
    return origEnd(callback as never);
  } as typeof res.end;
}
