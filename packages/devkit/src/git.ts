// Git wrapper over the shared shell runner, plus availability checks so
// commands can either degrade gracefully without git / outside a repo
// or fail with a clear message when version control is mandatory.

import { fail } from "./script.js";
import { sh, type ShellResult } from "./shell.js";

/**
 * Run `git <args>`, returning trimmed output. Quiet by default since git is
 * used mostly for its stdout (rev-parse, log, diff, ...); pass `quiet: false`
 * to stream a mutating op live. Throws on non-zero unless `nothrow`.
 */
export function git(
  args: string[],
  opts: { nothrow?: boolean; quiet?: boolean; cwd?: string } = {},
): Promise<ShellResult> {
  return sh(["git", ...args], { quiet: true, ...opts });
}

/**
 * True when the `git` executable is resolvable on PATH. The PATH lookup
 * is stable for the process, so memoize it - callers (`isGitRepo`,
 * `requireGitRepo`, codegen's per-file ignore check) hit this repeatedly.
 */
let gitAvailable: boolean | undefined;
export function hasGit(): boolean {
  return (gitAvailable ??= Boolean(Bun.which("git")));
}

/**
 * True when `cwd` (default: the process cwd) is inside a git work tree.
 * Returns false when git isn't installed, so callers can use it as a
 * single "can I use git here?" gate.
 */
export async function isGitRepo(cwd?: string): Promise<boolean> {
  if (!hasGit()) return false;
  const { exitCode, stdout } = await git(["rev-parse", "--is-inside-work-tree"], {
    nothrow: true,
    quiet: true,
    cwd,
  });
  return exitCode === 0 && stdout === "true";
}

/**
 * Assert git is installed and `cwd` is inside a git repo, aborting with a
 * clear message otherwise. For commands that genuinely need version
 * control (commit, tag, push); optional callers should use {@link hasGit}
 * / {@link isGitRepo} and skip instead of failing.
 */
export async function requireGitRepo(caller: string, cwd?: string): Promise<void> {
  if (!hasGit()) {
    fail(`${caller} requires git, but no \`git\` executable was found on PATH.`);
  }
  if (!(await isGitRepo(cwd))) {
    fail(`${caller} must be run inside a git repository.`);
  }
}
