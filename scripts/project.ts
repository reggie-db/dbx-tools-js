// Memoized pacwich project handle shared by every script. Under
// `pacwich run` the project root comes from the injected workspace-script
// metadata; run directly (`bun run <script>`) it falls back to pacwich's
// own cwd-based discovery.

import pMemoize from "p-memoize";
import {
  createFileSystemProject,
  type CreateFileSystemProjectOptions,
  type FileSystemProject,
  PacwichError,
} from "pacwich";
import { getWorkspaceScriptMetadata } from "pacwich/script";

type ShellDefault = FileSystemProject["config"]["project"]["defaults"]["shell"];

export const getProject = pMemoize(async (): Promise<FileSystemProject> => {
  const options: CreateFileSystemProjectOptions = {};
  const projectPath = readProjectPath();
  if (projectPath) options.rootDirectory = projectPath;
  const project = createFileSystemProject(options);
  const shell = process.env.PACWICH_SHELL_DEFAULT as ShellDefault | undefined;
  if (shell) project.config.project.defaults.shell = shell;
  return project;
});

/**
 * Project root pacwich reports when the script runs under `pacwich run`.
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
