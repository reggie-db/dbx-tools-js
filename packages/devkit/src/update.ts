// Workspace dependency updater: refresh root catalog pins to the latest
// stable release matching each range (skipping alpha/beta/rc), then run
// `bun update` once at the repo root (Bun workspaces resolve the whole tree).

import { consola } from "consola";
import { resolve } from "node:path";
import semver from "semver";
import { type PackageJson, writeJson } from "./package.js";
import { getProject } from "./project.js";
import { sh } from "./shell.js";

/** True when `version` is a release with no prerelease segment. */
export function isStableVersion(version: string): boolean {
  return semver.valid(version) !== null && semver.prerelease(version) === null;
}

/** Highest stable version in `versions` that satisfies `range`. */
export function latestStableInRange(versions: string[], range: string): string | null {
  let best: string | null = null;
  for (const version of versions) {
    if (!isStableVersion(version)) continue;
    if (!semver.satisfies(version, range, { includePrerelease: false })) continue;
    if (!best || semver.gt(version, best)) best = version;
  }
  return best;
}

/** Rewrite a single range (or `latest`) to a caret pin on the latest stable match. */
export function stableCaretRange(versions: string[], range: string): string {
  const trimmed = range.trim();
  if (trimmed === "latest") return trimmed;

  const alternatives = trimmed.split("||").map((part) => part.trim());
  if (alternatives.length > 1) {
    return alternatives
      .map((part) => {
        const latest = latestStableInRange(versions, part);
        return latest ? `^${latest}` : part;
      })
      .join(" || ");
  }

  const latest = latestStableInRange(versions, trimmed);
  return latest ? `^${latest}` : trimmed;
}

/** Fetch every published version of `pkg` from the registry. */
async function npmVersions(
  pkg: string,
  cache: Map<string, string[]>,
): Promise<string[] | null> {
  const cached = cache.get(pkg);
  if (cached) return cached;

  const result = await sh(["npm", "view", pkg, "versions", "--json"], {
    quiet: true,
    nothrow: true,
  });
  if (result.exitCode !== 0) return null;

  try {
    const versions = JSON.parse(result.stdout) as string[];
    cache.set(pkg, versions);
    return versions;
  } catch {
    return null;
  }
}

/** Refresh every root `catalog` entry to the latest stable release in-range. */
export async function updateCatalog(): Promise<boolean> {
  const project = await getProject();
  const rootJsonPath = resolve(project.rootDirectory, project.rootWorkspace.path, "package.json");
  const meta = (await Bun.file(rootJsonPath).json()) as PackageJson;
  const catalog = meta.catalog as Record<string, string> | undefined;
  if (!catalog || Object.keys(catalog).length === 0) return false;

  const versionsCache = new Map<string, string[]>();
  const changes: string[] = [];

  for (const [pkg, range] of Object.entries(catalog)) {
    const versions = await npmVersions(pkg, versionsCache);
    if (!versions) {
      consola.warn(`Skipping catalog entry ${pkg}: could not resolve versions from npm`);
      continue;
    }

    const nextRange = stableCaretRange(versions, range);
    if (nextRange === range) continue;
    catalog[pkg] = nextRange;
    changes.push(`${pkg}: ${range} -> ${nextRange}`);
  }

  if (changes.length === 0) {
    consola.log("Catalog entries already pinned to latest stable versions.");
    return false;
  }

  meta.catalog = catalog;
  await writeJson(rootJsonPath, meta);
  consola.log(`Updated catalog:\n${changes.join("\n")}`);
  return true;
}

/** Run `bun update` with `forwardArgs` at the repo root. */
export async function runBunUpdate(forwardArgs: string[]): Promise<void> {
  const project = await getProject();
  const rootDir = resolve(project.rootDirectory, project.rootWorkspace.path);
  consola.log(
    `bun update${forwardArgs.length > 0 ? ` ${forwardArgs.join(" ")}` : ""}`,
  );
  await sh(["bun", "update", ...forwardArgs], { cwd: rootDir });
}

/** Refresh catalog pins, then `bun update` at the repo root. */
export async function update(forwardArgs: string[] = []): Promise<void> {
  await updateCatalog();
  await runBunUpdate(forwardArgs);
}

/** Args after the `update` subcommand in `process.argv`. */
export function forwardedUpdateArgs(argv: string[] = process.argv): string[] {
  const start = argv.indexOf("update");
  return start >= 0 ? argv.slice(start + 1) : [];
}
