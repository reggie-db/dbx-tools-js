/**
 * Restart-surviving local Arize Phoenix daemon manager.
 *
 * This module owns everything between AppKit and the OS process:
 * spawning `uv tool run arize-phoenix serve`, the per-workspace state
 * file, the inter-process lock that prevents two parents from racing
 * each other into spawning two daemons, the port readiness probe, and
 * the SIGINT / SIGHUP teardown hooks.
 *
 * The plugin layer (`./plugin.ts`) imports {@link startPhoenix},
 * {@link stopPhoenix}, and {@link installShutdownHooks} and otherwise
 * stays free of any process / fs / `child_process` concerns.
 *
 * Restart-survival mechanics:
 * - The daemon is spawned with `detached: true` + `child.unref()` so
 *   it becomes its own session leader and the parent can exit
 *   without taking it down.
 * - State (pid, ports, log path) is written to a per-workspace JSON
 *   file under `os.tmpdir()`. Two parents (e.g. the stale tsx-watch
 *   child and the new one) coordinate through a `proper-lockfile`
 *   mutex so they don't race into a double-spawn.
 * - On each call we read the state, check whether the recorded PID
 *   is still alive (`process.kill(pid, 0)`), and reuse it when so.
 *   Otherwise we clean up and respawn.
 * - "Real shutdown" is `SIGINT` (Ctrl+C); `tsx watch` restarts use
 *   `SIGTERM`, which we deliberately do not hook so the daemon
 *   outlives reloads.
 */

import { commonUtils, logUtils, netUtils } from "@dbx-tools/appkit-shared";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import * as lockfile from "proper-lockfile";
import which from "which";

const log = logUtils.logger("phoenix/serve");

/** On-disk state written by the spawner and read by every later parent. */
type PhoenixState = {
  pid: number;
  httpPort: number;
  grpcPort: number;
  /**
   * The root-path prefix the daemon was spawned with
   * (`PHOENIX_HOST_ROOT_PATH`). Captured so a re-attached parent can
   * detect a config drift (e.g. someone renamed the plugin between
   * restarts) and respawn instead of silently serving broken asset
   * URLs.
   */
  pathPrefix: string;
  logFile: string;
  startedAt: number;
};

/** Options forwarded from the plugin layer at start time. */
export type StartPhoenixOptions = {
  /**
   * Root path Phoenix should serve under (e.g. `/api/phoenix`).
   * Wired into the daemon via `PHOENIX_HOST_ROOT_PATH` so static
   * assets and GraphQL endpoints render at the prefixed URL.
   * Defaults to `""` (serve at root).
   */
  pathPrefix?: string;
};

/** Public context returned to the plugin layer / its `exports()`. */
export type PhoenixContext = {
  httpPort: number;
  grpcPort: number;
  /** `http://localhost:<httpPort>` - Phoenix UI. */
  baseUrl: string;
  /** OTLP/HTTP traces endpoint - `${baseUrl}/v1/traces`. */
  collectorEndpoint: string;
  /** OTLP/gRPC endpoint - `http://localhost:<grpcPort>`. */
  grpcEndpoint: string;
  /** Absolute path to the file Phoenix is writing stdout/stderr to. */
  logFile: string;
  /** True when this parent reattached to an already-running daemon. */
  reused: boolean;
};

// Lock acquisition waits up to ~5s of staggered retries. tsx watch
// restarts typically race for <1s; the upper bound just covers worst
// case (slow IO, fs.stat lag on macOS) without hanging dev forever.
const LOCK_RETRY_OPTIONS = {
  retries: 10,
  factor: 1.5,
  minTimeout: 50,
  maxTimeout: 1000,
  randomize: true,
} as const;
// `stale` must be >= 5000 per `proper-lockfile`; this also covers
// the case where a previous parent crashed mid-spawn.
const LOCK_STALE_MS = 10_000;
// Phoenix usually boots in 2-5s on a warm cache. 30s gives slow CI
// boxes / cold uv caches headroom without hanging dev forever.
const PORT_WAIT_TIMEOUT_MS = 30_000;

/**
 * Start (or reuse) the Phoenix daemon for this workspace and return
 * its connection info. Serialised behind a `proper-lockfile` mutex so
 * concurrent calls (a stale tsx-watch child and the new one taking
 * its place) can never spawn two daemons.
 *
 * When `pathPrefix` changes between calls (e.g. the plugin name was
 * renamed) the existing daemon is killed and respawned with the new
 * `PHOENIX_HOST_ROOT_PATH`. Phoenix bakes the prefix into its served
 * HTML at boot, so we can't keep an old daemon running with a stale
 * prefix - its asset URLs would 404 through the proxy.
 */
