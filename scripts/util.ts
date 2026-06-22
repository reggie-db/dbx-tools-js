// Shared helpers for the workspace scripts in this directory. Anything
// duplicated across more than one script lives here.

import { WorkspaceClient } from "@databricks/sdk-experimental";
import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import { createTool } from "@mastra/core/tools";
import { FileSink, fileURLToPath, which } from "bun";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import pMemoize from "p-memoize";
import { z } from "zod";

export const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = resolve(SCRIPTS_DIR, "..");

/** Minimal package.json shape we care about across scripts. */
export interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  workspaces?: string[];
  [key: string]: unknown;
}

export class WorkspacePackage {
  readonly dir: string;
  readonly slug: string;

  private constructor(
    readonly jsonPath: string,
    readonly meta: PackageJson,
  ) {
    this.dir = dirname(jsonPath);
    this.slug = relative(ROOT_DIR, this.dir);
  }

  static async fromPackageJson(jsonPath: string): Promise<WorkspacePackage> {
    const meta = (await Bun.file(jsonPath).json()) as PackageJson;

    return new WorkspacePackage(jsonPath, meta);
  }

  async tsconfig(): Promise<string | undefined> {
    for await (const tsconfig of this.tsconfigs()) {
      return tsconfig;
    }
    return undefined;
  }

  async *tsconfigs(): AsyncIterableIterator<string> {
    for (const suffix of [".build", ""]) {
      const glob = new Bun.Glob(`tsconfig${suffix}.json`);
      const tsconfigs = glob.scan({ cwd: this.dir, absolute: true });
      for await (const tsconfig of tsconfigs) {
        yield tsconfig;
      }
    }
  }
}

export function toAbsolute(path: string): string {
  return isAbsolute(path) ? path : resolve(ROOT_DIR, path);
}

