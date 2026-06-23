// Git wrapper over the shared shell runner.

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
