/**
 * @dbx-tools/cli: monorepo scaffold, codegen, verification, and tag helpers.
 *
 * The `dbxtools` bin wraps these same functions as a CLI; importing them
 * directly lets a consuming project compose its own automation.
 */

export { build } from "./build.js";
export {
  AGENT_DEFAULT_TIMEOUT_MS,
  agent,
  agentAvailable,
  agentTimedOut,
  parseCodexStdout,
  resolveAgentPrompt,
  runAgent,
  type AgentCommandOptions,
  type AgentOptions,
  type AgentResult,
} from "./agent.js";
export { codegen } from "./codegen.js";
export { getDbxtoolsConfig, type DbxtoolsConfig } from "./config.js";
export { create, type CreateOptions } from "./create.js";
export { format } from "./format.js";
export { git } from "./git.js";
export {
  WorkspacePackage,
  discoverPackageJsons,
  discoverPackages,
  toAbsolute,
  toRelative,
  writeJson,
  type PackageJson,
} from "./package.js";
export { getProject } from "./project.js";
export { release, type ReleaseOptions } from "./release.js";
export { errorMessage, fail, nonEmptyLines } from "./script.js";
export { bunx, sh, type ShellResult } from "./shell.js";
export { tag, type Bump, type TagOptions } from "./tag.js";
export {
  forwardedUpdateArgs,
  isStableVersion,
  latestStableInRange,
  runBunUpdate,
  stableCaretRange,
  update,
  updateCatalog,
} from "./update.js";
export { verify } from "./verify.js";
