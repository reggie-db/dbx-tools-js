/**
 * Parse GitHub repository references from pip-style strings or URLs.
 */

/** Parsed GitHub coordinates for archive download. */
export interface ParsedGithubRef {
  owner: string;
  name: string;
  ref: string;
  /** When omitted, the skills subdirectory is discovered after download. */
  skillsSubdir?: string;
}

const GITHUB_HOST = "github.com";

/** Parse `#subdirectory=path` (or a bare `#path` shorthand) from a pip-style fragment. */
function parsePipFragment(fragment: string): { skillsSubdir?: string } {
  const trimmed = fragment.trim();
  if (!trimmed) return {};

  if (trimmed.includes("=")) {
    const params = new URLSearchParams(trimmed);
    const subdirectory = params.get("subdirectory");
    if (subdirectory) return { skillsSubdir: subdirectory };
    throw new Error(
      `Unknown pip fragment "${fragment}" (expected subdirectory=<path>, e.g. #subdirectory=databricks-skills)`,
    );
  }

  return { skillsSubdir: trimmed };
}

/**
 * Parse a pip-style source string:
 *
 * - `owner/repo` (branch defaults to `main`; skills subdirectory auto-discovered)
 * - `owner/repo@branch`
 * - `owner/repo#subdirectory=skills-folder`
 * - `owner/repo@branch#subdirectory=skills-folder`
 * - `github.com/owner/repo.git@branch#subdirectory=path`
 * - `owner/repo#skills-folder` (bare path, still accepted)
 * - `github:owner/repo`, `https://github.com/owner/repo/tree/branch/path`
 */
export function parseGithubRef(
  input: string,
  overrides: { ref?: string; skillsSubdir?: string } = {},
): ParsedGithubRef {
  let trimmed = input.trim();
  if (!trimmed) {
    throw new Error("GitHub source is empty (expected owner/repo or a github.com URL)");
  }

  if (trimmed.startsWith("github:")) {
    return parseGithubRef(trimmed.slice("github:".length), overrides);
  }

  let skillsSubdir = overrides.skillsSubdir;
  const hash = trimmed.lastIndexOf("#");
  if (hash > 0) {
    const fragment = parsePipFragment(trimmed.slice(hash + 1));
    skillsSubdir = fragment.skillsSubdir ?? skillsSubdir;
    trimmed = trimmed.slice(0, hash);
  }

  let owner = "";
  let name = "";
  let ref = overrides.ref ?? "main";

  if (trimmed.includes("://") || trimmed.startsWith(GITHUB_HOST)) {
    if (!trimmed.includes("://") && trimmed.includes("@")) {
      const withoutHost = trimmed.replace(/^(?:www\.)?github\.com\//, "");
      return parseGithubRef(withoutHost, { ...overrides, skillsSubdir });
    }
    const url = trimmed.startsWith("http") ? new URL(trimmed) : new URL(`https://${trimmed}`);
    if (!url.hostname.replace(/^www\./, "").endsWith(GITHUB_HOST)) {
      throw new Error(`Unsupported host "${url.hostname}" (only github.com is supported)`);
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) {
      throw new Error(`Invalid GitHub URL "${input}" (expected github.com/owner/repo)`);
    }
    owner = parts[0]!;
    name = parts[1]!.replace(/\.git$/, "");
    if (parts[2] === "tree" && parts[3]) {
      ref = parts[3]!;
      if (parts.length > 4) {
        skillsSubdir = parts.slice(4).join("/");
      }
    }
    return { owner, name, ref, skillsSubdir };
  }

  const at = trimmed.lastIndexOf("@");
  let repoPart = trimmed;
  if (at > 0) {
    ref = trimmed.slice(at + 1);
    repoPart = trimmed.slice(0, at);
  }

  const slash = repoPart.indexOf("/");
  if (slash <= 0 || slash === repoPart.length - 1) {
    throw new Error(`Invalid GitHub repo "${input}" (expected "owner/name")`);
  }
  owner = repoPart.slice(0, slash);
  name = repoPart.slice(slash + 1).replace(/\.git$/, "");

  return { owner, name, ref, skillsSubdir };
}

/** Stable cache directory segment for a source. */
export function defaultSourceId(owner: string, name: string): string {
  return `${owner}-${name}`.replaceAll(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase();
}

/** GitHub archive tarball URL for a branch, tag, or commit ref. */
export function githubArchiveUrl(owner: string, name: string, ref: string): string {
  if (/^[0-9a-f]{7,40}$/i.test(ref)) {
    return `https://github.com/${owner}/${name}/archive/${ref}.tar.gz`;
  }
  return `https://github.com/${owner}/${name}/archive/refs/heads/${ref}.tar.gz`;
}
