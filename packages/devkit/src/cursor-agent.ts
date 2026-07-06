/**
 * Run the Cursor CLI (`cursor-agent`) in headless print mode with
 * streamed NDJSON output. Uses `--output-format stream-json` and
 * `--stream-partial-output` so assistant text is echoed as it arrives
 * instead of buffering until the run finishes (which `--output-format
 * text` does).
 */

/** Default wall-clock budget for a `cursor-agent` invocation. */
export const CURSOR_AGENT_DEFAULT_TIMEOUT_MS = 300_000;

/** Options for {@link runCursorAgent}. */
export interface CursorAgentOptions {
  /** Wall-clock budget in milliseconds. */
  timeoutMs?: number;
  /** Stream assistant text here as it arrives. Defaults to `process.stdout`. */
  stdout?: NodeJS.WriteStream;
  /** Echo subprocess stderr here live. Defaults to `process.stderr`. */
  stderr?: NodeJS.WriteStream;
}

/** Outcome of {@link runCursorAgent}. */
export interface CursorAgentResult {
  /** Trimmed final assistant answer. */
  text: string;
  /** Subprocess exit code. */
  exitCode: number;
  /** Captured stderr (also echoed live when a sink is configured). */
  stderr: string;
}

/** One NDJSON event from `cursor-agent --output-format stream-json`. */
interface CursorStreamEvent {
  type?: string;
  subtype?: string;
  result?: string;
  message?: { content?: Array<{ type?: string; text?: string }> };
}

/** Whether `cursor-agent` is available on `PATH`. */
export function cursorAgentAvailable(): boolean {
  return Boolean(Bun.which("cursor-agent"));
}

/** Whether an exit code looks like the process was killed on a timeout. */
export function cursorAgentTimedOut(exitCode: number): boolean {
  return exitCode === 143 || exitCode === 137;
}

/**
 * Run `cursor-agent -p` with streaming output. Throws when the CLI is
 * absent, the subprocess errors before exit, or the abort signal fires
 * (timeout). On a non-zero exit the result is still returned so callers
 * can use partial text or inspect `exitCode` / `stderr`.
 */
export async function runCursorAgent(
  prompt: string,
  opts: CursorAgentOptions = {},
): Promise<CursorAgentResult> {
  if (!cursorAgentAvailable()) {
    throw new Error("cursor-agent: CLI not found on PATH");
  }

  const timeoutMs = opts.timeoutMs ?? CURSOR_AGENT_DEFAULT_TIMEOUT_MS;
  const outSink = opts.stdout ?? process.stdout;
  const errSink = opts.stderr ?? process.stderr;

  const proc = Bun.spawn(
    [
      "cursor-agent",
      "-p",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--force",
      prompt,
    ],
    { stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(timeoutMs) },
  );

  const [text, stderr] = await Promise.all([
    readCursorAgentStdout(proc.stdout, outSink),
    drainStreamToConsole(proc.stderr, errSink),
  ]);
  const exitCode = await proc.exited;

  if (text.length > 0) outSink.write("\n");
  if (stderr.length > 0) errSink.write("\n");

  return { text: text.trim(), exitCode, stderr: stderr.trim() };
}

/**
 * Read a spawned process stream to a sink as it arrives and return the
 * full decoded text.
 */
async function drainStreamToConsole(
  stream: ReadableStream<Uint8Array> | undefined,
  sink: NodeJS.WriteStream,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.length) continue;
    sink.write(value);
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** Pull assistant prose out of a stream-json event. */
function cursorAssistantText(event: CursorStreamEvent): string {
  const parts = event.message?.content;
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text!)
    .join("");
}

/**
 * Print an assistant chunk from `cursor-agent --stream-partial-output`.
 * Events may be incremental deltas (`" world"`) or cumulative snapshots
 * (`"hello world"`); only the not-yet-printed suffix is written.
 */
function printCursorAssistantChunk(
  chunk: string,
  printed: { text: string },
  sink: NodeJS.WriteStream,
): void {
  if (!chunk) return;
  if (chunk.startsWith(printed.text)) {
    const delta = chunk.slice(printed.text.length);
    if (delta) sink.write(delta);
    printed.text = chunk;
    return;
  }
  sink.write(chunk);
  printed.text += chunk;
}

/**
 * Read `cursor-agent` NDJSON stdout, streaming assistant text to `sink`.
 * Returns the final answer from the `result` event, or the accumulated
 * assistant text when that event is missing.
 */
async function readCursorAgentStdout(
  stream: ReadableStream<Uint8Array> | undefined,
  sink: NodeJS.WriteStream,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult = "";
  const printed = { text: "" };

  const handleLine = (line: string): void => {
    if (!line) return;
    try {
      const event = JSON.parse(line) as CursorStreamEvent;
      if (event.type === "assistant") {
        printCursorAssistantChunk(cursorAssistantText(event), printed, sink);
      } else if (
        event.type === "result" &&
        event.subtype === "success" &&
        typeof event.result === "string"
      ) {
        finalResult = event.result;
      }
    } catch {
      // Ignore malformed lines; stderr may carry the real error.
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      handleLine(buffer.slice(0, newline).trim());
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }

  handleLine(buffer.trim());
  return (finalResult || printed.text).trim();
}
