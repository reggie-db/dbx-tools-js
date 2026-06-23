// Single home for running subprocesses through Bun's shell, so nothing
// else re-implements capture/trim/exit-code handling. Bun resolves the
// binary on PATH itself, so there is no `which` plumbing here.
//
// Bun's `$` tees: by default it streams live to the terminal *and* buffers
// the output onto the result. So streaming is the default and capture is
// always available; `quiet` only suppresses the live echo for calls run
// purely for their stdout (knip JSON, `npm view`, git plumbing, ...).

import { $ } from "bun";

export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ShellOptions {
  /** Return the result on non-zero exit instead of throwing. */
  nothrow?: boolean;
  /** Working directory for the command. */
  cwd?: string;
  /** String piped to the command's stdin. */
  input?: string;
  /** Suppress the live echo. Output is still captured on the result. */
  quiet?: boolean;
}

/**
 * Run a command, streaming live unless `quiet`. Returns trimmed captured
 * output regardless. Throws on non-zero unless `nothrow`.
 */
export async function sh(
  args: string[],
  opts: ShellOptions = {},
): Promise<ShellResult> {
  let cmd = (
    opts.input !== undefined ? $`${args} < ${new Response(opts.input)}` : $`${args}`
  ).nothrow();
  if (opts.quiet) cmd = cmd.quiet();
  if (opts.cwd) cmd = cmd.cwd(opts.cwd);
  const res = await cmd;
  const stdout = res.stdout.toString().trim();
  const stderr = res.stderr.toString().trim();
  if (!opts.nothrow && res.exitCode !== 0) {
    const detail = stderr || stdout;
    throw new Error(
      `\`${args.join(" ")}\` failed (exit ${res.exitCode})${detail ? `: ${detail}` : ""}`,
    );
  }
  return { exitCode: res.exitCode, stdout, stderr };
}

/** `bun x <args>` for one-off CLI tools (knip, syncpack, prettier, ...). */
export function bunx(args: string[], opts: ShellOptions = {}): Promise<ShellResult> {
  return sh(["bun", "x", ...args], opts);
}