export function toRelative(path: string): string {
  const rel = relative(ROOT_DIR, path);
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
  const rootJson = resolve(ROOT_DIR, "package.json");
  if (includeRoot) yield rootJson;
  const { workspaces = [] } = (await Bun.file(rootJson).json()) as PackageJson;
  for (const ws of workspaces) {
    const packageJsonScan = new Bun.Glob(`${ws}/package.json`).scan({
      cwd: ROOT_DIR,
      absolute: true,
    });
    for await (const packageJson of packageJsonScan) {
      yield packageJson;
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
    const wsPackage = await WorkspacePackage.fromPackageJson(jsonPath);
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
 * `Bun.spawn` options plus our extras: `input` pipes a string to the
 * child's stdin (and closes it), `disableWhich` skips the `PATH`
 * lookup so the command is spawned verbatim, and `disableCheck`
 * suppresses the throw-on-non-zero-exit behavior so the caller can
 * inspect `exitCode` instead.
 */
type ExecOptions = NonNullable<Parameters<typeof Bun.spawn>[1]> & {
  input?: string;
  disableWhich?: boolean;
  disableCheck?: boolean;
};

const execResultSchema = z
  .object({
    exitCode: z
      .number()
      .int()
      .describe("Process exit code. A value of 0 indicates success."),
    stdout: z.string().describe("Standard output produced by the process."),
    stderr: z
      .string()
      .describe(
        "Standard error output produced by the process, including warnings and errors.",
      ),
  })
  .describe(
    "Result of executing a command, including its exit code and any output written to standard output or standard error.",
  );

export type ExecResult = z.infer<typeof execResultSchema>;

/**
 * Run a subprocess and capture its output. Resolves `command` on
 * `PATH` (skip with `disableWhich`), spawns it with `args` from
 * `ROOT_DIR`, and pipes stdout/stderr - both are collected and returned
 * trimmed on an {@link ExecResult}. stdin is inherited unless `input`
 * is supplied, in which case that string is written to the child's
 * stdin and the stream is closed.
 *
 * Throws when the child exits non-zero, unless `disableCheck` is set -
 * then the non-zero `exitCode` is returned on the result for the
 * caller to inspect.
 */
export async function exec(
  command: string,
  args?: readonly string[],
  options?: ExecOptions,
): Promise<ExecResult> {
  if (!options?.disableWhich) {
    const filePath = which(command);
    if (!filePath) {
      throw new Error(`Program not found: ${command}`);
    }
    command = filePath;
  }
  const hasInput = options?.input !== undefined;
  if (hasInput && options?.stdin && options.stdin !== "pipe") {
    throw new Error("stdin must be a pipe when input is provided");
  }
  const proc = Bun.spawn([command, ...(args ?? [])], {
    cwd: ROOT_DIR,
    stdout: "pipe",
    stderr: "pipe",
    stdin: hasInput ? "pipe" : "inherit",
    ...options,
  });

  if (hasInput) {
    const stdin = proc.stdin as FileSink;
    await stdin.write(options.input);
    await stdin.end();
  }

  const outText = async (
    out: number | ReadableStream<Uint8Array<ArrayBuffer>>,
  ): Promise<string> => {
    if (typeof out === "number") return Promise.resolve("");
    const text = await new Response(out).text();
    return text.trim();
  };

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    outText(proc.stdout),
    outText(proc.stderr),
  ]);
  if (!options?.disableCheck && exitCode !== 0) {
    const detail = stderr || stdout;
    throw new Error(
      `\`${command} ${(args ?? []).join(" ")}\` failed (exit ${exitCode})${detail ? `: ${detail}` : ""}`,
    );
  }
  return {
    exitCode,
    stdout,
    stderr,
  };
}

export function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/** Narrow an unknown thrown value to its message string. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Shorthand for `bun x <args>`, returning the command's trimmed
 * stdout. Bun is on the PATH because these scripts run under `bun`,
 * so we skip the `which` lookup (`disableWhich`) and the Windows
 * `.cmd` shim that a node-based runner would need.
 */
export async function bunx(
  args: readonly string[],
  options?: ExecOptions,
): Promise<string> {
  return exec("bun", ["x", ...args], { disableWhich: true, ...options }).then(
    (result) => result.stdout,
  );
}

export async function execScript(
  name: string,
  options?: ExecOptions,
): Promise<ExecResult> {
  return exec("bun", ["run", name], {
    disableWhich: true,
    stdout: "inherit",
    stderr: "inherit",
    ...options,
  });
}

/**
 * Lazy WorkspaceClient singleton. Memoized so everything that needs
 * Databricks auth in one script (e.g. the `databricks/...` model
 * flow) shares the same handshake. Returns `null` when no Databricks
 * profile is available (so callers can degrade gracefully instead of
 * throwing in scripts where it's optional).
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

const getGitFilePath = pMemoize(async (): Promise<string | undefined> => {
  const filePath = which("git");
  return filePath || undefined;
});

/**
 * Env var holding the script agent's model spec as `provider/model`
 * (e.g. `openai/gpt-4o`, `anthropic/claude-sonnet-4`,
 * `google/gemini-2.5-pro`, `ollama/qwen3-coder:30b`,
 * `groq/llama-3.3-70b`, `databricks/<endpoint>`). Unset means no
 * script agent.
 */
const MODEL_PROVIDER_ENV = "SCRIPT_MODEL_PROVIDER";

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
    outputSchema: execResultSchema,
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
      const result = await exec(dockerCommand, args, {
        input: code,
        timeout: 10_000,
        disableCheck: true,
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
  const rel = relative(ROOT_DIR, base);
  if (rel === "") return "the dbx-tools-js repo root";
  if (rel.startsWith("..")) return base;
  return `${rel} (under the dbx-tools-js repo)`;
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
          error: errorMessage(err),
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
            error: errorMessage(err),
          };
        }
      }),
    }),
  });
}

/** Wraps a git invocation with our standard subprocess defaults. */
export async function git(args: string[], options?: ExecOptions): Promise<ExecResult> {
  const gitFilePath = await getGitFilePath();
  if (!gitFilePath) throw new Error("git not found");
  return exec(gitFilePath, args, { disableWhich: true, ...options });
}

