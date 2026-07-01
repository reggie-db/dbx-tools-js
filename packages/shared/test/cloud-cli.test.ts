#!/usr/bin/env bun
/**
 * Manual eyeball harness for cloud geolocation - run it directly to see
 * which provider / region a host resolves into via {@link resolveCloudLocation},
 * or to gauge the heap footprint of the parsed region map:
 *
 *   bun packages/shared/test/cloud-cli.test.ts adb-123.7.azuredatabricks.net
 *   bun packages/shared/test/cloud-cli.test.ts https://dbc-abc.cloud.databricks.com --json
 *   bun --expose-gc packages/shared/test/cloud-cli.test.ts mem
 *
 * `bun test` runs `.test.ts` files with no extra argv (and sets
 * `import.meta.main`), so the harness only fires when invoked directly
 * with at least one CLI argument - under `bun test` it stays a no-op.
 */
import { Command } from "commander";

import { loadProviderRanges, resolveCloudLocation } from "../src/cloud.js";

/** `global.gc`, present only under `--expose-gc`; typed off the global. */
const gc = (globalThis as { gc?: () => void }).gc;

/** Build the parsed, region-tagged range map for every provider. */
const buildMap = loadProviderRanges;

async function main(): Promise<void> {
  const program = new Command()
    .name("cloud-cli")
    .description("Look up the cloud provider / region a host resolves into.");

  program
    .command("lookup", { isDefault: true })
    .description("Geolocate a host to its cloud provider / region.")
    .argument("<url>", "workspace URL, bare host, or origin to geolocate")
    .option("--json", "print the raw JSON result")
    .action(async (url: string, opts: { json?: boolean }) => {
      const location = await resolveCloudLocation(url);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(location, null, 2)}\n`);
        return;
      }
      if (!location) {
        process.stdout.write(`${url}: no matching cloud range\n`);
        return;
      }
      const { provider, region, ip, cidr } = location;
      process.stdout.write(`${url} -> ${provider}/${region} (ip ${ip} in ${cidr})\n`);
    });

  program
    .command("mem")
    .description("Report the heap growth across fetching the region map.")
    .action(async () => {
      gc?.(); // clean baseline so `before` isn't inflated by leftover garbage
      const before = process.memoryUsage().heapUsed;
      const map = await buildMap();
      const after = process.memoryUsage().heapUsed;
      const ranges = map.reduce((total, p) => total + p.ranges.length, 0);
      process.stdout.write(
        `${((after - before) / 1024 / 1024).toFixed(2)} MB` +
          ` (${ranges} ranges across ${map.length} providers)\n`,
      );
    });

  await program.parseAsync(process.argv);
}

if (import.meta.main && process.argv.length > 2) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
}
