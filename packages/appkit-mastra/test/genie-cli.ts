/**
 * Smoke test for {@link createGenieTool}. Builds the Genie
 * tool, calls its `execute(input, ctx)` directly with a stdout
 * writer, and prints both the live wire events and the final
 * hydrated `(string | visualize)[]` summary.
 *
 * The Genie tool forwards raw {@link GenieWriterEvent}s on the
 * writer (wire `GenieChatEvent`s plus Mastra-only lifecycle
 * events like `started` / `chart`), so this CLI subscribes to
 * the unified flat `{type, ...}` shape directly.
 *
 * Run:
 *
 *   bun packages/appkit-mastra/test/genie-cli.ts                          # REPL
 *   bun packages/appkit-mastra/test/genie-cli.ts "Top 5 stores by revenue?"
 *   echo "Top 5 stores by revenue?" | bun packages/appkit-mastra/test/genie-cli.ts
 *
 * Required env (already in repo `.env`):
 *
 *   DATABRICKS_GENIE_SPACE_ID
 *   DATABRICKS_CONFIG_PROFILE       (or any other SDK auth env)
 *   DATABRICKS_SERVING_ENDPOINT_NAME  (optional; falls back to Mastra's default ladder)
 */

import readline from "node:readline/promises";
import { WorkspaceClient } from "@databricks/sdk-experimental";
import type {
  GenieAgentResult,
  GenieSummaryItem,
  GenieWriterEvent,
  MinimalWriter,
} from "@dbx-tools/appkit-mastra-shared";
import { humanizeStatus } from "@dbx-tools/genie-shared";
import { appkitUtils } from "@dbx-tools/shared";
import { RequestContext } from "@mastra/core/request-context";

import { MASTRA_USER_KEY, type MastraPluginConfig, type User } from "../src/config.js";
import { createGenieTool } from "../src/genie.js";

/**
 * Pretty-print one writer event off the Genie tool. Renders the
 * events with meaningful CLI signal (started, status, thinking,
 * query, statement, text, suggested_questions, chart, result,
 * error, ask_genie_done); the high-frequency `message` / `rows` /
 * `attachment` events are dropped because they aren't useful in
 * CLI form.
 */
function renderWireEvent(event: GenieWriterEvent): void {
  switch (event.type) {
    case "started":
      process.stdout.write(
        `[started      ] space=${event.spaceId}${event.conversationId ? ` conv=${event.conversationId}` : ""}\n`,
      );
      break;
    case "status":
      process.stdout.write(
        `[status       ] ${humanizeStatus(event.status)} (${event.status})\n`,
      );
      break;
    case "thinking":
      process.stdout.write(`[thinking     ] (${event.thought_type}) ${event.text}\n`);
      break;
    case "query":
      process.stdout.write(
        `[sql          ] ${event.title ?? "<untitled>"} (${event.sql.length} chars)\n`,
      );
      break;
    case "statement":
      process.stdout.write(`[statement    ] ${event.statement_id}\n`);
      break;
    case "text":
      process.stdout.write(`[text         ] ${event.text}\n`);
      break;
    case "suggested_questions":
      process.stdout.write(
        `[suggested    ] ${event.questions.length} question(s)\n`,
      );
      for (const q of event.questions) {
        process.stdout.write(`                  - ${q}\n`);
      }
      break;
    case "summary":
      process.stdout.write(
        `[summary      ] items=${event.items} text=${event.textItems} data=${event.dataItems}\n`,
      );
      break;
    case "chart":
      process.stdout.write(
        `[chart        ] ${event.chartId} ${event.title ?? "<untitled>"}\n`,
      );
      break;
    case "ask_genie_done":
      process.stdout.write(
        `[ask_done     ] status=${event.status} statements=${event.statementIds.length}\n`,
      );
      break;
    case "error":
      process.stdout.write(`[error        ] ${event.error}\n`);
      break;
    case "result":
      process.stdout.write(`[result       ] status=${event.status}\n`);
      break;
    case "message":
    case "rows":
    case "attachment":
      // Intentional drop - too noisy for a CLI tail and the
      // higher-level events above already cover the useful
      // transitions.
      break;
  }
}

