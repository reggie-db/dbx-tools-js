// Memoized pacwich project handle shared by every command. Under
// `pacwich run` the project root comes from the injected workspace-script
// metadata; run directly it falls back to pacwich's own cwd-based
// discovery, so the toolkit works the same whether it is invoked through
// the `devkit` bin or imported as a library.

import pMemoize from "p-memoize";
import {
  createFileSystemProject,
  type CreateFileSystemProjectOptions,
  type FileSystemProject,
  PacwichError,
} from "pacwich";
import { getWorkspaceScriptMetadata } from "pacwich/script";

type PackageManager = CreateFileSystemProjectOptions["packageManager"];
type ShellDefault = FileSystemProject["config"]["project"]["defaults"]["shell"];

export const getProject = pMemoize(async (): Promise<FileSystemProject> => {
  // Default the package manager to bun (the only one this toolkit's
  // own repo uses, and the one its `bun.lock`-free CI relies on), but
  // honor `PACWICH_PACKAGE_MANAGER` so a consuming repo on pnpm/npm can
  // override without forking. Auto-detection is intentionally avoided:
  // it hinges on which lockfiles happen to be on disk.
  const packageManager =
    (process.env.PACWICH_PACKAGE_MANAGER as PackageManager | undefined) ?? "bun";
  const options: CreateFileSystemProjectOptions = { packageManager };
  const projectPath = readProjectPath();
  if (projectPath) options.rootDirectory = projectPath;
  const project = createFileSystemProject(options);
  const shell = process.env.PACWICH_SHELL_DEFAULT as ShellDefault | undefined;
  if (shell) project.config.project.defaults.shell = shell;
  return project;
});

/**
 * Project root pacwich reports when invoked under `pacwich run`.
 * Returns undefined when run directly (no workspace-script context), in
 * which case pacwich discovers the root from the cwd instead. A
 * {@link PacwichError} means "no metadata available" and is swallowed;
 * anything else propagates.
 */
function readProjectPath(): string | undefined {
  try {
    return getWorkspaceScriptMetadata("projectPath") || undefined;
  } catch (error) {
    if (error instanceof PacwichError) return undefined;
    throw error;
  }
}
