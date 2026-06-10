#!/usr/bin/env bun
/**
 * Manual eyeball harness for URL construction - run it directly to see
 * what {@link urlBuilder} produces for a given input:
 *
 *   bun packages/shared/test/url-cli.test.ts example.com/foo
 *   bun packages/shared/test/url-cli.test.ts /api/v2/items
 *
 * Guarded by `import.meta.main`, so `bun test` importing this file is a
 * no-op.
 */
import { urlBuilder } from "../src/net.browser.js";

function main(): void {
  const input = process.argv.slice(2)[0];
  const built = urlBuilder(input);
  console.log(built ? built.toString() : "null");
}

if (import.meta.main) {
  main();
}
