/**
 * Snapshot `process.env`, diff after auto-config, and format deltas as
 * eval-able shell `export` / Windows `set` lines or JSON.
 */

export type EnvExportFormat = "export" | "windows" | "json";

/** Shallow copy of the current process environment. */
export function snapshotEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Keys whose values were added or changed between snapshots. Omits keys
 * that became empty or were removed.
 */
export function diffEnv(
  before: Record<string, string>,
  after: Record<string, string>,
): Record<string, string> {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: Record<string, string> = {};
  for (const key of [...keys].sort()) {
    const prev = before[key];
    const next = after[key];
    if (next && next !== prev) {
      out[key] = next;
    }
  }
  return out;
}

export function defaultEnvExportFormat(platform: NodeJS.Platform = process.platform): EnvExportFormat {
  return platform === "win32" ? "windows" : "export";
}

function escapeExportValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`");
}

function escapeWindowsSetValue(value: string): string {
  if (/[\s"&|<>^]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Format env entries for the requested output style. An empty map prints
 * nothing (no trailing newline).
 */
export function formatEnvExport(
  env: Record<string, string>,
  format: EnvExportFormat,
): string {
  const entries = Object.entries(env).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    return "";
  }

  switch (format) {
    case "json":
      return `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`;
    case "windows":
      return entries.map(([key, value]) => `set ${key}=${escapeWindowsSetValue(value)}`).join("\n") + "\n";
    case "export":
      return (
        entries.map(([key, value]) => `export ${key}="${escapeExportValue(value)}"`).join("\n") + "\n"
      );
    default:
      throw new Error(`Unknown env export format: ${format satisfies never}`);
  }
}

/** Normalize CLI format aliases to a supported export format. */
export function parseEnvExportFormat(value: string): EnvExportFormat {
  const normalized = value.trim().toLowerCase();
  if (normalized === "export" || normalized === "shell" || normalized === "nix" || normalized === "bash") {
    return "export";
  }
  if (normalized === "windows" || normalized === "win" || normalized === "cmd") {
    return "windows";
  }
  if (normalized === "json") {
    return "json";
  }
  throw new Error(`Unknown format '${value}'. Use export, windows, or json.`);
}
