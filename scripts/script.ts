// Script discovery + the `runScript` entry the small CLIs share.

import { consola } from "consola";
import {
  type InlineScriptOptions,
  type RunScriptAcrossWorkspacesOptions,
  type RunScriptAcrossWorkspacesSummary,
} from "pacwich";
import { getProject } from "./project.js";

/** This `scripts/` directory. */
export const getScriptsDir = (): string => import.meta.dir;

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
 * `script` is resolved to a local `scripts/<name>` file; anything else
 * (an inline shell command) is passed straight through. Inline scripts
 * default to Bun's shell.
 */
export async function runScript(
  options: RunScriptAcrossWorkspacesOptions,
): Promise<RunScriptAcrossWorkspacesSummary> {
  const project = await getProject();
  const inline: InlineScriptOptions =
    typeof options.inline === "object" ? options.inline : { shell: "bun" };
  const { output, summary } = project.runScriptAcrossWorkspaces({
    ...options,
    script: await resolveScript(options.script),
    inline,
  });
  for await (const { chunk, metadata } of output.text()) {
    consola.withTag(metadata.workspace.name).log(chunk.trimEnd());
  }
  return summary;
}

/** Turn a bare script name into a `bun run <file>` command, else pass it through. */
async function resolveScript(script: string): Promise<string> {
  if (!/^[\w.-]+$/.test(script.trim())) return script;
  const glob = new Bun.Glob(`${script.trim()}.{ts,js}`);
  for (const dir of [(await getProject()).rootDirectory, getScriptsDir()]) {
    for await (const filePath of glob.scan({ cwd: dir, absolute: true })) {
      return `bun run ${filePath}`;
    }
  }
  return script;
}
