/** One chunk from a Mastra agent SSE stream (`data: { type, payload, ... }`). */
export interface MastraStreamChunk {
  type: string;
  payload?: unknown;
  runId?: string;
}

/** Response from agent streaming endpoints with {@link processMastraStream}. */
export type MastraStreamResponse = Response & {
  processDataStream: (options: {
    onChunk: (chunk: MastraStreamChunk) => void | Promise<void>;
  }) => Promise<void>;
};

/**
 * Parse Mastra agent SSE (`data: …` lines) and invoke `onChunk` per event.
 * Mirrors `@mastra/client-js`'s internal reader without the
 * `processChatResponse_vNext` side channel that throws when a resumed
 * `approve-tool-call` stream emits `tool-result` without a new `tool-call`.
 */
export async function processMastraStream(options: {
  stream: ReadableStream<Uint8Array>;
  onChunk: (chunk: MastraStreamChunk) => void | Promise<void>;
  signal?: AbortSignal;
}): Promise<void> {
  const reader = options.stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const abort = () => void reader.cancel();
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") return;
        let json: MastraStreamChunk;
        try {
          json = JSON.parse(data) as MastraStreamChunk;
        } catch {
          continue;
        }
        if (json) await options.onChunk(json);
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

/** Attach {@link processMastraStream} to a fetch `Response`. */
export function asMastraStreamResponse(response: Response): MastraStreamResponse {
  const streamResponse = response as MastraStreamResponse;
  streamResponse.processDataStream = async ({ onChunk }) => {
    if (!response.body) throw new Error("No response body");
    await processMastraStream({ stream: response.body, onChunk });
  };
  return streamResponse;
}
