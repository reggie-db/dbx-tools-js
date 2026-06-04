// Shared helpers for the workspace scripts in this directory. Anything
// duplicated across more than one script lives here.
//
// Conventions:
//   - `ROOT` is the monorepo root.
//   - `discoverPackages()` is the single source of truth for "what's a
//     workspace package?" - every script that walks the workspace goes
//     through it (or its lower-level sibling `discoverPackageJsons()`)
//     instead of re-implementing the readdir + filter loop.
//   - File I/O goes through `Bun.file` / `Bun.write` so we lean on
//     Bun's built-in primitives instead of pulling in `node:fs` for
//     every read.
//   - `writeJson()` preserves the trailing newline of the original
//     file so we don't trigger spurious diffs against `prettier
//     --write`.
//   - `run(...)` is a thin async wrapper over `Bun.spawn` for one-shot
//     subprocess calls (git, npm, tsc, ...) with consistent error
//     handling. We use Bun's built-in spawner directly because every
//     script in this directory runs under `bun`, so reaching for
//     `execa` / `node:child_process` would just add a dependency for
//     no benefit.
//   - `aiQuery()` keeps the Databricks model-serving wiring in one
//     place so any script that wants an LLM summary just calls it.

import { serving, WorkspaceClient } from "@databricks/sdk-experimental";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import pMemoize from "p-memoize";

export const ROOT = resolve(import.meta.dirname, "..");

/** Minimal package.json shape we care about across scripts. */
export interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  workspaces?: string[];
  [key: string]: unknown;
}

/** A workspace package discovered under `packages/`. */
export interface WorkspacePackage {
  /** Path of the package directory relative to ROOT (e.g. `"packages/autopg"`). */
  slug: string;
  /** Absolute path to the package directory. */
  dir: string;
  /** Absolute path to the package's `package.json`. */
  jsonPath: string;
  /** Parsed `package.json` contents. */
  meta: PackageJson;
}

export function toAbsolute(path: string): string {
  return isAbsolute(path) ? path : resolve(ROOT, path);
}

export function toRelative(path: string): string {
  const rel = relative(ROOT, path);
  return rel !== "" &&
    !rel.startsWith("..") &&
    !rel.startsWith("/") &&
    !rel.startsWith("\\")
    ? rel
    : resolve(path);
}

/**
 * Yield the absolute path of every workspace `package.json` listed in
 * the root manifest's `workspaces` field. Lower-level than
 * `discoverPackages()`; use this when you only need the paths (e.g.
 * `clean.ts` deleting each workspace's `node_modules`) and want to
 * include private workspaces (`includeRoot` adds the root package
 * itself).
 */
export async function* discoverPackageJsons(
  includeRoot = false,
): AsyncIterableIterator<string> {
  const rootJson = resolve(ROOT, "package.json");
  if (includeRoot) yield rootJson;
  const { workspaces = [] } = (await Bun.file(rootJson).json()) as PackageJson;
  for (const ws of workspaces) {
    yield* new Bun.Glob(`${ws}/package.json`).scan({ cwd: ROOT, absolute: true });
  }
}

export async function* discoverTsconfigs(
  includeRoot = false,
): AsyncIterableIterator<string> {
  for await (const pjson of discoverPackageJsons(includeRoot)) {
    const dir = dirname(pjson);
    for (const globPattern of ["tsconfig.json", "tsconfig.build.json"]) {
      const glob = new Bun.Glob(globPattern);
      const tsconfigs = glob.scan({ cwd: dir, absolute: true });
      for await (const tsconfig of tsconfigs) {
        yield tsconfig;
      }
    }
  }
}

/**
 * Walk every workspace package, parse each `package.json`, and return
 * the ones that pass `filter`. The default filter keeps every package
 * that isn't marked `"private": true`.
 *
 * Scripts that need extra criteria (e.g. "must have a
 * `tsconfig.build.json`") pass a custom `filter`.
 */
