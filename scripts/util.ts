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
//   - `aiQuery()` is a one-shot Databricks model-serving call - no
//     tools, no agent loop, just prompt -> reply. Use it when you
//     only need a single completion.
//   - `agentQuery()` runs the same prompt through a Mastra agent that
//     can call a `read_files` tool to inspect files under `ROOT` on
//     demand. Use it when the LLM needs to drill into source to
//     produce a higher-fidelity answer (e.g. release notes that cite
//     specific helpers). The agent's system prompt is always
//     augmented with the contents of `.cursor/rules/*.mdc` so it
//     shares the same repo conventions the IDE rules describe.

import { execa } from "execa";
import { which } from "bun";
import { serving, WorkspaceClient } from "@databricks/sdk-experimental";
import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import { createTool } from "@mastra/core/tools";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import pMemoize from "p-memoize";
import { z } from "zod";

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
  /** Path of the package directory relative to ROOT (e.g. `"packages/appkit-autopg"`). */
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

/**
 * Build a `execute_typescript` tool backed by a sandboxed container
 * runtime (docker or podman). Returns `undefined` when neither
 * runtime is on `PATH`, so callers can drop the tool from the agent
 * silently on hosts that can't sandbox.
 *
 * Pipes the supplied code into `bun run -` inside `oven/bun:1` over
 * stdin (no volume mount, so we sidestep Docker Desktop file-sharing
 * limits around macOS `/var/folders/...` tmpdirs). Runs offline
 * (`--network=none`) with tight CPU / memory limits, all capabilities
 * dropped, a pid cap, and a 10s wall-clock timeout.
 */