export async function startPhoenix(
  opts: StartPhoenixOptions = {},
): Promise<PhoenixContext> {
  const pathPrefix = normalizePrefix(opts.pathPrefix);
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  // `proper-lockfile` insists the lock target exists when
  // `realpath: true` (its default). Touch a sentinel file so the
  // lockfile lives alongside the state but doesn't collide with it.
  // `proper-lockfile` creates `<lockTarget>.lock/` as the actual
  // mutex directory next to the sentinel.
  const lockTarget = path.join(dir, ".lock-target");
  const lockDir = `${lockTarget}.lock`;
  if (!existsSync(lockTarget)) writeFileSync(lockTarget, "");
  log.debug("Phoenix lock paths", { stateDir: dir, lockTarget, lockDir });

  log.info("Acquiring Phoenix lock", { lockTarget });
  const release = await lockfile.lock(lockTarget, {
    retries: LOCK_RETRY_OPTIONS,
    stale: LOCK_STALE_MS,
  });
  log.debug("Acquired Phoenix lock", { lockTarget, lockDir });
  try {
    const existing = readState(dir);
    if (existing && isProcessAlive(existing.pid)) {
      if ((existing.pathPrefix ?? "") === pathPrefix) {
        log.info("Reusing Phoenix daemon", {
          pid: existing.pid,
          httpPort: existing.httpPort,
          pathPrefix,
        });
        return makeContext(existing, /*reused*/ true);
      }
      log.warn("Phoenix daemon's path prefix changed - respawning", {
        pid: existing.pid,
        old: existing.pathPrefix,
        next: pathPrefix,
      });
      killDaemon(existing.pid);
    } else if (existing) {
      log.warn("Stale Phoenix state, respawning", { pid: existing.pid });
    }
    if (existing) clearState(dir);
    const spawned = await spawnDaemon(dir, pathPrefix);
    writeState(dir, spawned);
    return makeContext(spawned, /*reused*/ false);
  } finally {
    await release();
    log.info("Released Phoenix lock", { lockTarget, lockDir });
  }
}

/**
 * Best-effort kill the running Phoenix daemon and clear the state
 * file. Safe to call multiple times; missing PID / already-dead
 * process counts as success.
 */
export function stopPhoenix(): void {
  const dir = stateDir();
  const state = readState(dir);
  if (state) killDaemon(state.pid);
  clearState(dir);
}

/** SIGTERM by PID, swallowing ESRCH (already dead). */
function killDaemon(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    // ESRCH = already gone, which is exactly what we wanted.
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
      log.warn("Failed to SIGTERM Phoenix daemon", {
        pid,
        err: (err as Error).message,
      });
    }
  }
}

/**
 * Wire `SIGINT` / `SIGHUP` to {@link stopPhoenix} so a real Ctrl+C
 * shutdown cleans up the daemon. `SIGTERM` is intentionally NOT
 * hooked: `tsx watch` (and most file watchers) send it during a
 * restart, and we want Phoenix to outlive those.
 *
 * Re-raises the original signal after cleanup so the host process
 * can take its normal exit path (Node's default for SIGINT is exit
 * code 130). Idempotent: calling more than once is a no-op.
 */
export function installShutdownHooks(): void {
  if (shutdownInstalled) return;
  shutdownInstalled = true;
  const handler = (signal: NodeJS.Signals) => {
    log.info("Real shutdown - stopping Phoenix daemon", { signal });
    stopPhoenix();
    process.kill(process.pid, signal);
  };
  process.once("SIGINT", handler);
  process.once("SIGHUP", handler);
}
let shutdownInstalled = false;

/**
 * Install `uv tool install arize-phoenix` (synchronous, idempotent;
 * a no-op when the tool is already up to date), then `uv tool run
 * arize-phoenix serve` as a detached daemon. The daemon's stdio is
 * redirected to a log file via raw file descriptors so the parent
 * can exit without breaking the pipe.
 *
 * `pathPrefix`, when non-empty, is forwarded as
 * `PHOENIX_HOST_ROOT_PATH` so Phoenix renders its HTML with
 * `<base href>` and asset URLs scoped to the prefix. Required when
 * the plugin will reverse-proxy Phoenix from an AppKit sub-path
 * (`/api/phoenix`, etc.) - without it, the proxied UI 404s on every
 * asset.
 */
