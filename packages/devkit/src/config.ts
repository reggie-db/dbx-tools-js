// Lightweight per-repo configuration for the toolkit. Everything here
// is auto-derived from the workspace so a consuming repo needs zero
// config in the common case; the only knobs are optional overrides
// under a `devkit` key in the root `package.json`:
//
//   {
//     "devkit": {
//       "scope": "@acme",            // npm scope used by `create`
//       "repo": "acme/widgets"       // owner/name for release links
//     }
//   }
//
// `scope` defaults to the most common scope among the publishable
// workspace packages; `repo` defaults to the `origin` git remote.

import pMemoize from "p-memoize";
import { git, hasGit } from "./git.js";
import { discoverPackages, toAbsolute, type PackageJson } from "./package.js";

/** Optional `devkit` overrides read from the root `package.json`. */
interface DevkitConfigOverrides {
  scope?: string;
  repo?: string;
}

/** Resolved toolkit configuration for the current repo. */
export interface DevkitConfig {
  /** npm scope (e.g. `@acme`) used when scaffolding new packages. */
  scope: string;
  /** `owner/name` slug used for release links, or null when undiscoverable. */
  repo: string | null;
}

/** Read the optional `devkit` block from the root `package.json`. */
async function readOverrides(): Promise<DevkitConfigOverrides> {
  const rootMeta = (await Bun.file(
    toAbsolute("package.json"),
  ).json()) as PackageJson & {
    devkit?: DevkitConfigOverrides;
  };
  return rootMeta.devkit ?? {};
}

/**
 * Pick the npm scope shared by the publishable packages: the `@scope`
 * prefix that appears most often among their names. Returns undefined
 * when no scoped package exists.
 */
async function deriveScope(): Promise<string | undefined> {
  const counts = new Map<string, number>();
  for (const pkg of await discoverPackages()) {
    const match = /^(@[^/]+)\//.exec(pkg.meta.name ?? "");
    if (!match) continue;
    const scope = match[1]!;
    counts.set(scope, (counts.get(scope) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [scope, count] of counts) {
    if (count > bestCount) {
      best = scope;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Parse an `owner/name` slug out of a git remote URL, supporting both
 * `git@host:owner/name.git` and `https://host/owner/name(.git)` forms.
 */
function parseRepoSlug(remoteUrl: string): string | null {
  const cleaned = remoteUrl.trim().replace(/\.git$/, "");
  const match = /[:/]([^/:]+\/[^/]+)$/.exec(cleaned);
  return match ? match[1]! : null;
}

/** Resolve the `owner/name` slug from the `origin` remote, or null. */
async function deriveRepo(): Promise<string | null> {
  if (!hasGit()) return null;
  const { exitCode, stdout } = await git(["remote", "get-url", "origin"], {
    nothrow: true,
  });
  if (exitCode !== 0 || !stdout) return null;
  return parseRepoSlug(stdout);
}

/**
 * Resolve toolkit config for the current repo, memoized for the
 * process. Overrides under the root `package.json` `devkit` key win
 * over the auto-derived defaults.
 */
export const getDevkitConfig = pMemoize(async (): Promise<DevkitConfig> => {
  const overrides = await readOverrides();
  const scope = overrides.scope ?? (await deriveScope()) ?? "";
  const repo = overrides.repo ?? (await deriveRepo());
  return { scope, repo };
});
