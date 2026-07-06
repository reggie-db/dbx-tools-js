/**
 * Cross-process refresh serialization for skill source caches.
 */

import lockfile from "proper-lockfile";
import { join } from "node:path";

export const REFRESH_LOCK_DIR = "refresh.lock";

const REFRESH_LOCK_STALE_MS = 60_000;

/** Run `fn` while holding the per-source cache refresh lock. */
export async function withRefreshLock<T>(
  cacheRoot: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockfilePath = join(cacheRoot, REFRESH_LOCK_DIR);
  const release = await lockfile.lock(cacheRoot, {
    lockfilePath,
    realpath: false,
    stale: REFRESH_LOCK_STALE_MS,
    retries: { retries: 30, minTimeout: 200, maxTimeout: 5000 },
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}
