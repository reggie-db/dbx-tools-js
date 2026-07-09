/**
 * Subprocess helper with optional per-line stdout/stderr callbacks.
 *
 * Defaults to `Bun.spawn` so line callbacks stream as output arrives. Set
 * `shell: true` to use Bun's cross-platform `$` shell (PATH resolution,
 * Windows `.cmd` handling) when you do not need streaming line handlers.
 *
 * For capture-and-throw semantics, prefer {@link sh} / {@link bunx}.
 */

import { $ } from "bun";
import * as readline from "node:readline";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";

type BunSpawnOptions = NonNullable<Parameters<typeof Bun.spawn>[1]>;

export type ExecOptions = Omit<
  BunSpawnOptions,
  "stdin" | "stdout" | "stderr" | "stdio"
> & {
  stdin?: BunSpawnOptions["stdin"];
  stdout?: BunSpawnOptions["stdout"] | ((line: string) => void);
  stderr?: BunSpawnOptions["stderr"] | ((line: string) => void);
  /**
   * Run through Bun's `$` shell instead of `Bun.spawn`. Cross-platform
   * command resolution; stdout/stderr echo to the terminal by default.
   * Line callbacks are satisfied from buffered output after exit (Bun
   * shell does not stream `.lines()` while the process runs).
   */
  shell?: boolean;
  /** Shell only: suppress live stdout/stderr echo (output is still buffered). */
  quiet?: boolean;
};

/**
 * Spawn a subprocess and wait for exit.
 *
 * Unset stdio fds default to `"inherit"`. Pass a function as `stdout` or
 * `stderr` to receive each line; with the default `Bun.spawn` path that fd
 * is piped and lines stream as they arrive.
 */
export async function exec(
  command: string,
  args: string[],
  options: ExecOptions = {},
): Promise<number> {
  if (options.shell) {
    return execShell(command, args, options);
  }
  return execSpawn(command, args, options);
}

async function execSpawn(
  command: string,
  args: string[],
  options: ExecOptions,
): Promise<number> {
  const { stdin, stdout, stderr, shell: _shell, quiet: _quiet, ...spawnOpts } = options;
  const onStdout = typeof stdout === "function" ? stdout : undefined;
  const onStderr = typeof stderr === "function" ? stderr : undefined;
  const stdoutMode: BunSpawnOptions["stdout"] =
    typeof stdout === "function" ? "pipe" : (stdout ?? "inherit");
  const stderrMode: BunSpawnOptions["stderr"] =
    typeof stderr === "function" ? "pipe" : (stderr ?? "inherit");

  const proc = Bun.spawn([command, ...args], {
    ...spawnOpts,
    stdin: stdin ?? "inherit",
    stdout: stdoutMode,
    stderr: stderrMode,
  });

  const reads: Promise<void>[] = [];
  if (onStdout && isReadableStream(proc.stdout)) {
    reads.push(readLines(proc.stdout, onStdout));
  }
  if (onStderr && isReadableStream(proc.stderr)) {
    reads.push(readLines(proc.stderr, onStderr));
  }

  try {
    const exitCode = await proc.exited;
    await Promise.all(reads);
    return exitCode;
  } catch (err) {
    await Promise.allSettled(reads);
    throw err;
  }
}

async function execShell(
  command: string,
  args: string[],
  options: ExecOptions,
): Promise<number> {
  const {
    cwd,
    env,
    quiet,
    stdout,
    stderr,
    stdin,
    shell: _shell,
    ..._spawnOnly
  } = options;
  const onStdout = typeof stdout === "function" ? stdout : undefined;
  const onStderr = typeof stderr === "function" ? stderr : undefined;
  const argv = [command, ...args];

  let cmd =
    typeof stdin === "string"
      ? $`${argv} < ${new Response(stdin)}`.nothrow()
      : $`${argv}`.nothrow();
  if (cwd) cmd = cmd.cwd(cwd);
  if (env) cmd = cmd.env(env);
  if (quiet) cmd = cmd.quiet();

  if (onStdout) {
    const [res] = await Promise.all([
      cmd,
      (async () => {
        for await (const line of cmd.lines()) {
          onStdout(line);
        }
      })(),
    ]);
    if (onStderr) {
      emitBufferedLines(res.stderr.toString(), onStderr);
    }
    return res.exitCode;
  }

  const res = await cmd;
  if (onStderr) {
    emitBufferedLines(res.stderr.toString(), onStderr);
  }
  return res.exitCode;
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return typeof value === "object" && value !== null && "getReader" in value;
}

async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const rl = readline.createInterface({
    input: Readable.fromWeb(stream as unknown as NodeWebReadableStream),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    onLine(line);
  }
}

function emitBufferedLines(text: string, onLine: (line: string) => void): void {
  if (text.length === 0) return;
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  for (const line of body.split("\n")) {
    onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  }
}

if (import.meta.main) {
  const useShell = process.argv.includes("--shell");
  const argv = process.argv.slice(2).filter((arg) => arg !== "--shell");
  const [command, ...args] = argv;
  if (!command) {
    console.error("Usage: exec [--shell] <command> [args...]");
    process.exit(1);
  }

  const exitCode = await exec(command, args, {
    shell: useShell,
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  });
  console.log(`Exit code: ${exitCode}`);
  process.exit(exitCode);
}
