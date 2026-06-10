#!/usr/bin/env bun
/**
 * Manual eyeball harness for URL construction - run it directly to see
 * what {@link urlBuilder} or {@link apiUrl} produce for a given input:
 *
 *   bun packages/shared/test/url-cli.test.ts example.com/foo
 *   bun packages/shared/test/url-cli.test.ts /api/v2/items
 *   bun packages/shared/test/url-cli.test.ts --api serving-endpoints my-ep invocations
 *   bun packages/shared/test/url-cli.test.ts --api --host https://x.databricks.com jobs/list
 *
 * Default mode pipes the (single) argument through `urlBuilder`. `--api`
 * pipes the positional args through `apiUrl`, using a stub client whose
 * host defaults to `--host` (so no workspace auth is needed). Guarded by
 * `import.meta.main`, so `bun test` importing this file is a no-op.
 */
import type { WorkspaceClient } from "@databricks/sdk-experimental";

import { apiUrl } from "../src/api.js";
import { urlBuilder } from "../src/net.browser.js";

const DEFAULT_HOST = "https://example.cloud.databricks.com";

/** Minimal `WorkspaceClient` that only answers `config.getHost()`. */
function stubClient(host: string): WorkspaceClient {
  return { config: { getHost: async () => host } } as unknown as WorkspaceClient;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const useApi = argv.includes("--api");

  // Pull `--host <value>` out; everything else is positional input.
  let host = DEFAULT_HOST;
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--api") continue;
    if (arg === "--host") {
      host = argv[++i] ?? host;
      continue;
    }
    args.push(arg);
  }

  if (useApi) {
    // `apiUrl` takes a single string or an array of segments.
    const path = args.length === 1 ? args[0] : args;
    const url = await apiUrl(path, stubClient(host));
    console.log(url.toString());
    return;
  }

  const built = urlBuilder(args[0]);
  console.log(built ? built.toString() : "null");
}

if (import.meta.main) {
  await main();
}