/**
 * Minimal `ctx.writer` shim. `safeWrite` accepts any object with
 * a `.write(chunk)` method, so this stdout sink is enough for a
 * smoke test.
 */
function makeStdoutWriter(): MinimalWriter {
  return {
    write: (chunk: unknown) => {
      if (chunk && typeof chunk === "object" && "type" in chunk) {
        renderWireEvent(chunk as GenieWriterEvent);
      }
    },
  };
}

/**
 * Render one entry from the v2 tool's final
 * `(string | visualize)[]` summary. Truncated to the first 10
 * rows since this is for smoke testing, not full inspection.
 */
function renderSummaryItem(item: GenieSummaryItem, index: number): void {
  switch (item.type) {
    case "string":
      process.stdout.write(`\n[${index + 1}] string\n${item.text}\n`);
      break;
    case "visualize": {
      const { data, chart } = item.dataset;
      const head = data.rows.slice(0, 10);
      const chartLabel = chart ? `${chart.chartType} chart` : "no chart (table only)";
      process.stdout.write(
        `\n[${index + 1}] visualize: ${item.title ?? "<untitled>"} (${chartLabel}, ${data.rowCount} row${data.rowCount === 1 ? "" : "s"}, ${data.columns.length} col${data.columns.length === 1 ? "" : "s"})\n`,
      );
      if (item.description) {
        process.stdout.write(`    ${item.description}\n`);
      }
      process.stdout.write(`    statementId=${item.statementId}\n`);
      if (chart) {
        process.stdout.write(`    chartId=${chart.chartId}\n`);
      }
      process.stdout.write(`    columns: ${data.columns.join(", ")}\n`);
      for (const row of head) {
        process.stdout.write(`    ${JSON.stringify(row)}\n`);
      }
      if (data.rows.length > head.length) {
        process.stdout.write(
          `    ... (${data.rows.length - head.length} more row${data.rows.length - head.length === 1 ? "" : "s"})\n`,
        );
      }
      break;
    }
  }
}

/**
 * Build a minimal `User` shape for the per-request `RequestContext`.
 * The Genie tool only reads `user.executionContext.client`, so we
 * inline-construct a `WorkspaceClient` from the ambient
 * `DATABRICKS_*` env / config-profile and skip the full
 * `ServiceContext.initialize()` bootstrap that an Express-hosted
 * deployment goes through.
 */
function makeServiceUser(client: WorkspaceClient): User {
  return {
    id: "cli",
    executionContext: {
      client,
      serviceUserId: "cli",
      warehouseId: undefined,
      workspaceId: undefined,
    } as unknown as User["executionContext"],
  };
}

/** Build the minimal `MastraPluginConfig` the Genie tool + chart-planner read off. */
function makePluginConfig(): MastraPluginConfig {
  return { name: "mastra" } as MastraPluginConfig;
}

async function* readQuestions(rl: readline.Interface): AsyncGenerator<string> {
  while (true) {
    let q: string;
    try {
      q = (await rl.question("\nQuestion: ")).trim();
    } catch {
      return;
    }
    if (!q) return;
    yield q;
  }
}

async function readPipedStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function runOne(opts: {
  question: string;
  spaceId: string;
  config: MastraPluginConfig;
  requestContext: RequestContext;
  writer: MinimalWriter;
}): Promise<GenieAgentResult> {
  process.stdout.write(`\n=== question: ${opts.question} ===\n`);
  const tool = createGenieTool({
    spaceId: opts.spaceId,
    config: opts.config,
  });
  if (!tool.execute) {
    throw new Error("Genie tool has no execute (factory misconfigured)");
  }
  // The Genie tool's execute pulls only `requestContext`,
  // `writer`, and `abortSignal` off ctx; we cast through
  // `unknown` to avoid dragging in Mastra's full
  // `MastraToolInvocationOptions` type for a smoke test.
  const ctx = { requestContext: opts.requestContext, writer: opts.writer } as unknown as Parameters<
    NonNullable<typeof tool.execute>
  >[1];
  const result = (await tool.execute({ question: opts.question }, ctx)) as GenieAgentResult;

  process.stdout.write(
    `\n=== summary (${result.summary.length} item${result.summary.length === 1 ? "" : "s"}) ===\n`,
  );
  result.summary.forEach(renderSummaryItem);
  if (result.error) {
    process.stdout.write(`\n[error] ${result.error}\n`);
  }
  if (result.conversationId) {
    process.stdout.write(`\nconversationId=${result.conversationId}\n`);
  }
  return result;
}

