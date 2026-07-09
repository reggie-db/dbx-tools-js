/**
 * Node filesystem helpers. Server-only (`node:fs/promises`).
 */

import type { Stats } from "node:fs";
import { stat as nodeStat } from "node:fs/promises";

/** Non-empty trimmed path with no NUL or other ASCII control characters. */
const STAT_PATH_RE = /^[^\0-\x1f]+$/;

function isStatPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0) {
    return false;
  }
  return STAT_PATH_RE.test(path);
}

/**
 * Best-effort `fs.stat`. Returns `undefined` when `path` is empty,
 * invalid, or not accessible.
 */
export async function stat(path: string): Promise<Stats | undefined> {
  if (isStatPath(path)) {
    try {
      return await nodeStat(path);
    } catch (err) {
      // if the file doesn't exist or couldn't be stat'd, return undefined
    }
  }

  return undefined;
}
