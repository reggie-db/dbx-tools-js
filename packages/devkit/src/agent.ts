// Mastra script agent: a tool-using LLM that can read repo files, run
// git, and execute sandboxed TypeScript, used by readme/tag/release.

import { WorkspaceClient } from "@databricks/sdk-experimental";
import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import { createTool } from "@mastra/core/tools";
import { $ } from "bun";
import { consola } from "consola";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import pMemoize from "p-memoize";
import { z } from "zod";
import { git, isGitRepo } from "./git.js";
import { getProject } from "./project.js";
import { errorMessage } from "./script.js";
import { sh } from "./shell.js";

const project = await getProject();
const root = project.rootDirectory;
const projectName = project.name;
const log = consola.withTag("agent");

/** Env var holding the agent's model spec as `provider/model`. Unset means no agent. */
const MODEL_PROVIDER_ENV = "SCRIPT_MODEL_PROVIDER";

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

/** Lazy, memoized {@link WorkspaceClient}; `null` when no Databricks profile resolves. */
export const getWorkspaceClient = pMemoize(
  async (): Promise<WorkspaceClient | null> => {
    try {
      return new WorkspaceClient({});
    } catch (error) {
      log.error("Error creating workspace client:", error);
      return null;
    }
  },
);

/**
 * `execute_typescript` tool backed by a sandboxed container runtime
 * (docker or podman). `undefined` when neither is on PATH. Pipes the
 * code into `bun run -` inside `oven/bun:1` over stdin, offline, with
 * tight CPU/memory/pid limits and all capabilities dropped.
 */
function createExecuteTypescriptTool() {
  const dockerCommand = ["docker", "podman"].find((cmd) => Bun.which(cmd));
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
        dockerCommand,
        "run",
        "--rm",
        "-i",
        "--network=none",
        "--memory=256m",
        "--cpus=1",
        "--cap-drop=ALL",
        "--pids-limit=64",
        "-w",
        "/tmp",
        "oven/bun:1",
        "bun",
        "run",
        "-",
      ];
      return await sh(args, { input: code, nothrow: true, quiet: true });
    },
  });
}

/* ----------------------- mastra agent (tool-using) ----------------------- */

/** Resolve `relPath` against `base`, refusing anything that escapes the scope. */
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
  const rel = relative(root, base);
  if (rel === "") return `the ${projectName} repo root`;
  if (rel.startsWith("..")) return base;
  return `${rel} (under the ${projectName} repo)`;
}