function createExecuteTypescriptTool() {
  const dockerCommand = ["docker", "podman"].find((cmd) => which(cmd));
  if (!dockerCommand) return undefined;
  return createTool({
    id: "execute_typescript",
    description: "Execute TypeScript in an isolated Docker container.",
    inputSchema: z.object({
      code: z.string(),
    }),
    outputSchema: z.object({
      stdout: z.string(),
      stderr: z.string(),
      exitCode: z.number(),
    }),
    execute: async ({ code }) => {
      const args = [
        "run",
        "--rm",
        "-i", // keep stdin open so we can pipe the script in
        "--network=none",
        "--memory=256m",
        "--cpus=1",
        "--cap-drop=ALL",
        "--pids-limit=64",
        "-w",
        "/tmp", // bun needs a readable cwd; the image's default WORKDIR isn't always there
        "oven/bun:1",
        "bun",
        "run",
        "-", // read script from stdin
      ];
      const result = await execa(dockerCommand, args, {
        input: code,
        reject: false,
        timeout: 10_000,
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? 0,
      };
    },
  });
}

/* ----------------------- mastra agent (tool-using) ----------------------- */

/**
 * Resolve a relative path against `base` and refuse anything that
 * escapes it. Centralizes the safety check shared by every
 * filesystem-touching tool so callers can't accidentally let the
 * agent read `/etc/passwd`.
 */
function resolveScopePath(base: string, relPath: string): string {
  const abs = resolve(base, relPath);
  const rel = relative(base, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path escapes scope ${base}: ${relPath}`);
  }
  return abs;
}

/** Short, human-readable label for the agent's filesystem scope. */
function scopeLabel(base: string): string {
  const rel = relative(ROOT, base);
  if (rel === "") return "the dbx-tools-appkit repo root";
  if (rel.startsWith("..")) return base;
  return `${rel} (under the dbx-tools-appkit repo)`;
}

/**
 * Build a `list_files` tool scoped to `base`. Returns the immediate
 * children of a directory inside `base`. Refuses paths that escape
 * the scope.
 */
function createListFilesTool(base: string) {
  return createTool({
    id: "list_files",
    description:
      `List files and directories under ${scopeLabel(base)}. ` +
      "`path` is an optional directory path relative to that scope " +
      "(e.g. 'src' or 'packages/shared/src'). Defaults to the scope " +
      "root. Returns immediate children with type metadata.",
    inputSchema: z.object({
      path: z.string().optional().describe("Scope-relative directory path"),
    }),
    outputSchema: z.discriminatedUnion("ok", [
      z.object({
        ok: z.literal(true),
        path: z.string(),
        entries: z.array(
          z.object({
            name: z.string(),
            path: z.string(),
            type: z.enum(["file", "directory"]),
          }),
        ),
      }),
      z.object({ ok: z.literal(false), path: z.string(), error: z.string() }),
    ]),
    execute: async ({ path = "." }) => {
      try {
        const abs = resolveScopePath(base, path);
        const stat = statSync(abs);
        if (!stat.isDirectory()) throw new Error(`Not a directory: ${path}`);
        const entries = readdirSync(abs, { withFileTypes: true })
          .map((entry) => ({
            name: entry.name,
            path: posix.join(path === "." ? "" : path, entry.name),
            type: entry.isDirectory() ? ("directory" as const) : ("file" as const),
          }))
          .sort((a, b) =>
            a.type !== b.type
              ? a.type === "directory"
                ? -1
                : 1
              : a.name.localeCompare(b.name),
          );
        return { ok: true as const, path, entries };
      } catch (err) {
        return {
          ok: false as const,
          path,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}

/**
 * Build a `read_files` tool scoped to `base`. Reads one or more
 * UTF-8 files inside `base` in a single call, each with an optional
 * 1-indexed line range trim. Refuses paths that escape the scope.
 * Batching multiple reads per call cuts LLM round-trips dramatically
 * when the agent already knows which related files it needs.
 */
function createReadFilesTool(base: string) {
  const fileEntry = z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      path: z.string(),
      totalLines: z.number(),
      content: z.string(),
    }),
    z.object({ ok: z.literal(false), path: z.string(), error: z.string() }),
  ]);
  return createTool({
    id: "read_files",
    description:
      `Read one or more UTF-8 files under ${scopeLabel(base)} in a ` +
      "single call. `files` is an array of `{ path, lineStart?, " +
      "lineEnd? }` entries; `path` is relative to the scope, and " +
      "`lineStart` / `lineEnd` (1-indexed, inclusive) optionally " +
      "trim that entry to a slice. Prefer batching related reads " +
      "(e.g. package.json + src/index.ts) in one call instead of " +
      "issuing one tool call per file.",
    inputSchema: z.object({
      files: z
        .array(
          z.object({
            path: z.string().describe("Scope-relative path"),
            lineStart: z.number().int().min(1).optional(),
            lineEnd: z.number().int().min(1).optional(),
          }),
        )
        .min(1),
    }),
    outputSchema: z.object({ files: z.array(fileEntry) }),
    execute: async ({ files }) => ({
      files: files.map(({ path, lineStart, lineEnd }) => {
        try {
          const abs = resolveScopePath(base, path);
          const stat = statSync(abs);
          if (!stat.isFile()) throw new Error(`Not a regular file: ${path}`);
          const text = readFileSync(abs, "utf8");
          const lines = text.split("\n");
          const start = lineStart ? Math.max(1, lineStart) - 1 : 0;
          const end = lineEnd ? Math.min(lines.length, lineEnd) : lines.length;
          return {
            ok: true as const,
            path,
            totalLines: lines.length,
            content: lines.slice(start, end).join("\n"),
          };
        } catch (err) {
          return {
            ok: false as const,
            path,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    }),
  });
}

/**
 * Build the `git_status` / `git_diff` / `git_log` tool trio for the
 * agent, all rooted at {@link ROOT}. Returns `undefined` when `git`
 * isn't on PATH, so callers drop the tools silently on
 * git-less hosts (matching the {@link createExecuteTypescriptTool}
 * pattern). Tools accept an optional path filter (relative to the
 * repo root) for drilling into a specific file or subdir.
 */
function createGitTools() {
  if (!which("git")) return undefined;
  const runGit = (args: string[]) =>
    execa("git", args, { cwd: ROOT, reject: false, timeout: 10_000 });
  const result = z.object({
    ok: z.boolean(),
    stdout: z.string(),
    stderr: z.string(),
  });
  const toResult = (r: {
    exitCode?: number | undefined;
    stdout: string;
    stderr: string;
  }) => ({
    ok: r.exitCode === 0,
    stdout: r.stdout,
    stderr: r.stderr,
  });
  return {
    git_status: createTool({
      id: "git_status",
      description:
        "Show working-tree status as `git status --porcelain` output. " +
        "Use to discover which files in the dbx-tools-appkit repo " +
        "are modified, added, untracked, or staged.",
      inputSchema: z.object({}),
      outputSchema: result,
      execute: async () => toResult(await runGit(["status", "--porcelain"])),
    }),
    git_diff: createTool({
      id: "git_diff",
      description:
        "Show `git diff` between the working tree and HEAD. Optional " +
        "`path` (repo-relative) limits the diff to one file or " +
        "directory. Optional `stat: true` returns the diff stat " +
        "(file list with +/- counts) instead of the full patch - " +
        "useful when you only need a high-level summary.",
      inputSchema: z.object({
        path: z.string().optional(),
        stat: z.boolean().optional(),
      }),
      outputSchema: result,
      execute: async ({ path, stat }) => {
        const args = ["diff"];
        if (stat) args.push("--stat");
        if (path) args.push("--", path);
        return toResult(await runGit(args));
      },
    }),
    git_log: createTool({
      id: "git_log",
      description:
        "Show recent commit subjects (`git log --oneline --no-merges`). " +
        "Optional `path` (repo-relative) restricts history to that " +
        "file or directory; optional `limit` (default 20, max 200) " +
        "caps the number of commits returned.",
      inputSchema: z.object({
        path: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      outputSchema: result,
      execute: async ({ path, limit }) => {
        const args = [
          "log",
          "--no-merges",
          "--pretty=format:%h %s",
          `-n${limit ?? 20}`,
        ];
        if (path) args.push("--", path);
        return toResult(await runGit(args));
      },
    }),
  };
}

/**
 * Read all `.cursor/rules/*.mdc` files once, strip the YAML
 * frontmatter, and return them as a single markdown block ready to
 * paste into a system prompt. Returns an empty string when the
 * directory or any file is missing so callers can compose
 * unconditionally. Cached at module scope; rule edits require a
 * script restart to take effect.
 */
let _cachedCursorRules: string | undefined;
function loadCursorRules(): string {
  if (_cachedCursorRules !== undefined) return _cachedCursorRules;
  const dir = join(ROOT, ".cursor", "rules");
  if (!existsSync(dir)) return (_cachedCursorRules = "");
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".mdc"))
      .sort();
  } catch {
    return (_cachedCursorRules = "");
  }
  const sections: string[] = [];
  for (const f of files) {
    let raw: string;
    try {
      raw = readFileSync(join(dir, f), "utf8");
    } catch {
      continue;
    }
    const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
    if (!body) continue;
    sections.push(`### ${f.replace(/\.mdc$/, "")}\n\n${body}`);
  }
  _cachedCursorRules = sections.length
    ? `## Repo conventions (from .cursor/rules)\n\n${sections.join("\n\n")}`
    : "";
  return _cachedCursorRules;
}

const DEFAULT_AGENT_INSTRUCTIONS = `
You are a code-aware assistant for the dbx-tools-appkit monorepo (Bun + TypeScript, packages under packages/* and demo/).

Tools (use only when the answer materially benefits; don't read speculatively):
- list_files / read_files: walk and read source inside the current scope.
  read_files takes an array, so batch related files (e.g. package.json
  + src/index.ts) in one call. Each entry supports a line range for
  focused reads on large files.
- git_status / git_diff / git_log (when git is available): inspect
  repo state. Pass a path filter to git_diff and git_log to drill
  into a specific file or directory.
- execute_typescript (when a container runtime is available): run
  short TS snippets in a sandbox.

Keep responses terse. No preamble. No closing remarks. No emojis. No
em dashes.`.trim();

/** Optional overrides for {@link getScriptAgent}. */
export interface ScriptAgentOverrides {
  /** Override the system instructions. Defaults to {@link DEFAULT_AGENT_INSTRUCTIONS}. */
  instructions?: string;
  /** Model serving endpoint name. Defaults to {@link DEFAULT_AI_MODEL}. */
  model?: string;
  /**
   * Base directory for the filesystem tools (`list_files` / `read_files`).
   * Defaults to {@link ROOT}. Path traversal is refused for anything
   * outside this directory. Use it to scope the agent to a single
   * package (e.g. `cwd: pkg.dir` when generating per-package READMEs)
   * so the agent can't wander the whole repo.
   */
  cwd?: string;
}

/** Build a Databricks Model Serving config Mastra can drive directly. */
async function buildScriptModel(modelId: string): Promise<MastraModelConfig | null> {
  const client = await getWorkspaceClient();
  if (!client) return null;
  const host = (await client.config.getHost()).toString();
  const headers = new Headers();
  await client.config.authenticate(headers);
  // The OpenAI Node SDK appends paths like `/chat/completions` to whatever
  // URL we hand it. Drop the trailing slash so the resulting URL stays
  // well-formed (`/serving-endpoints/chat/completions`).
  const url = new URL("/serving-endpoints", host).toString().replace(/\/$/, "");
  return {
    providerId: "databricks",
    modelId,
    url,
    headers: Object.fromEntries(headers.entries()),
  };
}

/**
 * Lazily build a Mastra agent that can read files under {@link ROOT}
 * via the `read_files` tool. Memoized per `(instructions, model)`
 * pair so repeated `agentQuery()` calls in one script reuse the
 * same agent and the auth handshake from {@link getWorkspaceClient}.
 *
 * Returns `null` when no Databricks workspace client is available,
 * matching the degrade-gracefully behavior of {@link aiQuery}.
 */
export const getScriptAgent = pMemoize(
  async (overrides: ScriptAgentOverrides = {}): Promise<Agent | null> => {
    const modelId = overrides.model ?? DEFAULT_AI_MODEL;
    const model = await buildScriptModel(modelId);
    if (!model) return null;
    const base = overrides.cwd ?? ROOT;
    const gitTools = createGitTools();
    const sandbox = createExecuteTypescriptTool();
    // Always append the .cursor/rules block so per-script overrides
    // (release notes prompt, README generator prompt, ...) still get
    // the repo conventions (package map, dry-helpers, docstring style)
    // without each caller having to glue them in by hand.
    const rules = loadCursorRules();
    const baseInstructions =
      overrides.instructions ?? DEFAULT_AGENT_INSTRUCTIONS;
    const instructions = rules
      ? `${baseInstructions}\n\n${rules}`
      : baseInstructions;
    return new Agent({
      id: "dbx-tools-script-agent",
      name: "dbx-tools-script-agent",
      instructions,
      model,
      tools: {
        list_files: createListFilesTool(base),
        read_files: createReadFilesTool(base),
        ...(gitTools ?? {}),
        ...(sandbox ? { execute_typescript: sandbox } : {}),
      },
    });
  },
  // pMemoize uses the first arg as the cache key by default; serialize
  // the overrides object so structurally equal calls hit the same agent.
  { cacheKey: ([overrides]) => JSON.stringify(overrides ?? {}) },
);

/**
 * Agent-driven counterpart of {@link aiQuery}. Runs the same `prompt`
 * + optional structured `ctx` through a Mastra agent that can call
 * the `read_files` tool to inspect repo files on demand. Use when the
 * LLM needs to cite or summarize specific source files; reach for
 * `aiQuery` when you only need a one-shot completion.
 *
 * Same null-on-failure contract as `aiQuery` so callers can keep the
 * `await agentQuery(...) ?? fallback` pattern.
 */
export async function agentQuery(
  prompt: string,
  ctx?: unknown,
  overrides: ScriptAgentOverrides = {},
): Promise<string | null> {
  const parts = [prompt];
  if (ctx !== undefined && ctx !== null) parts.push("Context:", JSON.stringify(ctx));
  const content = parts
    .map((part) => part?.trim?.() ?? part)
    .filter(Boolean)
    .join("\n\n")
    .trim();
  if (!content) return null;

  const agent = await getScriptAgent(overrides);
  if (!agent) return null;
  // `generate()` runs the agent loop (tool calls + final text) to
  // completion in one call. `result.text` is the accumulated
  // assistant text across every step, which is what we want as the
  // script's answer. `onStepFinish` surfaces per-step tool calls so
  // long scripts (`readme.ts`, `tag.ts`) can show progress while the
  // agent works.
  const stream = await agent.stream(content, {
    // Default `maxSteps` is conservative; bump so the agent has room
    // to chain several tool calls (read_files / git_log / etc.) before
    // it has to commit to a final answer. Tag + readme runs typically
    // settle in well under this cap.
    maxSteps: 32,
  });
  for await (const event of stream.fullStream) {
    if (event.type === "tool-call") {
      console.debug(`  tool: ${event.payload?.toolName}`);
    }
  }
  const text = await stream.text;

  return text?.trim() || null;
}
