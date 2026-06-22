/**
 * Interactive smoke test for the model ranker. Lists the workspace's
 * `/serving-endpoints` once (through the cached {@link listServingEndpoints}
 * path the plugin uses), then ranks them against a {@link ModelQuery}
 * and prints the ranked {@link RankedModel}[] as JSON.
 *
 * Every query - the argv one-shot and each REPL / piped line - is parsed
 * with commander and validated with {@link ModelQuerySchema}, so any line
 * may carry `--class`, `--limit`, and `--threshold` next to its search.
 *
 * Run:
 *
 *   bun packages/model/test/fuzzy-cli.ts                          # REPL until empty line
 *   bun packages/model/test/fuzzy-cli.ts "claude sonnet"          # one-shot search
 *   bun packages/model/test/fuzzy-cli.ts --class chat-balanced    # one-shot class listing
 *   bun packages/model/test/fuzzy-cli.ts opus --class chat-thinking --limit 3
 *   echo "opus --limit 5" | bun packages/model/test/fuzzy-cli.ts
 *
 * Flags (per query):
 *
 *   --class <chat-thinking|chat-balanced|chat-fast|embedding>   class ceiling
 *   --limit <n>                                                 cap the list length
 *   --threshold <0..1>                                          Fuse.js threshold (0.4)
 *
 * stdout is pure JSON (one array per query); the load banner and REPL
 * prompt go to stderr so the output pipes cleanly into `jq`.
 *
 * Optional auth env: DATABRICKS_CONFIG_PROFILE (or any other SDK auth env).
 */

import { WorkspaceClient } from "@databricks/sdk-experimental";
import {
  type ModelClass,
  type ModelQuery,
  ModelQuerySchema,
  type ServingEndpointSummary,
} from "@dbx-tools/model-shared";
import { appkitUtils } from "@dbx-tools/shared";
import { Command, CommanderError } from "commander";
import readline from "node:readline/promises";

import { parseModelClass } from "../src/classes.js";
import { rankModels } from "../src/resolve.js";
import { listServingEndpoints, type WorkspaceClientLike } from "../src/serving.js";

/**
 * Parse a token list (argv or one REPL / piped line) into a validated
 * {@link ModelQuery} via commander + {@link ModelQuerySchema}. `--class`
 * accepts the model-class slugs (with the same backward-compatible
 * shorthands as {@link parseModelClass}); `--limit` / `--threshold` are
 * bounds-checked by the schema. Throws on a bad flag or value so the
 * argv path fails loud and the REPL can report and keep looping.
 */
function parseQuery(tokens: readonly string[]): ModelQuery {
  const program = new Command()
    .name("fuzzy-cli")
    .exitOverride()
    .configureOutput({ writeOut: (s) => process.stderr.write(s) })
    .argument("[search...]", "free-text fuzzy search terms")
    .option("--class <class>", "capability class ceiling")
    .option("--limit <n>", "cap the number of results")
    .option("--threshold <n>", "Fuse.js threshold (0..1)");
  program.parse(tokens, { from: "user" });
  const opts = program.opts<{ class?: string; limit?: string; threshold?: string }>();

  const search = program.args.join(" ").trim();
  let modelClass: ModelClass | undefined;
  if (opts.class !== undefined) {
    const parsed = parseModelClass(opts.class);
    if (parsed === null) {
      throw new Error(
        `Invalid --class "${opts.class}" (chat-thinking|chat-balanced|chat-fast|embedding)`,
      );
    }
    modelClass = parsed;
  }
  return ModelQuerySchema.parse({
    ...(search ? { search } : {}),
    ...(modelClass !== undefined ? { modelClass } : {}),
    ...(opts.limit !== undefined ? { limit: Number(opts.limit) } : {}),
    ...(opts.threshold !== undefined ? { threshold: Number(opts.threshold) } : {}),
  });
}

/**
 * Loads the live serving-endpoint catalogue once and ranks typed
 * queries against it. Construct via the async {@link FuzzyMatchCli.create}
 * factory (the constructor is private so the endpoint list is always
 * populated before the loop starts).
 */
class FuzzyMatchCli {
  private readonly endpoints: readonly ServingEndpointSummary[];
  /** argv flags (limit / threshold) carried as defaults under each REPL line. */
  private readonly base: ModelQuery;

  private constructor(endpoints: readonly ServingEndpointSummary[], base: ModelQuery) {
    this.endpoints = endpoints;
    this.base = base;
  }

  /**
   * Build a CLI: initialize AppKit (so {@link listServingEndpoints}'s
   * `CacheManager` is available), construct a default-auth
   * `WorkspaceClient`, and fetch the workspace's endpoint catalogue.
   */
  static async create(base: ModelQuery): Promise<FuzzyMatchCli> {
    await appkitUtils.ensureInitialized();
    const client = new WorkspaceClient({});
    const host = (await client.config.getHost()).toString();
    const endpoints = await listServingEndpoints(
      client as unknown as WorkspaceClientLike,
      host,
    );
    process.stderr.write(
      `Loaded ${endpoints.length} serving endpoint(s) from ${host}\n`,
    );
    return new FuzzyMatchCli(endpoints, base);
  }

  /** Rank one query and print the result array as JSON to stdout. */
  private render(query: ModelQuery): void {
    const results = rankModels(this.endpoints, query);
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  }

  /**
   * Drive the ranker: a one-shot argv query (a search or `--class`),
   * piped stdin (one query per line), or an interactive REPL that loops
   * until an empty line is entered. REPL / piped lines are parsed
   * independently and layered over the argv defaults.
   */
  async run(argv: ModelQuery): Promise<void> {
    if (argv.search !== undefined || argv.modelClass !== undefined) {
      this.render(argv);
      return;
    }
    if (!process.stdin.isTTY) {
      for (const line of await FuzzyMatchCli.readPipedStdin()) this.renderLine(line);
      return;
    }
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      // Loop until the user submits an empty line (or EOF via Ctrl-D).
      for (;;) {
        let input: string;
        try {
          input = (await rl.question("\nsearch (empty to quit): ")).trim();
        } catch {
          return;
        }
        if (!input) return;
        this.renderLine(input);
      }
    } finally {
      rl.close();
    }
  }

  /** Parse one REPL / piped line over the argv defaults and render it. */
  private renderLine(line: string): void {
    try {
      this.render({ ...this.base, ...parseQuery(line.split(/\s+/).filter(Boolean)) });
    } catch (err) {
      // commander prints its own usage / option errors; only surface ours.
      if (err instanceof CommanderError) return;
      process.stderr.write(`  ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  /** Drain piped stdin into trimmed, non-empty lines. */
  private static async readPipedStdin(): Promise<string[]> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks)
      .toString("utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
}

async function main(): Promise<void> {
  const argv = parseQuery(process.argv.slice(2));
  const cli = await FuzzyMatchCli.create(argv);
  await cli.run(argv);
}

main().catch((err) => {
  // commander already wrote help / its own error; exit with its code.
  if (err instanceof CommanderError) process.exit(err.exitCode);
  process.stderr.write(
    `${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
