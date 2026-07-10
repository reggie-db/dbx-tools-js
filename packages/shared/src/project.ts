/**
 * Project introspection helpers shared across dbx-tools packages.
 *
 * Resolve workspace roots, human-friendly project names, and parse git
 * remote URLs into repo names. Exposed as `projectUtils.*` from the
 * shared barrel so naming inside this module drops the redundant
 * `project` prefix: `projectUtils.name()` instead of `projectName()`,
 * etc.
 *
 * **Server-only.** Imports `node:fs`, `node:path`, `node:child_process`,
 * and `node:util` at module load. Browser bundles must use
 * `@dbx-tools/shared`'s `index.client.ts` entry point, which
 * skips this module entirely.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { memoize } from "./common.js";
import { stat } from "./file.js";
import { logger } from "./log.js";

const log = logger("project");
const execFileAsync = promisify(execFile);

interface PackageJson {
  name?: string;
  workspaces?: unknown;
}

const nameDefault = memoize(() => resolveProjectName(process.cwd()));

/**
 * Resolve a human-friendly project name for the repo rooted at `cwd`.
 *
 * Order:
 * 1. `name` from the root `package.json` (via `npm pkg get name` when
 *    available, otherwise read the file after locating the root).
 * 2. Repository name from `git remote get-url origin`.
 * 3. Basename of the project root directory.
 *
 * When `cwd` is omitted or equals `process.cwd()`, the result is
 * memoized for the process lifetime.
 */
export function name(cwd?: string): Promise<string> {
  return cwd && resolve(cwd) !== process.cwd()
    ? resolveProjectName(cwd)
    : nameDefault();
}

const rootDefault = memoize(() => resolveWorkspaceRoot(process.cwd()));

/**
 * Resolve the workspace root directory for `cwd`: the nearest ancestor
 * (from {@link resolveProjectRoots} candidates) that contains a
 * `package.json` file. When `cwd` is omitted or equals `process.cwd()`,
 * the result is memoized for the process lifetime.
 */
export function root(cwd?: string): Promise<string> {
  return cwd && resolve(cwd) !== process.cwd()
    ? resolveWorkspaceRoot(cwd)
    : rootDefault();
}

/**
 * Parse a git remote URL (`https://...`, `git@host:owner/repo.git`, etc.)
 * and return the repo segment, stripping any `.git` suffix. Returns
 * `undefined` for empty or unparsable input.
 */