/**
 * Build the `git_status` / `git_diff` / `git_log` tool trio for the
 * agent, all rooted at {@link ROOT_DIR}. Returns `undefined` when `git`
 * isn't on PATH, so callers drop the tools silently on
 * git-less hosts (matching the {@link createExecuteTypescriptTool}
 * pattern). Tools accept an optional path filter (relative to the
 * repo root) for drilling into a specific file or subdir.
 */
async function createGitTools() {
  const gitFilePath = await getGitFilePath();
  if (!gitFilePath) return undefined;
  const runGit = async (args: string[]) => {
    return await git(args, { disableWhich: true, disableCheck: true });
  };
  return {
    git_status: createTool({
      id: "git_status",
      description:
        "Show working-tree status as `git status --porcelain` output. " +
        "Use to discover which files in the dbx-tools-js repo " +
        "are modified, added, untracked, or staged.",
      inputSchema: z.object({}),
      outputSchema: execResultSchema,
      execute: async () => await runGit(["status", "--porcelain"]),
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
      outputSchema: execResultSchema,
      execute: async ({ path, stat }) => {
        const args = ["diff"];
        if (stat) args.push("--stat");
        if (path) args.push("--", path);
        return await runGit(args);
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
      outputSchema: execResultSchema,
      execute: async ({ path, limit }) => {
        const args = [
          "log",
          "--no-merges",
          "--pretty=format:%h %s",
          `-n${limit ?? 20}`,
        ];
        if (path) args.push("--", path);
        return await runGit(args);
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
  const dir = join(ROOT_DIR, ".cursor", "rules");
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
You are a code-aware assistant for the dbx-tools-js monorepo (Bun + TypeScript, packages under packages/* and demo/).

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
  /**
   * Model spec as `provider/model` (e.g. `openai/gpt-4o`,
   * `anthropic/claude-sonnet-4`, `ollama/qwen3-coder:30b`,
   * `databricks/<endpoint>`). Defaults to the `SCRIPT_MODEL_PROVIDER`
   * env var; the agent is unavailable (null) when neither is set.
   */
  model?: string;
  /**
   * Base directory for the filesystem tools (`list_files` / `read_files`).
   * Defaults to {@link ROOT_DIR}. Path traversal is refused for anything
   * outside this directory. Use it to scope the agent to a single
   * package (e.g. `cwd: pkg.dir` when generating per-package READMEs)
   * so the agent can't wander the whole repo.
   */
  cwd?: string;
}

/**
 * Build an OpenAI-compatible config that drives a Databricks Model
 * Serving `endpoint` through the OAuth'd {@link getWorkspaceClient}.
 * Returns `undefined` when no workspace client is available (no
 * profile, etc.) so the agent degrades gracefully.
 */
async function buildDatabricksModel(
  endpoint: string,
): Promise<MastraModelConfig | undefined> {
  const client = await getWorkspaceClient();
  if (!client) return undefined;
  const host = (await client.config.getHost()).toString();
  const headers = new Headers();
  await client.config.authenticate(headers);
  // The OpenAI Node SDK appends paths like `/chat/completions` to whatever
  // URL we hand it. Drop the trailing slash so the resulting URL stays
  // well-formed (`/serving-endpoints/chat/completions`).
  const url = new URL("/serving-endpoints", host).toString().replace(/\/$/, "");
  return {
    providerId: "databricks",
    modelId: endpoint,
    url,
    headers: Object.fromEntries(headers.entries()),
  };
}

/**
 * Pull `model` with the local Ollama CLI, then return a provider model
 * pointed at the local daemon. Returns `undefined` when the `ollama`
 * binary isn't on `PATH`, so the agent degrades instead of erroring.
 *
 * ollama-ai-provider-v2 (3.5.1) never sends keep_alive on the
 * chat/generate path, so Ollama keeps the model resident for its
 * default 5m idle after the script exits. A keep-alive fetch shim
 * splices keep_alive into the request body so the model unloads
 * shortly after the run.
 */
async function buildOllamaModel(model: string): Promise<MastraModelConfig | undefined> {
  const ollamaFilePath = Bun.which("ollama");
  if (!ollamaFilePath) return undefined;
  await exec(ollamaFilePath, ["pull", model], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const { createOllama } = await import("ollama-ai-provider-v2");
  // The cast is needed because `OllamaProviderSettings.fetch` is the
  // global `fetch` type, which also carries a static `preconnect` the
  // provider never calls.
  const keepAliveFetch = ((
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    if (typeof init?.body === "string") {
      try {
        init = {
          ...init,
          body: JSON.stringify({ ...JSON.parse(init.body), keep_alive: "30s" }),
        };
      } catch {
        // non-JSON body (shouldn't happen for chat): leave untouched
      }
    }
    return fetch(input, init);
  }) as typeof fetch;
  return createOllama({ fetch: keepAliveFetch })(model);
}

/**
 * Resolve a `provider/model` spec into a Mastra model config. Split on
 * the first `/` only, so model ids that carry their own separators
 * stay intact (`ollama/qwen3-coder:30b` -> provider `ollama`, model
 * `qwen3-coder:30b`).
 *
 *   - `databricks/<endpoint>`: Databricks Model Serving via the OAuth'd
 *     {@link buildDatabricksModel} flow.
 *   - `ollama/<model>`: pull and serve from the local Ollama daemon via
 *     {@link buildOllamaModel}.
 *   - anything else (`openai/...`, `anthropic/...`, `google/...`,
 *     `groq/...`): hand the spec to Mastra's model router, which
 *     resolves it from that provider's own env credentials.
 *
 * Returns `undefined` when `spec` is empty (no env configured).
 */
async function buildScriptModel(
  spec: string | undefined,
): Promise<MastraModelConfig | undefined> {
  if (!spec) return undefined;
  const slash = spec.indexOf("/");
  const provider = slash === -1 ? "" : spec.slice(0, slash);
  const model = slash === -1 ? spec : spec.slice(slash + 1);
  if (!model) return undefined;
  if (provider === "databricks") return buildDatabricksModel(model);
  if (provider === "ollama") return buildOllamaModel(model);
  // openai / anthropic / google / groq / ... -> Mastra provider defaults.
  return spec;
}

/**
 * Lazily build a Mastra agent that can read files under {@link ROOT_DIR}
 * via the `read_files` tool. Memoized per `(instructions, model)`
 * pair so repeated `agentQuery()` calls in one script reuse the
 * same agent and the auth handshake from {@link getWorkspaceClient}.
 *
 * Returns `null` when no model spec resolves (no `overrides.model`
 * and no `SCRIPT_MODEL_PROVIDER`, or the chosen provider is
 * unavailable) so callers can degrade gracefully.
 */
export const getScriptAgent = pMemoize(
  async (overrides: ScriptAgentOverrides = {}): Promise<Agent | null> => {
    const spec = overrides.model ?? process.env[MODEL_PROVIDER_ENV];
    const model = await buildScriptModel(spec);
    if (!model) return null;
    const base = overrides.cwd ?? ROOT_DIR;
    const gitTools = await createGitTools();
    const sandbox = createExecuteTypescriptTool();
    // Always append the .cursor/rules block so per-script overrides
    // (release notes prompt, README generator prompt, ...) still get
    // the repo conventions (package map, dry-helpers, docstring style)
    // without each caller having to glue them in by hand.
    const rules = loadCursorRules();
    const baseInstructions = overrides.instructions ?? DEFAULT_AGENT_INSTRUCTIONS;
    const instructions = rules ? `${baseInstructions}\n\n${rules}` : baseInstructions;
    return new Agent({
      id: "dbx-tools-script-agent",
      name: "dbx-tools-script-agent",
      instructions,
      model: model,
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
 * Run `prompt` + optional structured `ctx` through a Mastra agent that
 * can call the `read_files` tool to inspect repo files on demand. Use
 * when the LLM needs to cite or summarize specific source files.
 *
 * Returns `null` on any failure (empty content, no resolvable model,
 * exhausted retries) so callers can keep the
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
  // Retry the whole stream pass when the upstream LLM API returns a
  // retryable error (typically Databricks FMAPI's per-minute
  // `REQUEST_LIMIT_EXCEEDED` 429s during back-to-back package syncs).
  // Each attempt is a fresh `agent.stream()` call, so any tool
  // history from the failed attempt is replayed.
  for (let attempt = 0; attempt <= _RETRY_DELAYS_MS.length; attempt++) {
    const { text, error } = await _streamOnce(agent, content);
    if (text) return text;
    if (!_isRetryable(error)) {
      if (error) console.log(`[tool] non-retryable error; giving up`);
      return null;
    }
    if (attempt === _RETRY_DELAYS_MS.length) {
      const label = _isRateLimit(error) ? "rate-limit" : "retryable error";
      console.log(
        `[tool] giving up after ${_RETRY_DELAYS_MS.length} retries (${label})`,
      );
      return null;
    }
    const baseDelay = _RETRY_DELAYS_MS[attempt]!;
    const jitter = Math.floor(Math.random() * 1000);
    const delay = baseDelay + jitter;
    const cause = _isRateLimit(error) ? "rate-limit" : "retryable";
    console.log(
      `[tool] ${cause} backoff: sleeping ${delay}ms ` +
        `(attempt ${attempt + 1}/${_RETRY_DELAYS_MS.length})`,
    );
    await new Promise((r) => setTimeout(r, delay));
  }
  return null;
}

/**
 * Backoff schedule for upstream LLM retries. Sized to outwait a
 * Databricks FMAPI per-minute window with growing jitter so multiple
 * concurrent script runs don't all hammer the limit at the same
 * second. Last slot is ~90s + jitter so a single retryable run can
 * survive a full token-bucket refill cycle.
 */
const _RETRY_DELAYS_MS = [5000, 15000, 45000, 90000];

/**
 * Detect retryable LLM API errors. Honors the Vercel AI SDK's
 * `isRetryable` flag when present, then falls back to HTTP status
 * codes that are universally safe to retry (429 rate-limit, 5xx
 * transient gateway errors).
 */
function _isRetryable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { isRetryable?: unknown; statusCode?: unknown };
  if (e.isRetryable === true) return true;
  const code = typeof e.statusCode === "number" ? e.statusCode : 0;
  return code === 429 || code === 502 || code === 503 || code === 504;
}

/**
 * Narrow predicate for HTTP 429 / Databricks FMAPI
 * `REQUEST_LIMIT_EXCEEDED` responses. Used to flag the rate-limit
 * case explicitly in the backoff and give-up log lines so the cause
 * is obvious when scrolling a noisy run.
 */
function _isRateLimit(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { statusCode?: unknown; responseBody?: unknown };
  if (e.statusCode === 429) return true;
  if (
    typeof e.responseBody === "string" &&
    e.responseBody.includes("REQUEST_LIMIT_EXCEEDED")
  ) {
    return true;
  }
  return false;
}

/**
 * Render a Vercel AI SDK `AI_APICallError` (or any error-shaped
 * object) as a single line for the `[tool] upstream error ...` log.
 * Pulls the HTTP status when available, parses the JSON
 * `responseBody` so Databricks' `REQUEST_LIMIT_EXCEEDED` reason
 * appears verbatim, and truncates anything longer than `maxLen` so
 * the log line stays one row in a normal terminal.
 */
function _summarizeApiError(err: unknown, maxLen = 240): string {
  if (err === null || err === undefined) return "unknown error";
  if (typeof err !== "object") return String(err);
  const e = err as {
    statusCode?: number;
    message?: string;
    name?: string;
    responseBody?: string;
    url?: string;
  };
  const parts: string[] = [];
  if (typeof e.statusCode === "number") parts.push(`status ${e.statusCode}`);
  if (typeof e.name === "string" && e.name && e.name !== "Error") {
    parts.push(e.name);
  }
  let detail: string | undefined;
  if (typeof e.responseBody === "string" && e.responseBody) {
    try {
      const parsed = JSON.parse(e.responseBody) as {
        error_code?: string;
        message?: string;
      };
      if (parsed?.error_code && parsed?.message) {
        detail = `${parsed.error_code}: ${parsed.message}`;
      } else {
        detail = parsed?.message ?? parsed?.error_code;
      }
    } catch {
      detail = e.responseBody;
    }
  }
  if (!detail && typeof e.message === "string") detail = e.message;
  if (detail) parts.push(detail.replace(/\s+/g, " ").trim());
  const line = parts.join(" | ");
  if (line.length <= maxLen) return line;
  return `${line.slice(0, maxLen - 3)}...`;
}

/**
 * Run one agent.stream() pass, log tool activity, and return the
 * final text along with any error event observed mid-stream.
 *
 * Mastra's stream handler swallows upstream errors and resolves
 * `stream.text` to an empty string instead of throwing, so we read
 * `type: "error"` events from `fullStream` ourselves to surface the
 * underlying `AI_APICallError`. The caller uses that to decide
 * whether to retry.
 */
async function _streamOnce(
  agent: Agent,
  content: string,
): Promise<{ text: string | null; error: unknown }> {
  let streamError: unknown = null;
  // Default `maxSteps` is conservative; bump so the agent has room
  // to chain several tool calls (read_files / git_log / etc.) before
  // it has to commit to a final answer. Tag + readme runs typically
  // settle in well under this cap.
  const stream = await agent.stream(content, { maxSteps: 32 });
  // Surface tool activity inline so long-running scripts (`readme.ts`,
  // `tag.ts`) show concrete progress. Format matches the `[scope]`
  // convention the rest of the runtime uses (`[mastra]`, `[autopg]`).
  for await (const event of stream.fullStream) {
    if (event.type === "tool-call") {
      const { toolName, args } = event.payload;
      if (toolName) {
        console.log(`[tool] call ${toolName}(${_summarizeArgs(args)})`);
      }
    } else if (event.type === "tool-result") {
      const { toolName, result, isError } = event.payload;
      if (toolName) {
        const verb = isError ? "fail" : "done";
        console.log(`[tool] ${verb} ${toolName} (${_summarizeResult(result)})`);
      }
    } else if (event.type === "error") {
      const err = event.payload?.error ?? streamError;
      streamError = err;
      // Surface the upstream cause immediately so the user sees a
      // concrete reason (e.g. `status 429 | REQUEST_LIMIT_EXCEEDED:
      // Exceeded workspace input tokens per minute...`) even when
      // the retry loop will swallow the failure. The retry / give-up
      // log lines downstream are intentionally short because this
      // line carries the detail.
      const label = _isRateLimit(err) ? "rate-limit" : "upstream error";
      console.log(`[tool] ${label}: ${_summarizeApiError(err)}`);
    }
  }
  const text = (await stream.text)?.trim() || null;
  return { text, error: streamError };
}

/**
 * Render tool-call args as a compact single-line string for the
 * `[tool] call ...` log line. Strings stay raw; everything else is
 * JSON-stringified with whitespace collapsed, then truncated with a
 * char-count suffix so absurdly large args don't blow out the
 * terminal.
 */
function _summarizeArgs(args: unknown, maxLen = 160): string {
  if (args === undefined || args === null) return "";
  let s: string;
  try {
    s = typeof args === "string" ? args : JSON.stringify(args);
  } catch {
    s = String(args);
  }
  s = s.replace(/\s+/g, " ").trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 3)}... (${s.length} chars)`;
}

/**
 * Render a tool result as a short summary. Reports the top-level
 * array length when present (so `read_files` → `2 files, 1.2KB`,
 * `list_files` → `7 entries, 340B`) and falls back to a raw byte
 * count for opaque payloads.
 */
function _summarizeResult(result: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(result) ?? "";
  } catch {
    json = String(result);
  }
  const bytes = _humanBytes(json.length);
  if (Array.isArray(result)) return `${result.length} items, ${bytes}`;
  if (result && typeof result === "object") {
    for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
      if (Array.isArray(value)) return `${value.length} ${key}, ${bytes}`;
    }
  }
  return bytes;
}

function _humanBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}
