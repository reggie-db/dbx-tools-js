#!/usr/bin/env bun
/**
 * Print env vars added or changed by {@link autoConfigure}.
 *
 * Snapshots `process.env`, runs auto-config, diffs, and writes eval-able
 * `export` / `set` lines (or JSON) to stdout.
 */

import { Command, CommanderError } from "commander";

import { autoConfigure } from "../src/create-app.js";
import {
  defaultEnvExportFormat,
  diffEnv,
  formatEnvExport,
  parseEnvExportFormat,
  snapshotEnv,
} from "../src/env-export.js";
import { logUtils } from "@dbx-tools/shared";

const log = logUtils.logger(this);

const program = new Command()
  .name("appkit-config-env")
  .description("Run AppKit auto-config and print new/changed env vars.")
  .option(
    "-f, --format <format>",
    "Output: export (POSIX shell), windows (cmd set), or json. Defaults by platform.",
  )
  .option("-q, --quiet", "Suppress auto-config log output (LOG_LEVEL=error)")
  .action(async (opts: { format?: string; quiet?: boolean }) => {
    if (opts.quiet) {
      process.env.LOG_LEVEL = "error";
    }

    const format = opts.format
      ? parseEnvExportFormat(opts.format)
      : defaultEnvExportFormat();
    log.debug("Snapshotting env vars");
    const before = snapshotEnv();
    await autoConfigure({ autoConfigure: true });
    const changes = diffEnv(before, snapshotEnv());

    process.stdout.write(formatEnvExport(changes, format));
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof CommanderError) {
    process.exit(err.exitCode);
  }
  process.stderr.write(
    `${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