async function main(): Promise<void> {
  const spaceId = process.env.DATABRICKS_GENIE_SPACE_ID;
  if (!spaceId) {
    throw new Error(
      "DATABRICKS_GENIE_SPACE_ID is required (set it in repo .env or your shell)",
    );
  }
  await appkitUtils.ensureInitialized();

  const argvQuestion = process.argv[2]?.trim();
  let contents: AsyncIterable<string> | Iterable<string>;
  let rl: readline.Interface | undefined;

  if (argvQuestion) {
    contents = [argvQuestion];
  } else if (!process.stdin.isTTY) {
    const piped = await readPipedStdin();
    if (!piped) throw new Error("No question provided on stdin");
    contents = [piped];
  } else {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    contents = readQuestions(rl);
  }

  const client = new WorkspaceClient({});
  const config = makePluginConfig();
  // One RequestContext per CLI invocation: the v2 tool re-reads
  // `MASTRA_USER_KEY` on every execute, so a single context is
  // enough for the REPL loop. No conversation threading across
  // REPL turns - v2 is invocation-scoped by design.
  const requestContext = new RequestContext();
  requestContext.set(MASTRA_USER_KEY, makeServiceUser(client));
  // One RequestContext per CLI invocation: the Genie tool
  // re-reads `MASTRA_USER_KEY` on every execute, so a single
  // context is enough for the REPL loop. No conversation
  // threading across REPL turns - the Genie tool is
  // invocation-scoped by design.
  const writer = makeStdoutWriter();

  try {
    for await (const question of contents) {
      await runOne({ question, spaceId, config, requestContext, writer });
    }
  } finally {
    rl?.close();
  }
}

/**
 * Render a thrown error in a way that surfaces `MastraError`'s
 * structured fields. `err.stack` alone often renders as
 * `"Error\n    at ..."` for `MastraError` instances because the
 * native `Error` header omits the `name`/`message` cleanly when
 * `message` is set lazily, and the failure mode we care about
 * (e.g. STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED) buries the
 * detail in `.details` and `.cause`.
 */
function printError(err: unknown): void {
  const e = err as {
    name?: string;
    message?: string;
    stack?: string;
    id?: string;
    domain?: string;
    category?: string;
    details?: Record<string, unknown>;
    cause?: unknown;
  };
  const head = `${e.name ?? "Error"}${e.message ? `: ${e.message}` : ""}`;
  process.stderr.write(`${head}\n`);
  if (e.id || e.domain || e.category) {
    process.stderr.write(
      `  id=${e.id ?? "?"} domain=${e.domain ?? "?"} category=${e.category ?? "?"}\n`,
    );
  }
  if (e.details && Object.keys(e.details).length > 0) {
    process.stderr.write(`  details=${JSON.stringify(e.details)}\n`);
  }
  if (e.cause) {
    const c = e.cause as { name?: string; message?: string };
    process.stderr.write(
      `  cause=${c.name ?? "Error"}${c.message ? `: ${c.message}` : ""}\n`,
    );
  }
  if (e.stack) {
    process.stderr.write(`${e.stack}\n`);
  }
}

main().catch((err) => {
  printError(err);
  process.exit(1);
});

// Surface unhandled promise rejections too - Mastra's structured
// output pipeline can fire-and-forget into a downstream stream
// whose rejection escapes our top-level catch, so we attach a
// listener to print + exit cleanly instead of letting the process
// crash with an opaque "Error\n    at ..." trace.
process.on("unhandledRejection", (reason) => {
  process.stderr.write("[unhandledRejection]\n");
  printError(reason);
  process.exit(1);
});
