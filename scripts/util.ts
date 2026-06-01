// Shared helpers for the workspace scripts in this directory. Anything
// duplicated across more than one script lives here.
//
// Conventions:
//   - `ROOT` is the monorepo root; `PACKAGES_DIR` is `<root>/packages`.
//   - `discoverPackages()` is the single source of truth for "what's a
//     workspace package?" - every script that walks `packages/` goes
//     through it instead of re-implementing the readdir + filter loop.
//   - JSON read/write helpers preserve the trailing newline so we don't
//     trigger spurious diffs against `prettier --write`.
//   - `run(...)` wraps `execa.execaSync` for one-shot subprocess calls
//     (git, bunx, tsc) with consistent error handling.
//   - `aiQuery()` keeps the Databricks model-serving wiring in one
//     place so any script that wants an LLM summary just calls it.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execaSync, type SyncOptions, type SyncResult } from "execa";
import pMemoize from "p-memoize";
import { serving, WorkspaceClient } from "@databricks/sdk-experimental";
import which from "which";

export const ROOT = resolve(import.meta.dirname, "..");
export const PACKAGES_DIR = resolve(ROOT, "packages");

/** Minimal package.json shape we care about across scripts. */
export interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  [key: string]: unknown;
}

/** A workspace package discovered under `packages/`. */
export interface WorkspacePackage {
  /** Directory name under `packages/` (e.g. `"autopg"`). */
  slug: string;
  /** Absolute path to the package directory. */
  dir: string;
  /** Absolute path to the package's `package.json`. */
  jsonPath: string;
  /** Parsed `package.json` contents. */
  meta: PackageJson;
}

/**
 * Walk `packages/*`, parse each `package.json`, and return the ones
 * that pass `filter`. The default filter keeps every package that
 * isn't marked `"private": true`.
 *
 * Scripts that need extra criteria (e.g. "must have a
 * `tsconfig.build.json`") pass a custom `filter`.
 */
export function discoverPackages(
  filter: (pkg: WorkspacePackage) => boolean = (pkg) => pkg.meta.private !== true,
): WorkspacePackage[] {
  const { globSync } = require("tinyglobby") as typeof import("tinyglobby");
  const jsonPaths = globSync("packages/*/package.json", { cwd: ROOT, absolute: true });
  return jsonPaths
    .map((jsonPath) => {
      const dir = resolve(jsonPath, "..");
      const slug = dir.slice(PACKAGES_DIR.length + 1);
      const meta = readJson<PackageJson>(jsonPath);
      return { slug, dir, jsonPath, meta };
    })
    .filter(filter)
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Parse a JSON file. Throws on missing or invalid JSON. */
export function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/**
 * Serialize `value` and write it to `path`, preserving the original
 * file's trailing newline (or adding one if the file is new). Prevents
 * formatter churn against `prettier --write`.
 */
export function writeJson(path: string, value: unknown): void {
  const trailingNewline = existsSync(path)
    ? readFileSync(path, "utf8").endsWith("\n")
    : true;
  writeFileSync(path, JSON.stringify(value, null, 2) + (trailingNewline ? "\n" : ""));
}

/**
 * Run a subprocess synchronously. Thin wrapper over `execaSync` that
 * defaults `stdio: "inherit"` so output streams to the user, captures
 * stdout/stderr instead when `capture: true`, and aborts the script
 * with a clear message when the child exits non-zero (set
 * `check: false` to opt out of that behavior).
 *
 * Returns the trimmed stdout when capturing, or the empty string when
 * inheriting (because nothing was captured).
 */
export function run(
  command: string,
  args: readonly string[],
  opts: { capture?: boolean; check?: boolean; cwd?: string } = {},
): string {
  const { capture = false, check = true, cwd = ROOT } = opts;
  const execaOpts: SyncOptions = {
    cwd,
    reject: false,
    stdio: capture ? "pipe" : "inherit",
  };
  const result: SyncResult = execaSync(command, args, execaOpts);
  if (check && result.exitCode !== 0) {
    const detail = capture
      ? `: ${String(result.stderr ?? "").trim() || String(result.stdout ?? "").trim()}`
      : "";
    fail(`\`${command} ${args.join(" ")}\` failed (exit ${result.exitCode})${detail}`);
  }
  return String(result.stdout ?? "").trim();
}

/**
 * Shorthand for `bun x <args>`. Resolves the Windows `bunx.cmd` shim
 * automatically. Use this instead of hard-coding the platform check.
 */
export function bunx(
  args: readonly string[],
  opts: { capture?: boolean; check?: boolean; cwd?: string } = {},
): string {
  let bin = which.sync("bunx", { nothrow: true });
  if (!bin) {
    bin = process.platform === "win32" ? "bunx.cmd" : "bunx";
  }
  return run(bin, args, opts);
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
