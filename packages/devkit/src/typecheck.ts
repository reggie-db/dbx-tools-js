// Workspace-wide type check, run via `devkit typecheck`.
//
// The publishable packages are checked by a single flat `tsc --noEmit`
// over the root `tsconfig.json`, which includes every package's source
// directly and resolves cross-package `@dbx-tools/*` imports to source
// (via the `source` exports condition / each package's `index.ts`), so
// a check never reads stale `dist`. The demo app keeps its own
// browser/server tsconfig split and is delegated to its own `typecheck`
// script.

import { runScript } from "./script.js";
import { sh } from "./shell.js";

const DEMO = "@dbx-tools/appkit-demo";

/** Flat source typecheck of every package, then the demo's own split. */
export async function typecheck(): Promise<void> {
  await sh(["bun", "x", "--bun", "tsc", "--noEmit", "-p", "tsconfig.json"]);
  await runScript({ script: "typecheck", workspacePatterns: [DEMO] });
}