export function parseGitRemote(url: string): string | undefined {
  const trimmed = url.trim();
  if (!trimmed) {
    return undefined;
  }

  const scp = /^[^@]+@[^:]+:(.+)$/i.exec(trimmed);
  if (scp) {
    const segment = scp[1];
    return lastPathSegment(segment ?? "");
  }

  try {
    const normalized = trimmed.replace(/\.git$/i, "");
    const pathname = new URL(normalized).pathname;
    const segment = pathname.split("/").filter(Boolean).at(-1);
    return segment ? lastPathSegment(segment) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a display name for the project rooted at `cwd`. Prefer
 * {@link name} unless you need the intermediate root path from
 * {@link root}.
 */
export async function resolveProjectName(cwd: string): Promise<string> {
  const workspaceRoot = await resolveWorkspaceRoot(cwd);

  const fromPackage =
    (await readNameViaNpm(workspaceRoot)) ?? readNameFromPackageJson(workspaceRoot);
  if (fromPackage) {
    return fromPackage;
  }

  const fromGit = await readNameFromGitRemote(workspaceRoot);
  if (fromGit) {
    return fromGit;
  }

  return basename(workspaceRoot);
}

/**
 * Pick the first {@link resolveProjectRoots} candidate whose tree
 * contains a `package.json` file. Falls back to the last yielded root
 * when none have a manifest (typically `cwd`).
 */
async function resolveWorkspaceRoot(cwd?: string): Promise<string> {
  let lastRootDir: string | undefined;
  for await (const rootDir of resolveProjectRoots(cwd)) {
    const pkgStat = await stat(resolve(rootDir, "package.json"));
    if (pkgStat?.isFile()) {
      return rootDir;
    }
    lastRootDir = rootDir;
  }
  return lastRootDir ?? resolve(cwd ?? process.cwd());
}

/**
 * Yield candidate project root directories for `cwd`, in priority order.
 *
 * Each loader is best-effort (`npm` and `git` may be missing or fail):
 *
 * 1. `npm prefix` from `cwd`
 * 2. npm workspace root (`npm root -w` parent)
 * 3. `git rev-parse --show-toplevel` from `cwd`
 * 4. `cwd` itself when every loader fails or yields a non-directory
 *
 * Duplicate paths are skipped. Only paths that {@link stat} reports as
 * directories are yielded (except the final `cwd` fallback).
 */
export async function* resolveProjectRoots(cwd?: string): AsyncGenerator<string> {
  cwd = cwd ? resolve(cwd) : process.cwd();
  let found = false;
  const rootDirs = new Set<string>();
  for (const loader of [npmPrefix, npmWorkspaceRoot, gitTopLevel]) {
    let rootDir: string | undefined = await loader(cwd);

    if (!rootDir) {
      continue;
    }
    rootDir = resolve(rootDir);
    if (rootDirs.has(rootDir)) {
      continue;
    }
    rootDirs.add(rootDir);
    const rootStat = await stat(rootDir);
    if (rootStat?.isDirectory()) {
      found = true;
      yield rootDir;
    }
  }
  yield cwd;
}

const npmPrefixDefault = memoize(() => npmPrefix(process.cwd(), true));

/** Run `npm prefix` from `cwd`. Returns `undefined` when npm is missing. */
async function npmPrefix(
  cwd: string,
  force: boolean = false,
): Promise<string | undefined> {
  if (!force && cwd === process.cwd()) return npmPrefixDefault();
  log.debug("loading npm prefix", { cwd });
  return runNpm(["prefix"], cwd);
}

const npmWorkspaceRootDefault = memoize(() => npmWorkspaceRoot(process.cwd(), true));

/** Workspace root via `npm root -w` (parent of the workspace `node_modules`). */
async function npmWorkspaceRoot(
  cwd: string,
  force: boolean = false,
): Promise<string | undefined> {
  if (!force && cwd === process.cwd()) return npmWorkspaceRootDefault();
  log.debug("loading npm workspace root", { cwd });
  const nodeModules = await runNpm(["root", "-w"], cwd);
  if (!nodeModules) {
    return undefined;
  }
  return dirname(nodeModules);
}

async function runNpm(args: string[], cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("npm", args, {
      cwd,
      encoding: "utf8",
    });
    const value = stdout.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

async function readNameViaNpm(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "npm",
      ["pkg", "get", "name", "--prefix", root],
      { encoding: "utf8" },
    );
    return parseNpmPkgGetValue(stdout);
  } catch {
    return undefined;
  }
}

function parseNpmPkgGetValue(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "string" && parsed.trim()) {
      return parsed.trim();
    }
  } catch {
    return trimmed.replace(/^"|"$/g, "").trim() || undefined;
  }
  return undefined;
}

function readNameFromPackageJson(root: string): string | undefined {
  const pkgPath = resolve(root, "package.json");
  if (!existsSync(pkgPath)) {
    return undefined;
  }
  const pkg = readPackageJson(pkgPath);
  const pkgName = pkg?.name?.trim();
  return pkgName || undefined;
}

function readPackageJson(path: string): PackageJson | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
  } catch {
    return undefined;
  }
}

async function readNameFromGitRemote(root: string): Promise<string | undefined> {
  const url = await gitRemoteOriginUrl(root);
  if (!url) {
    return undefined;
  }
  return parseGitRemote(url);
}

async function gitRemoteOriginUrl(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, "remote", "get-url", "origin"],
      { encoding: "utf8" },
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

const gitTopLevelDefault = memoize(() => gitTopLevel(process.cwd(), true));

/** `git rev-parse --show-toplevel` from `cwd`. */
async function gitTopLevel(
  cwd: string,
  force: boolean = false,
): Promise<string | undefined> {
  if (!force && cwd === process.cwd()) return gitTopLevelDefault();
  log.debug("loading git top level", { cwd });
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "rev-parse", "--show-toplevel"],
      { encoding: "utf8" },
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function lastPathSegment(path: string): string {
  const segment = path.split("/").filter(Boolean).at(-1) ?? path;
  return segment.replace(/\.git$/i, "");
}
