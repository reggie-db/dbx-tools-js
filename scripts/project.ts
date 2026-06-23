import pMemoize from "p-memoize";
import {
  createFileSystemProject,
  CreateFileSystemProjectOptions,
  FileSystemProject,
  PacwichError,
} from "pacwich";
import {
  getWorkspaceScriptMetadata as loadWorkspaceScriptMetadata,
  WorkspaceScriptMetadataKey,
} from "pacwich/script";

const WORKSPACE_SCRIPT_METADATA_KEYS = Object.keys({
  scriptName: true,
  projectPath: true,
  projectName: true,
  workspacePath: true,
  workspaceRelativePath: true,
  workspaceName: true,
} satisfies Record<WorkspaceScriptMetadataKey, true>) as WorkspaceScriptMetadataKey[];

export type Project = FileSystemProject & {
  workspaceScriptProject: boolean;
};

export const getProject = pMemoize(async (): Promise<Project> => {
  const workspaceScriptMetadata = getWorkspaceScriptMetadata();
  const projectPath = workspaceScriptMetadata?.projectPath;
  const options: CreateFileSystemProjectOptions = {};
  let workspaceScriptProject = false;
  if (projectPath) {
    options.rootDirectory = projectPath;
    workspaceScriptProject = true;
  }
  const project = createProject(options);
  (project as any).workspaceScriptProject = workspaceScriptProject;
  return project as Project;
});

function createProject(options?: CreateFileSystemProjectOptions): FileSystemProject {
  const project = createFileSystemProject(options ?? {});
  const shell = process.env.PACWICH_SHELL_DEFAULT as
    | FileSystemProject["config"]["project"]["defaults"]["shell"]
    | undefined;
  if (shell) project.config.project.defaults.shell = shell;
  return project;
}

function getWorkspaceScriptMetadata(): Record<WorkspaceScriptMetadataKey, string> {
  let metadata: Partial<Record<WorkspaceScriptMetadataKey, string>> | undefined;
  for (const key of WORKSPACE_SCRIPT_METADATA_KEYS) {
    const value = getWorkspaceScriptMetadataValue(key);
    if (value) {
      if (!metadata) metadata = {};
      metadata[key] = value;
    } else {
      break;
    }
  }
  if (!metadata) return undefined;
  return metadata as Record<WorkspaceScriptMetadataKey, string>;
}

function getWorkspaceScriptMetadataValue(
  key: WorkspaceScriptMetadataKey,
): string | undefined {
  try {
    const value = loadWorkspaceScriptMetadata(key);
    if (value) return value;
  } catch (error) {
    if (!(error instanceof PacwichError)) {
      throw error;
    }
  }
  return undefined;
}
