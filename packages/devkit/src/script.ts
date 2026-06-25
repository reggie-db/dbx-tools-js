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
