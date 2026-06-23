// Wipe build output (`dist/` + the stale incremental
// `tsconfig.build.tsbuildinfo`) across every workspace.

import { runScript } from "./script.js";

await runScript({ script: "rm -rf dist tsconfig.build.tsbuildinfo" });
