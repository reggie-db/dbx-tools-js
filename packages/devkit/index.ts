/**
 * @dbx-tools/devkit: the monorepo build, scaffold, and release toolkit.
 *
 * The `devkit` bin wraps these same functions as a CLI; importing them
 * directly lets a consuming project compose its own automation (e.g.
 * call `release()` after a custom version step).
 */

export {
  agentQuery,
  getScriptAgent,
  getWorkspaceClient,
  type ScriptAgentOverrides,
} from "./src/agent.js";
export { build } from "./src/build.js";
export { clean } from "./src/clean.js";
export { codegen } from "./src/codegen.js";
export { getDevkitConfig, type DevkitConfig } from "./src/config.js";
export { create, type CreateOptions } from "./src/create.js";
export { format } from "./src/format.js";
export { git } from "./src/git.js";
export {
  WorkspacePackage,
  discoverPackageJsons,
  discoverPackages,
  orderByDependencies,
  toAbsolute,
  toRelative,
  writeJson,
  type PackageJson,
} from "./src/package.js";
export { getProject } from "./src/project.js";
export {
  syncReadmes,
  type SyncReadmesOptions,
  type SyncReadmesResult,
} from "./src/readme.js";
export {
  DEFAULT_REGISTRY,
  release,
  type ReleaseOptions,
  type ReleaseResult,
} from "./src/release.js";
export { errorMessage, fail, nonEmptyLines, runScript } from "./src/script.js";
export { bunx, sh, type ShellResult } from "./src/shell.js";
export { tag, type Bump, type TagOptions } from "./src/tag.js";
export { typecheck } from "./src/typecheck.js";
export { verify } from "./src/verify.js";
