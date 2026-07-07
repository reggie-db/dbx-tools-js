// Workspace package discovery and manifest editing, all sourced from
// the pacwich project so no command re-walks the workspace tree itself.

import { isAbsolute, join, relative, resolve } from "node:path";
import { type Workspace } from "pacwich";
import { getProject } from "./project.js";

const root = (await getProject()).rootDirectory;

/** Minimal package.json shape the commands care about. */
export interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  workspaces?: string[];
  [key: string]: unknown;
}

/** A workspace package: its parsed manifest, location, and dependency edges. */
export class WorkspacePackage {
  readonly dir: string;
  readonly slug: string;
  readonly jsonPath: string;

  private constructor(
    readonly meta: PackageJson,
    dir: string,
  ) {
    this.dir = dir;
    this.slug = relative(root, dir);
    this.jsonPath = join(dir, "package.json");
  }

  /** Build from a pacwich {@link Workspace}, reading its manifest. */
  static async fromWorkspace(ws: Workspace): Promise<WorkspacePackage> {
    const dir = resolve(root, ws.path);
    const meta = (await Bun.file(join(dir, "package.json")).json()) as PackageJson;
    return new WorkspacePackage(meta, dir);
  }
}

/** Resolve `path` against the repo root. */
export function toAbsolute(path: string): string {
  return isAbsolute(path) ? path : resolve(root, path);
}

/** Repo-relative form of `path`, or absolute when it sits outside the root. */
export function toRelative(path: string): string {
  const rel = relative(root, path);
  return rel !== "" &&
    !rel.startsWith("..") &&
    !rel.startsWith("/") &&
    !rel.startsWith("\\")
    ? rel
    : resolve(path);
}

/** Yield every workspace `package.json` path (`includeRoot` prepends the root manifest). */
export async function* discoverPackageJsons(
  includeRoot = false,
): AsyncIterableIterator<string> {
  const project = await getProject();
  if (includeRoot) {
    yield resolve(root, project.rootWorkspace.path, "package.json");
  }
  for (const ws of project.workspaces) {
    yield resolve(root, ws.path, "package.json");
  }
}

/** Workspace packages passing `filter` (default: non-private), sorted by slug. */
export async function discoverPackages(
  filter: (pkg: WorkspacePackage) => boolean = (pkg) => pkg.meta.private !== true,
): Promise<WorkspacePackage[]> {
  const project = await getProject();
  const pkgs = await Promise.all(
    project.workspaces.map((ws) => WorkspacePackage.fromWorkspace(ws)),
  );
  return pkgs.filter(filter).sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Write `value` as JSON, preserving the file's trailing newline to avoid format churn. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  const file = Bun.file(path);
  const trailingNewline = (await file.exists())
    ? (await file.text()).endsWith("\n")
    : true;
  await Bun.write(path, JSON.stringify(value, null, 2) + (trailingNewline ? "\n" : ""));
}
