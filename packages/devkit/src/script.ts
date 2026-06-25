// Cross-workspace script runner plus the small shared text helpers the
// commands lean on.

import { consola } from "consola";
import {
  type InlineScriptOptions,
  type RunScriptAcrossWorkspacesOptions,
  type RunScriptAcrossWorkspacesSummary,
} from "pacwich";
import { getProject } from "./project.js";

/** Log `message` and exit non-zero. */
export function fail(message: string): never {
  consola.error(message);
  process.exit(1);
}

/** Narrow an unknown thrown value to its message string. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Split text on newlines, trimming each line and dropping blanks. */
export function nonEmptyLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Run a script across the workspaces, streaming each output chunk under
 * its workspace tag and returning the run summary. A bare identifier in
 * `script` (e.g. `build`) is run as that workspace's `package.json`
 * script; anything containing whitespace is treated as an inline shell
 * command (run through Bun's shell by default).
 */
export async function runScript(
  options: RunScriptAcrossWorkspacesOptions,
): Promise<RunScriptAcrossWorkspacesSummary> {
  const project = await getProject();
  const isInline = !/^[\w.-]+$/.test(options.script.trim());
  const inline: InlineScriptOptions | undefined = isInline
    ? typeof options.inline === "object"
      ? options.inline
      : { shell: "bun" }
    : undefined;
  const { output, summary } = project.runScriptAcrossWorkspaces({
    ...options,
    ...(inline ? { inline } : {}),
  });
  for await (const { chunk, metadata } of output.text()) {
    consola.withTag(metadata.workspace.name).log(chunk.trimEnd());
  }
  return summary;
}

/**
 * Run the `<phase><command>` script (e.g. `prerelease`, `postbuild`) in
 * every workspace that defines it. `packages` (full names) narrows the
 * candidate set; omitted or empty means the whole workspace.
 *
 * The workspaces that actually declare the script are resolved up front
 * via pacwich's `listWorkspacesWithScript`, and the run is scoped to
 * exactly those - `runScript` throws when asked to run a script no
 * workspace has, so this stays a clean no-op when nothing matches.
 * Aborts the command if any hook exits non-zero.
 */
export async function runHook(
  phase: "pre" | "post",
  command: string,
  packages?: readonly string[],
): Promise<void> {
  const script = `${phase}${command}`;
  const project = await getProject();
  const scope = packages && packages.length > 0 ? new Set(packages) : null;
  const targets = project
    .listWorkspacesWithScript(script)
    .map((workspace) => workspace.name)
    .filter((name) => !scope || scope.has(name));
  if (targets.length === 0) return;

  const summary = await runScript({ script, workspacePatterns: targets });
  const failed = summary.scriptResults
    .filter((entry) => !entry.success && !entry.skipped)
    .map((entry) => entry.metadata.workspace.name);
  if (failed.length > 0) {
    fail(`${script} hook failed in: ${failed.join(", ")}`);
  }
}