/** `list_files` tool scoped to `base`: immediate children of a directory. */
function createListFilesTool(base: string) {
  return createTool({
    id: "list_files",
    description:
      `List files and directories under ${scopeLabel(base)}. ` +
      "`path` is an optional directory path relative to that scope " +
      "(e.g. 'src' or a nested subdirectory). Defaults to the scope " +
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

/** `read_files` tool scoped to `base`: batched UTF-8 reads with optional line ranges. */
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

/**
 * `git_status` / `git_diff` / `git_log` tool trio rooted at the repo
 * root. `undefined` when git isn't installed or the root isn't a git
 * repo (the tools are optional context for the agent, so we skip them
 * rather than fail). Each accepts an optional repo-relative path filter.
 */
async function createGitTools() {
  if (!(await isGitRepo(root))) return undefined;
  const runGit = (args: string[]): Promise<ExecResult> =>
    git(args, { nothrow: true, cwd: root });
  return {
    git_status: createTool({
      id: "git_status",
      description:
        "Show working-tree status as `git status --porcelain` output. " +
        `Use to discover which files in the ${projectName} repo ` +
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
 * Read `.cursor/rules/*.mdc` once, strip frontmatter, and return them
 * as one markdown block for the system prompt (empty when missing).
 * Cached at module scope; rule edits need a process restart.
 */
let cachedCursorRules: string | undefined;
function loadCursorRules(): string {
  if (cachedCursorRules !== undefined) return cachedCursorRules;
  const dir = join(root, ".cursor", "rules");
  if (!existsSync(dir)) return (cachedCursorRules = "");
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".mdc"))
      .sort();
  } catch {
    return (cachedCursorRules = "");
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
  cachedCursorRules = sections.length
    ? `## Repo conventions (from .cursor/rules)\n\n${sections.join("\n\n")}`
    : "";
  return cachedCursorRules;
}

const DEFAULT_AGENT_INSTRUCTIONS = `
You are a code-aware assistant for the ${projectName} monorepo (Bun + TypeScript workspaces).

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
  /** Override the system instructions. Defaults to a repo-aware preamble. */
  instructions?: string;
  /** Model spec as `provider/model`. Defaults to `SCRIPT_MODEL_PROVIDER`. */
  model?: string;
  /** Base directory for the filesystem tools. Defaults to the repo root. */
  cwd?: string;
}

/**
 * OpenAI-compatible config driving a Databricks Model Serving
 * `endpoint` through the OAuth'd {@link getWorkspaceClient}.
 * `undefined` when no workspace client is available.
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
 * pointed at the local daemon. `undefined` when `ollama` isn't on PATH.
 * A keep-alive fetch shim splices `keep_alive` into the request body
 * so the model unloads shortly after the run.
 */
async function buildOllamaModel(model: string): Promise<MastraModelConfig | undefined> {
  if (!Bun.which("ollama")) return undefined;
  await $`ollama pull ${model}`;
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
 * Resolve a `provider/model` spec into a Mastra model config (split on
 * the first `/` only). `databricks/*` and `ollama/*` route through the
 * helpers above; anything else goes to Mastra's model router.
 * `undefined` when `spec` is empty.
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
 * Lazily build a Mastra agent scoped to the repo (or `overrides.cwd`),
 * memoized per `(instructions, model, cwd)`. `null` when no model spec
 * resolves so callers can degrade gracefully.
 */
export const getScriptAgent = pMemoize(
  async (overrides: ScriptAgentOverrides = {}): Promise<Agent | null> => {
    const spec = overrides.model ?? process.env[MODEL_PROVIDER_ENV];
    const model = await buildScriptModel(spec);
    if (!model) return null;
    const base = overrides.cwd ?? root;
    const gitTools = await createGitTools();
    const sandbox = createExecuteTypescriptTool();
    // Always append the .cursor/rules block so per-command overrides
    // (release notes prompt, README generator prompt, ...) still get
    // the repo conventions without each caller gluing them in by hand.
    const rules = loadCursorRules();
    const baseInstructions = overrides.instructions ?? DEFAULT_AGENT_INSTRUCTIONS;
    const instructions = rules ? `${baseInstructions}\n\n${rules}` : baseInstructions;
    const agentName = `${projectName}-script-agent`;
    return new Agent({
      id: agentName,
      name: agentName,
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
 * Run `prompt` + optional structured `ctx` through the script agent.
 * `null` on any failure (empty content, no model, exhausted retries)
 * so callers can keep the `await agentQuery(...) ?? fallback` pattern.
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
  // Retry the whole stream pass on retryable upstream errors (typically
  // Databricks FMAPI per-minute 429s during back-to-back syncs). Each
  // attempt is a fresh `agent.stream()` call.
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const { text, error } = await streamOnce(agent, content);
    if (text) return text;
    if (!isRetryable(error)) {
      if (error) log.warn("non-retryable error; giving up");
      return null;
    }
    if (attempt === RETRY_DELAYS_MS.length) {
      const label = isRateLimit(error) ? "rate-limit" : "retryable error";
      log.warn(`giving up after ${RETRY_DELAYS_MS.length} retries (${label})`);
      return null;
    }
    const baseDelay = RETRY_DELAYS_MS[attempt]!;
    const jitter = Math.floor(Math.random() * 1000);
    const delay = baseDelay + jitter;
    const cause = isRateLimit(error) ? "rate-limit" : "retryable";
    log.info(
      `${cause} backoff: sleeping ${delay}ms ` +
        `(attempt ${attempt + 1}/${RETRY_DELAYS_MS.length})`,
    );
    await new Promise((r) => setTimeout(r, delay));
  }
  return null;
}

/** Backoff schedule for upstream LLM retries (last slot ~90s + jitter). */
const RETRY_DELAYS_MS = [5000, 15000, 45000, 90000];

/** Retryable LLM API errors: AI SDK `isRetryable`, or 429/502/503/504. */
function isRetryable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { isRetryable?: unknown; statusCode?: unknown };
  if (e.isRetryable === true) return true;
  const code = typeof e.statusCode === "number" ? e.statusCode : 0;
  return code === 429 || code === 502 || code === 503 || code === 504;
}

/** HTTP 429 / Databricks FMAPI `REQUEST_LIMIT_EXCEEDED` predicate. */
function isRateLimit(err: unknown): boolean {
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

/** Render an `AI_APICallError` (or error-shaped object) as one log line. */
function summarizeApiError(err: unknown, maxLen = 240): string {
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
 * Run one `agent.stream()` pass, log tool activity, and return the
 * final answer plus any error event.
 *
 * Mastra streams the model's inter-step commentary (e.g. "Let me check
 * the files first.") as `text-delta` chunks *before* each `tool-call`,
 * in the same stream as the final answer. `stream.text` concatenates
 * every text block, so the commentary ends up glued to the answer. We
 * instead accumulate `text-delta` chunks and reset the buffer on every
 * `tool-call`, leaving only the text emitted after the last tool call -
 * the real answer.
 *
 * Errors are surfaced via `type: "error"` chunks because Mastra
 * swallows upstream failures and resolves the text to "".
 */
async function streamOnce(
  agent: Agent,
  content: string,
): Promise<{ text: string | null; error: unknown }> {
  let streamError: unknown = null;
  let answer = "";
  // Bump `maxSteps` so the agent can chain several tool calls before
  // committing to a final answer.
  const stream = await agent.stream(content, { maxSteps: 32 });
  for await (const event of stream.fullStream) {
    if (event.type === "text-delta") {
      const delta = event.payload?.text;
      if (typeof delta === "string") answer += delta;
    } else if (event.type === "tool-call") {
      // Anything streamed before a tool call is working commentary, not
      // the answer; drop it and keep only what follows the last call.
      answer = "";
      const { toolName, args } = event.payload;
      if (toolName) {
        log.info(`call ${toolName}(${summarizeArgs(args)})`);
      }
    } else if (event.type === "tool-result") {
      const { toolName, result, isError } = event.payload;
      if (toolName) {
        const verb = isError ? "fail" : "done";
        log.info(`${verb} ${toolName} (${summarizeResult(result)})`);
      }
    } else if (event.type === "error") {
      const err = event.payload?.error ?? streamError;
      streamError = err;
      const label = isRateLimit(err) ? "rate-limit" : "upstream error";
      log.warn(`${label}: ${summarizeApiError(err)}`);
    }
  }
  const text = answer.trim() || null;
  return { text, error: streamError };
}

/** Render tool-call args as a compact single-line string. */
function summarizeArgs(args: unknown, maxLen = 160): string {
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

/** Render a tool result as a short `<n> <key>, <bytes>` summary. */
function summarizeResult(result: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(result) ?? "";
  } catch {
    json = String(result);
  }
  const bytes = humanBytes(json.length);
  if (Array.isArray(result)) return `${result.length} items, ${bytes}`;
  if (result && typeof result === "object") {
    for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
      if (Array.isArray(value)) return `${value.length} ${key}, ${bytes}`;
    }
  }
  return bytes;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}
