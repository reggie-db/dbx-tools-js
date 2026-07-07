/**
 * Run Codex headlessly via `ucode codex exec` for `dbxtools agent` and
 * release tooling that drafts notes programmatically.
 */

import { consola } from "consola";
import { sh } from "./shell.js";
import { errorMessage, fail } from "./script.js";

/** Default wall-clock budget for a Codex invocation. */
export const AGENT_DEFAULT_TIMEOUT_MS = 300_000;

/** Options for {@link runAgent}. */
export interface AgentOptions {
  /** Wall-clock budget in milliseconds. */
  timeoutMs?: number;
  /** Working directory for the agent (defaults to `process.cwd()`). */
  cwd?: string;
  /**
   * When `true` (default), capture stdout via `sh({ quiet: true })` for
   * programmatic callers. When `false`, inherit stdio like
   * `ucode codex exec …` in a shell.
   */
  capture?: boolean;
}

/** Outcome of {@link runAgent}. */
export interface AgentResult {
  /** Trimmed assistant answer. */
  text: string;
  /** Subprocess exit code. */
  exitCode: number;
  /** Trimmed stderr. */
  stderr: string;
}

/** Options for {@link agent}. */
export interface AgentCommandOptions {
  /** Prompt passed to `ucode codex exec`. */
  prompt: string;
  /** Wall-clock budget in milliseconds. */
  timeoutMs?: number;
}

/** Whether `ucode codex --version` reports a usable Codex CLI. */
export async function agentAvailable(): Promise<boolean> {
  if (!Bun.which("ucode")) return false;
  const result = await sh(["ucode", "codex", "--version"], {
    nothrow: true,
    quiet: true,
  });
  return result.exitCode === 0 && /codex-cli\s+\S+/.test(result.stdout);
}

/** Whether an exit code looks like the process was killed on a timeout. */
export function agentTimedOut(exitCode: number): boolean {
  return exitCode === 143 || exitCode === 137;
}

/** argv for `ucode codex exec <prompt>`. */
function agentExecArgs(prompt: string): string[] {
  return ["ucode", "codex", "exec", "--yolo", prompt];
}

/** Pull assistant prose out of `ucode codex exec` stdout. */
export function parseCodexStdout(stdout: string): string {
  const starting = "✔ Starting Codex\n";
  const startIdx = stdout.lastIndexOf(starting);
  if (startIdx >= 0) return stdout.slice(startIdx + starting.length).trim();

  const codexIdx = stdout.lastIndexOf("\ncodex\n");
  if (codexIdx >= 0) {
    const after = stdout.slice(codexIdx + "\ncodex\n".length);
    const end = after.search(/\n(?:tokens used\b)/);
    return (end < 0 ? after : after.slice(0, end)).trim();
  }

  return stdout.trim();
}

/**
 * Run `ucode codex exec` and return captured output. Throws when Codex
 * is absent or the wall-clock budget is exceeded. On a non-zero exit
 * the result is still returned so callers can use partial text.
 */
export async function runAgent(
  prompt: string,
  opts: AgentOptions = {},
): Promise<AgentResult> {
  if (!(await agentAvailable())) {
    throw new Error("ucode codex: CLI not available (run `ucode codex --version`)");
  }

  const timeoutMs = opts.timeoutMs ?? AGENT_DEFAULT_TIMEOUT_MS;
  const args = agentExecArgs(prompt);
  const capture = opts.capture !== false;

  if (!capture) {
    const proc = Bun.spawn(args, {
      cwd: opts.cwd,
      stdin: Bun.file("/dev/null"),
      stdout: "inherit",
      stderr: "inherit",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const exitCode = await proc.exited;
    return { text: "", exitCode, stderr: "" };
  }

  const result = await withTimeout(
    sh(args, { cwd: opts.cwd, nothrow: true, quiet: true, input: "" }),
    timeoutMs,
  );
  const text = parseCodexStdout(result.stdout);
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
 * `dbxtools agent` entry: run Codex and return a process exit code (0 on
 * success, 1 on failure or timeout).
 */
export async function agent(opts: AgentCommandOptions): Promise<number> {
  if (!(await agentAvailable())) {
    fail("ucode codex not available (install ucode and run `ucode codex --version`)");
  }

  const prompt = opts.prompt.trim();
  if (!prompt) fail("prompt required (pass as arguments or pipe via stdin)");

  const timeoutMs = opts.timeoutMs ?? AGENT_DEFAULT_TIMEOUT_MS;

  consola.log(`Running ucode codex exec (timeout ${Math.round(timeoutMs / 1000)}s)...`);

  try {
    const { text, exitCode, stderr } = await runAgent(prompt, {
      timeoutMs,
      capture: false,
    });
    if (exitCode === 0) return 0;

    if (agentTimedOut(exitCode)) {
      consola.warn(
        `ucode codex timed out after ${Math.round(timeoutMs / 1000)}s (exit ${exitCode})`,
      );
      return 1;
    }

    if (stderr) consola.warn(stderr);
    consola.warn(`ucode codex exited ${exitCode}`);
    return text ? 0 : 1;
  } catch (err) {
    const message = errorMessage(err);
    if (/timed out|timeout|aborted/i.test(message)) {
      consola.warn(
        `ucode codex timed out after ${Math.round(timeoutMs / 1000)}s: ${message}`,
      );
      return 1;
    }
    fail(`ucode codex failed: ${message}`);
  }
}

/** Join argv prompt parts, or read stdin when non-interactive and args are empty. */
export async function resolveAgentPrompt(promptParts: string[]): Promise<string> {
  const fromArgs = promptParts.join(" ").trim();
  if (fromArgs) return fromArgs;
  if (process.stdin.isTTY) return "";
  return (await Bun.stdin.text()).trim();
}

/** Reject when `promise` does not settle within `ms` milliseconds. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`ucode codex: timed out after ${ms}ms`)),
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
