/**
 * Run the Cursor CLI (`cursor-agent`) headlessly via `devkit cursor` and
 * from release tooling that drafts notes programmatically.
 */

import { consola } from "consola";
import { sh } from "./shell.js";
import { errorMessage, fail } from "./script.js";

/** Default wall-clock budget for a `cursor-agent` invocation. */
export const CURSOR_AGENT_DEFAULT_TIMEOUT_MS = 300_000;

/** Options for {@link runCursorAgent}. */
export interface CursorAgentOptions {
  /** Wall-clock budget in milliseconds. */
  timeoutMs?: number;
  /** Working directory for the agent (defaults to `process.cwd()`). */
  cwd?: string;
  /**
   * When `true` (default), capture stdout via `sh({ quiet: true })` for
   * programmatic callers. When `false`, inherit stdio like a direct shell
   * invocation (`cursor-agent -p --trust …`).
   */
  capture?: boolean;
}

/** Outcome of {@link runCursorAgent}. */
export interface CursorAgentResult {
  /** Trimmed assistant answer from stdout. */
  text: string;
  /** Subprocess exit code. */
  exitCode: number;
  /** Trimmed stderr. */
  stderr: string;
}

/** Options for {@link cursor}. */
export interface CursorCommandOptions {
  /** Prompt passed to `cursor-agent`. */
  prompt: string;
  /** Wall-clock budget in milliseconds. */
  timeoutMs?: number;
}

/** Whether `cursor-agent` is available on `PATH`. */
export function cursorAgentAvailable(): boolean {
  return Boolean(Bun.which("cursor-agent"));
}

/** Whether an exit code looks like the process was killed on a timeout. */
export function cursorAgentTimedOut(exitCode: number): boolean {
  return exitCode === 143 || exitCode === 137;
}

/** argv for `cursor-agent -p --trust <prompt>`. */
function cursorAgentArgs(prompt: string): string[] {
  return ["cursor-agent", "-p", "--trust", prompt];
}

/**
 * Run `cursor-agent -p --trust` and return captured output. Throws when
 * the CLI is absent or the wall-clock budget is exceeded. On a non-zero
 * exit the result is still returned so callers can use partial text.
 */
export async function runCursorAgent(
  prompt: string,
  opts: CursorAgentOptions = {},
): Promise<CursorAgentResult> {
  if (!cursorAgentAvailable()) {
    throw new Error("cursor-agent: CLI not found on PATH");
  }

  const timeoutMs = opts.timeoutMs ?? CURSOR_AGENT_DEFAULT_TIMEOUT_MS;
  const args = cursorAgentArgs(prompt);
  const capture = opts.capture !== false;

  if (!capture) {
    const proc = Bun.spawn(args, {
      cwd: opts.cwd,
      stdout: "inherit",
      stderr: "inherit",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const exitCode = await proc.exited;
    return { text: "", exitCode, stderr: "" };
  }

  const result = await withTimeout(
    sh(args, { cwd: opts.cwd, nothrow: true, quiet: true }),
    timeoutMs,
  );
  const text = result.stdout.trim();
  if (text) {
    process.stdout.write(text);
    process.stdout.write("\n");
  }
  return {
    text,
    exitCode: result.exitCode,
    stderr: result.stderr.trim(),
  };
}

/**
 * `devkit cursor` entry: run `cursor-agent` and return a process exit
 * code (0 on success, 1 on failure or timeout).
 */
export async function cursor(opts: CursorCommandOptions): Promise<number> {
  if (!cursorAgentAvailable()) {
    fail("cursor-agent not found on PATH");
  }

  const prompt = opts.prompt.trim();
  if (!prompt) fail("prompt required (pass as arguments or pipe via stdin)");

  const timeoutMs = opts.timeoutMs ?? CURSOR_AGENT_DEFAULT_TIMEOUT_MS;

  consola.log(
    `Running cursor-agent (timeout ${Math.round(timeoutMs / 1000)}s)...`,
  );

  try {
    const { text, exitCode, stderr } = await runCursorAgent(prompt, {
      timeoutMs,
      capture: false,
    });
    if (exitCode === 0) return 0;

    if (cursorAgentTimedOut(exitCode)) {
      consola.warn(
        `cursor-agent timed out after ${Math.round(timeoutMs / 1000)}s (exit ${exitCode})`,
      );
      return 1;
    }

    if (stderr) consola.warn(stderr);
    consola.warn(`cursor-agent exited ${exitCode}`);
    return text ? 0 : 1;
  } catch (err) {
    const message = errorMessage(err);
    if (/timed out|timeout|aborted/i.test(message)) {
      consola.warn(`cursor-agent timed out after ${Math.round(timeoutMs / 1000)}s: ${message}`);
      return 1;
    }
    fail(`cursor-agent failed: ${message}`);
  }
}

/** Join argv prompt parts, or read stdin when non-interactive and args are empty. */
export async function resolveCursorPrompt(promptParts: string[]): Promise<string> {
  const fromArgs = promptParts.join(" ").trim();
  if (fromArgs) return fromArgs;
  if (process.stdin.isTTY) return "";
  return (await Bun.stdin.text()).trim();
}

/** Reject when `promise` does not settle within `ms` milliseconds. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`cursor-agent: timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
