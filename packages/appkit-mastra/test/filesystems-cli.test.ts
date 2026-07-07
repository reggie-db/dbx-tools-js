#!/usr/bin/env bun
/**
 * Live integration harness for {@link DatabricksWorkspaceFilesystem} against a
 * Databricks workspace path. Creates a temporary directory, exercises read /
 * write / list / copy / move / stat, then deletes every artifact.
 *
 *   bun packages/appkit-mastra/test/filesystems-cli.test.ts \
 *     --path /Workspace/.assistant
 *
 * Auth uses the normal Databricks SDK env (`DATABRICKS_CONFIG_PROFILE`, host +
 * token, etc.). `commander` is a root dev dependency; run from the repo root.
 *
 * `bun test` loads this file with no extra argv, so the `import.meta.main`
 * guard keeps the harness inert under the test runner.
 */
import { WorkspaceClient } from "@databricks/sdk-experimental";
import { commonUtils } from "@dbx-tools/shared";
import { Command } from "commander";
import { randomUUID } from "node:crypto";

import { DatabricksWorkspaceFilesystem } from "../src/filesystems.js";

interface CliOptions {
  path: string;
  json?: boolean;
}

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

/** Run filesystem operations and return per-case results plus the test dir. */
export async function runFilesystemIntegrationTests(
  filesystem: DatabricksWorkspaceFilesystem,
): Promise<{ results: CaseResult[]; testDir: string }> {
  const id = randomUUID().slice(0, 8);
  const testDir = `/__dbx_tools_fs_test_${id}`;
  const fileA = `${testDir}/hello.txt`;
  const fileB = `${testDir}/hello-copy.txt`;
  const fileC = `${testDir}/hello-moved.txt`;
  const payload = `dbx-tools filesystem integration ${id}\n`;
  const results: CaseResult[] = [];

  const step = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      results.push({ name, ok: true });
      process.stderr.write(`  ok ${name}\n`);
    } catch (err) {
      const detail = commonUtils.errorMessage(err);
      results.push({ name, ok: false, detail });
      process.stderr.write(`  FAIL ${name}: ${detail}\n`);
    }
  };

  await filesystem.init();

  await step("mkdir", async () => {
    await filesystem.mkdir(testDir, { recursive: true });
  });

  await step("writeFile", async () => {
    await filesystem.writeFile(fileA, payload);
  });

  await step("readFile", async () => {
    const read = await filesystem.readFile(fileA, { encoding: "utf8" });
    if (read !== payload) {
      throw new Error(`content mismatch: ${JSON.stringify(read)}`);
    }
  });

  await step("stat", async () => {
    const info = await filesystem.stat(fileA);
    if (info.type !== "file") {
      throw new Error(`expected file, got ${info.type}`);
    }
  });

  await step("readdir", async () => {
    const entries = await filesystem.readdir(testDir);
    if (!entries.some((entry) => entry.name === "hello.txt" && entry.type === "file")) {
      throw new Error(`hello.txt missing from ${JSON.stringify(entries)}`);
    }
  });

  await step("copyFile", async () => {
    await filesystem.copyFile(fileA, fileB);
    const copy = await filesystem.readFile(fileB, { encoding: "utf8" });
    if (copy !== payload) {
      throw new Error("copy content mismatch");
    }
  });

  await step("moveFile", async () => {
    await filesystem.moveFile(fileB, fileC);
    if (await filesystem.exists(fileB)) {
      throw new Error("source still exists after move");
    }
    const moved = await filesystem.readFile(fileC, { encoding: "utf8" });
    if (moved !== payload) {
      throw new Error("moved content mismatch");
    }
  });

  await step("appendFile", async () => {
    await filesystem.appendFile(fileA, "tail\n");
    const appended = (await filesystem.readFile(fileA, { encoding: "utf8" })) as string;
    if (!appended.endsWith("tail\n")) {
      throw new Error(`append failed: ${JSON.stringify(appended)}`);
    }
  });

  await step("deleteFile", async () => {
    await filesystem.deleteFile(fileC);
    if (await filesystem.exists(fileC)) {
      throw new Error("file still exists after delete");
    }
  });

  return { results, testDir };
}

/** Best-effort recursive delete of the integration test directory. */
export async function cleanupFilesystemTestDir(
  filesystem: DatabricksWorkspaceFilesystem,
  testDir: string,
): Promise<void> {
  try {
    if (await filesystem.exists(testDir)) {
      await filesystem.rmdir(testDir, { recursive: true, force: true });
    }
  } catch (err) {
    process.stderr.write(
      `filesystems-cli: cleanup warning for ${testDir}: ${commonUtils.errorMessage(err)}\n`,
    );
  }
}

async function main(): Promise<void> {
  const program = new Command()
    .name("filesystems-cli")
    .description("Run live DatabricksWorkspaceFilesystem integration checks.");

  program
    .command("test", { isDefault: true })
    .description("Exercise filesystem operations under the given base path.")
    .requiredOption(
      "-p, --path <basePath>",
      "Databricks base path (e.g. /Workspace/.assistant)",
    )
    .option("--json", "print results as JSON")
    .action(async (opts: CliOptions) => {
      const client = new WorkspaceClient({});
      const filesystem = new DatabricksWorkspaceFilesystem({
        client,
        basePath: opts.path,
      });

      process.stderr.write(`filesystems-cli: base=${opts.path}\n`);

      let testDir = "";
      try {
        const outcome = await runFilesystemIntegrationTests(filesystem);
        testDir = outcome.testDir;
        const failed = outcome.results.filter((result) => !result.ok);

        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify({ basePath: opts.path, results: outcome.results }, null, 2)}\n`,
          );
        } else {
          process.stderr.write(
            failed.length === 0
              ? `filesystems-cli: ${outcome.results.length} passed\n`
              : `filesystems-cli: ${failed.length} failed, ${outcome.results.length - failed.length} passed\n`,
          );
        }

        if (failed.length > 0) {
          process.exitCode = 1;
        }
      } finally {
        if (testDir) {
          process.stderr.write(`filesystems-cli: cleaning up ${testDir}\n`);
          await cleanupFilesystemTestDir(filesystem, testDir);
        }
      }
    });

  await program.parseAsync(process.argv);
}

if (import.meta.main && process.argv.length > 2) {
  main()
    .then(() => {
      process.exit(process.exitCode ?? 0);
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      process.exit(1);
    });
}
