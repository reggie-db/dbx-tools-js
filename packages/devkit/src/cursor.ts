/**
 * CLI entry for {@link runCursorAgent}: run `cursor-agent` headlessly and
 * stream assistant text to the terminal.
 */

import { consola } from "consola";
import {
  CURSOR_AGENT_DEFAULT_TIMEOUT_MS,
  cursorAgentAvailable,
  cursorAgentTimedOut,
  runCursorAgent,
} from "./cursor-agent.js";
import { errorMessage, fail } from "./script.js";

/** Options for {@link cursor}. */
export interface CursorCommandOptions {
  /** Prompt passed to `cursor-agent`. */
  prompt: string;
  /** Wall-clock budget in milliseconds. */
  timeoutMs?: number;
}

/**
 * Run `cursor-agent` with streamed output. Returns a process exit code
 * (0 on success, 1 on failure or timeout without usable text).
 */
export async function cursor(opts: CursorCommandOptions): Promise<number> {
  if (!cursorAgentAvailable()) {
    fail("cursor-agent not found on PATH");
  }

  const prompt = opts.prompt.trim();
  if (!prompt) fail("prompt required (pass as arguments or pipe via stdin)");

  const timeoutMs = opts.timeoutMs ?? CURSOR_AGENT_DEFAULT_TIMEOUT_MS;

  try {
    const { text, exitCode, stderr } = await runCursorAgent(prompt, { timeoutMs });
    if (exitCode === 0 && text) return 0;

    if (cursorAgentTimedOut(exitCode)) {
      consola.warn(
        `cursor-agent timed out after ${Math.round(timeoutMs / 1000)}s (exit ${exitCode})` +
          `${text ? "; partial output above" : ""}`,
      );
      return text ? 0 : 1;
    }

    if (stderr) consola.warn(stderr);
    consola.warn(
      `cursor-agent exited ${exitCode}` +
        `${text ? " (partial output above)" : " with no output"}`,
    );
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
