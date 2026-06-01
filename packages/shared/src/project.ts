/**
 * Project introspection helpers shared across AppKit plugins.
 *
 * Resolve a human-friendly project name and parse git remote URLs into
 * repo names. Exposed as `projectUtils.*` from the shared barrel so
 * naming inside this module drops the redundant `project` prefix:
 * `projectUtils.name()` instead of `projectName()`, etc.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const nameByCwd = new Map<string, Promise<string>>();

export interface NameOptions {
  /** Directory to start from. Defaults to `process.cwd()`. */
  cwd?: string;
}

interface PackageJson {
  name?: string;
  workspaces?: unknown;
}

/**
 * Resolve a human-friendly project name for the repo rooted at `cwd`.
 *
 * Order:
 * 1. `name` from the root `package.json` (via `npm pkg get name` when available,
 *    otherwise read the file after locating the root).
 * 2. Repository name from `git remote get-url origin`.
 * 3. Basename of the project root directory.
 */
export function name(options?: NameOptions): Promise<string> {
  const cwd = resolve(options?.cwd ?? process.cwd());
  let pending = nameByCwd.get(cwd);
  if (pending === undefined) {
    pending = resolveProjectName(cwd);
    nameByCwd.set(cwd, pending);
  }
  return pending;
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
    return lastPathSegment(scp[1]);
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

async function resolveProjectName(cwd: string): Promise<string> {
  const root = await findProjectRoot(cwd);

  const fromPackage =
    (await readNameViaNpm(root)) ?? readNameFromPackageJson(root);
  if (fromPackage) {
    return fromPackage;
  }

  const fromGit = await readNameFromGitRemote(root);
  if (fromGit) {
    return fromGit;
  }

  return basename(root);
}

async function findProjectRoot(startDir: string): Promise<string> {
  const cwd = resolve(startDir);

  const fromNpmWorkspace = await npmWorkspaceRoot(cwd);
  if (fromNpmWorkspace && hasPackageJson(fromNpmWorkspace)) {
    return preferWorkspacesRoot(fromNpmWorkspace);
  }

  const fromNpmPrefix = await npmPrefix(cwd);
  if (fromNpmPrefix && hasPackageJson(fromNpmPrefix)) {
    return preferWorkspacesRoot(fromNpmPrefix);
  }

  const walked = walkUpForPackageRoot(cwd);
  if (walked) {
    return walked;
  }

  const fromGit = await gitTopLevel(cwd);
  if (fromGit && hasPackageJson(fromGit)) {
    return fromGit;
  }

  return cwd;
}

function preferWorkspacesRoot(startDir: string): string {
  return walkUpForPackageRoot(startDir) ?? startDir;
}

function walkUpForPackageRoot(startDir: string): string | undefined {
  let dir = resolve(startDir);
  let topmost: string | undefined;
  let workspacesRoot: string | undefined;

  while (true) {
    const pkgPath = resolve(dir, "package.json");
    if (existsSync(pkgPath)) {
      topmost = dir;
      const pkg = readPackageJson(pkgPath);
      if (pkg?.workspaces !== undefined) {
        workspacesRoot = dir;
      }
    }

    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return workspacesRoot ?? topmost;
}

function hasPackageJson(dir: string): boolean {
  return existsSync(resolve(dir, "package.json"));
}

async function npmPrefix(cwd: string): Promise<string | undefined> {
  return runNpm(["prefix"], cwd);
}

async function npmWorkspaceRoot(cwd: string): Promise<string | undefined> {
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

async function gitTopLevel(cwd: string): Promise<string | undefined> {
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
