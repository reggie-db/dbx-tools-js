// Wipe build output (`dist/` + the stale incremental
// `tsconfig.build.tsbuildinfo`) across every workspace.

import { runScript } from "./script.js";

/** Remove every workspace's `dist/` and stale tsc build cache. */
export async function clean(): Promise<void> {
  await runScript({ script: "rm -rf dist tsconfig.build.tsbuildinfo" });
}