async function spawnDaemon(dir: string, pathPrefix: string): Promise<PhoenixState> {
  const uv = await which("uv");
  log.info("Installing arize-phoenix via uv (idempotent)");
  const install = spawnSync(uv, ["tool", "install", "arize-phoenix"], {
    stdio: "inherit",
  });
  if (install.status !== 0) {
    throw new Error(`uv tool install arize-phoenix exited ${install.status}`);
  }

  const httpPort = await netUtils.getRandomPort();
  const grpcPort = await netUtils.getRandomPort();
  const logFile = path.join(dir, "phoenix.log");
  // Open *write* fds (not append) so each daemon starts with a fresh
  // log. The previous run's logs are otherwise interleaved with the
  // new run's, which makes debugging miserable.
  const outFd = openSync(logFile, "w");
  const errFd = openSync(logFile, "w");

  log.info("Spawning Phoenix daemon", {
    httpPort,
    grpcPort,
    logFile,
    pathPrefix: pathPrefix || "(root)",
  });
  const child = spawn(uv, ["tool", "run", "arize-phoenix", "serve"], {
    detached: true,
    stdio: ["ignore", outFd, errFd],
    env: {
      ...process.env,
      PHOENIX_PORT: String(httpPort),
      PHOENIX_GRPC_PORT: String(grpcPort),
      // Forward the AppKit mount path so Phoenix's HTML / asset
      // URLs / GraphQL endpoint render under `/api/phoenix/...`.
      // Mirrors Phoenix's own traefik reverse-proxy example:
      //   https://github.com/Arize-ai/phoenix/tree/main/examples/reverse-proxy
      // Skipped when empty; Phoenix treats `""` as a literal "" prefix
      // and rewrites assets to `//assets/...`, which breaks the UI.
      ...(pathPrefix ? { PHOENIX_HOST_ROOT_PATH: pathPrefix } : {}),
    },
  });
  if (!child.pid) {
    throw new Error("Failed to spawn Phoenix: no pid");
  }
  // Decouple the child from the parent's event loop so the parent
  // can exit cleanly on Ctrl+C (or tsx watch's restart SIGTERM)
  // without taking Phoenix down with it.
  child.unref();

  // Wait until Phoenix's HTTP listener is up before declaring
  // success. Otherwise the first request to the collector races
  // boot and fails with ECONNREFUSED.
  await waitForPort(httpPort, PORT_WAIT_TIMEOUT_MS);

  return {
    pid: child.pid,
    httpPort,
    grpcPort,
    pathPrefix,
    logFile,
    startedAt: Date.now(),
  };
}

/**
 * Normalise a caller-supplied prefix into the canonical form Phoenix
 * expects: a single leading slash, no trailing slash, empty string
 * for "serve at root". Saves the proxy-side path math from worrying
 * about `"/"` vs `""` vs `"/api/phoenix/"`.
 */
function normalizePrefix(raw: string | undefined): string {
  if (!raw) return "";
  let v = raw.trim();
  if (!v || v === "/") return "";
  if (!v.startsWith("/")) v = `/${v}`;
  if (v.endsWith("/")) v = v.slice(0, -1);
  return v;
}

/**
 * One state dir per workspace so two repos running `bun run dev` in
 * parallel don't fight over the same Phoenix daemon. The cwd hash
 * keeps the path stable across restarts of the same workspace.
 */
function stateDir(): string {
  const hash = commonUtils.fnvHash(process.cwd());
  return path.join(os.tmpdir(), `dbx-tools-appkit-phoenix-${hash}`);
}

function statePath(dir: string): string {
  return path.join(dir, "state.json");
}

function readState(dir: string): PhoenixState | null {
  const file = statePath(dir);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as PhoenixState;
  } catch {
    return null;
  }
}

function writeState(dir: string, state: PhoenixState): void {
  writeFileSync(statePath(dir), JSON.stringify(state, null, 2));
}

function clearState(dir: string): void {
  try {
    rmSync(statePath(dir), { force: true });
  } catch {
    // best-effort; the next startup will overwrite anyway.
  }
}

/**
 * `process.kill(pid, 0)` is the standard "is this PID alive?" probe:
 * the kernel only does permission + existence checks and never sends
 * a signal. ESRCH means "no such process". Any other error (EPERM
 * etc.) means the process *does* exist but we can't signal it -
 * good enough for our purposes.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Poll a TCP port until *something* accepts a connection on it (i.e.
 * Phoenix's uvicorn process is listening), or `timeoutMs` elapses.
 * Used post-spawn to gate `startPhoenix()` resolution on the
 * collector actually being reachable.
 */
async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await tryConnect(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Phoenix did not start listening on :${port} within ${timeoutMs}ms`);
}

function tryConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function makeContext(state: PhoenixState, reused: boolean): PhoenixContext {
  const baseUrl = `http://localhost:${state.httpPort}`;
  return {
    httpPort: state.httpPort,
    grpcPort: state.grpcPort,
    baseUrl,
    collectorEndpoint: `${baseUrl}/v1/traces`,
    grpcEndpoint: `http://localhost:${state.grpcPort}`,
    logFile: state.logFile,
    reused,
  };
}