export async function discoverPackages(
  filter: (pkg: WorkspacePackage) => boolean = (pkg) => pkg.meta.private !== true,
): Promise<WorkspacePackage[]> {
  const wsPackages: WorkspacePackage[] = [];
  for await (const jsonPath of discoverPackageJsons()) {
    const dir = dirname(jsonPath);
    const meta = (await Bun.file(jsonPath).json()) as PackageJson;
    const wsPackage: WorkspacePackage = {
      slug: relative(ROOT, dir),
      dir,
      jsonPath,
      meta,
    };
    if (filter(wsPackage)) wsPackages.push(wsPackage);
  }
  wsPackages.sort((a, b) => a.slug.localeCompare(b.slug));
  return wsPackages;
}

/**
 * Serialize `value` and write it to `path`, preserving the original
 * file's trailing newline (or adding one if the file is new). Prevents
 * formatter churn against `prettier --write`.
 */
export async function writeJson(path: string, value: unknown): Promise<void> {
  const file = Bun.file(path);
  const trailingNewline = (await file.exists())
    ? (await file.text()).endsWith("\n")
    : true;
  await Bun.write(path, JSON.stringify(value, null, 2) + (trailingNewline ? "\n" : ""));
}

/**
 * Run a subprocess. Defaults `stdio: "inherit"` so output streams to
 * the user, captures stdout/stderr instead when `capture: true`, and
 * aborts the script with a clear message when the child exits non-zero
 * (set `check: false` to opt out of that behavior).
 *
 * Returns the trimmed stdout when capturing, or the empty string when
 * inheriting (because nothing was captured).
 */
export async function run(
  command: string,
  args: readonly string[],
  opts: { capture?: boolean; check?: boolean; cwd?: string } = {},
): Promise<string> {
  const { capture = false, check = true, cwd = ROOT } = opts;
  const proc = Bun.spawn([command, ...args], {
    cwd,
    stdout: capture ? "pipe" : "inherit",
    stderr: capture ? "pipe" : "inherit",
    stdin: "inherit",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    capture && proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
    capture && proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
  ]);
  if (check && exitCode !== 0) {
    const detail = capture ? `: ${stderr.trim() || stdout.trim()}` : "";
    fail(`\`${command} ${args.join(" ")}\` failed (exit ${exitCode})${detail}`);
  }
  return stdout.trim();
}

/**
 * Shorthand for `bun x <args>`. Bun is on the PATH because these
 * scripts run under `bun`, so we don't need the `which` lookup or the
 * Windows `.cmd` shim that a node-based runner would.
 */
export async function bunx(
  args: readonly string[],
  opts: { capture?: boolean; check?: boolean; cwd?: string } = {},
): Promise<string> {
  return run("bun", ["x", ...args], opts);
}

/** Print `message` to stderr and exit the script with code 1. */
export function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/**
 * Lazy WorkspaceClient singleton. Memoized so multiple `aiQuery()`
 * calls in one script share the same auth handshake. Returns `null`
 * when no Databricks profile is available (so callers can degrade
 * gracefully instead of throwing in scripts where AI is optional).
 */
export const getWorkspaceClient = pMemoize(
  async (): Promise<WorkspaceClient | null> => {
    try {
      return new WorkspaceClient({});
    } catch (error) {
      console.error("Error creating workspace client:", error);
      return null;
    }
  },
);

const DEFAULT_AI_MODEL = "databricks-claude-opus-4-6";

/**
 * Send `prompt` plus an optional structured `ctx` to a Databricks
 * model-serving endpoint and return the assistant's text reply.
 *
 * Returns `null` when:
 *   - the combined content is empty
 *   - no Databricks workspace client can be built (no profile, etc.)
 *   - the response has no content
 *
 * Designed so the caller can do `await aiQuery(...) ?? fallback` and
 * never has to handle errors explicitly.
 */
export async function aiQuery(
  prompt: string,
  ctx?: unknown,
  model: string = DEFAULT_AI_MODEL,
): Promise<string | null> {
  const parts = [prompt];
  if (ctx !== undefined && ctx !== null) parts.push("Context:", JSON.stringify(ctx));
  const content = parts
    .map((part) => part?.trim?.() ?? part)
    .filter(Boolean)
    .join("\n\n")
    .trim();
  if (!content) return null;

  const client = await getWorkspaceClient();
  if (!client) return null;

  const response: serving.QueryEndpointResponse = await client.servingEndpoints.query({
    name: model,
    messages: [{ role: "user", content }],
  });
  return response?.choices?.[0]?.message?.content || null;
}
