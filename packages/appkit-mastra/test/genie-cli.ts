/**
 * Smoke test for the Genie tools. Builds the flat per-space tool
 * record via {@link buildGenieTools}, calls the `ask_genie` tool's
 * `execute(input, ctx)` directly with a stdout writer, and prints
 * both the live wire events (as they arrive on the writer) and
 * the terminal `GenieMessage` the tool returns.
 *
 * The Genie tools forward raw {@link GenieWriterEvent}s on the
 * writer (wire `GenieChatEvent`s plus Mastra-only lifecycle
 * events like `started`), so this CLI subscribes to the unified
 * flat `{type, ...}` shape directly.
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
 */

import { WorkspaceClient } from "@databricks/sdk-experimental";
import type { GenieWriterEvent, MastraWriter } from "@dbx-tools/appkit-mastra-shared";
import { type GenieMessage, humanizeStatus } from "@dbx-tools/genie-shared";
import { appkitUtils } from "@dbx-tools/shared";
import { RequestContext } from "@mastra/core/request-context";
import type { Tool } from "@mastra/core/tools";
import readline from "node:readline/promises";

import { MASTRA_USER_KEY, type MastraPluginConfig, type User } from "../src/config.js";
import { buildGenieTools, DEFAULT_GENIE_ALIAS } from "../src/genie.js";

/**
 * Pretty-print one writer event off the Genie tools. Renders the
 * events with meaningful CLI signal; the high-frequency `message`
 * / `rows` / `attachment` events are dropped because they aren't
 * useful in CLI form.
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
      process.stdout.write(`[suggested    ] ${event.questions.length} question(s)\n`);
      for (const q of event.questions) {
        process.stdout.write(`                  - ${q}\n`);
      }
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
    default:
      // Unknown variant (newer wire events, etc.) - log the
      // discriminator so the CLI tells us when the vocabulary
      // grew under us, without crashing the loop.
      process.stdout.write(`[${(event as { type?: string }).type ?? "unknown"}]\n`);
      break;
  }
}

/**
 * Minimal `ctx.writer` shim. `safeWrite` accepts any object with
 * a `.write(chunk)` method, so this stdout sink is enough for a
 * smoke test.
 */
function makeStdoutWriter(): MastraWriter {
  return {
    write: (chunk: unknown) => {
      if (chunk && typeof chunk === "object" && "type" in chunk) {
        renderWireEvent(chunk as GenieWriterEvent);
      }
    },
  };
}

/**
 * Render the terminal `GenieMessage` the `ask_genie` tool
 * returns. Prints the prose answer (when present), the statement
 * id(s) embedded on the message and its attachments so the CLI
 * makes it obvious which `get_statement` / `prepare_chart`
 * call would naturally follow.
 */
function renderFinalMessage(message: GenieMessage): void {
  process.stdout.write(`\n=== final GenieMessage ===\n`);
  process.stdout.write(`status=${message.status ?? "?"}\n`);
  if (message.content) process.stdout.write(`prompt: ${message.content}\n`);

  const queryStatementId =
    (message.query_result as { statement_id?: string } | undefined)?.statement_id ??
    undefined;
  if (queryStatementId) {
    process.stdout.write(`query_result.statement_id=${queryStatementId}\n`);
  }
  const attachments = message.attachments ?? [];
  attachments.forEach((att, i) => {
    const text = (att as { text?: { content?: string } }).text?.content;
    const sql = (att as { query?: { query?: string } }).query?.query;
    const sid = (att as { query?: { statement_id?: string } }).query?.statement_id;
    process.stdout.write(`attachment[${i}]:\n`);
    if (text) process.stdout.write(`  text: ${text}\n`);
    if (sid) process.stdout.write(`  statement_id: ${sid}\n`);
    if (sql) {
      process.stdout.write(`  sql (${sql.length} chars): ${sql.slice(0, 120)}\n`);
    }
  });
}

/**
 * Build a minimal `User` shape for the per-request `RequestContext`.
 * The Genie tools only read `user.executionContext.client`, so we
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

/** Build the minimal `MastraPluginConfig` the Genie tools + chart-planner read off. */
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
  askGenie: Tool;
  requestContext: RequestContext;
  writer: MastraWriter;
}): Promise<void> {
  process.stdout.write(`\n=== question: ${opts.question} ===\n`);
  if (!opts.askGenie.execute) {
    throw new Error("ask_genie tool has no execute (factory misconfigured)");
  }
  // The Genie tools' execute pulls only `requestContext`,
  // `writer`, and `abortSignal` off ctx; we cast through
  // `unknown` to avoid dragging in Mastra's full
  // `MastraToolInvocationOptions` type for a smoke test.
  const ctx = {
    requestContext: opts.requestContext,
    writer: opts.writer,
  } as unknown as Parameters<NonNullable<typeof opts.askGenie.execute>>[1];
  const result = (await opts.askGenie.execute({ question: opts.question }, ctx)) as {
    message: GenieMessage;
  };
  renderFinalMessage(result.message);
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
  const tools = buildGenieTools({
    spaces: { [DEFAULT_GENIE_ALIAS]: { spaceId } },
    config,
  });
  const askGenie = tools.ask_genie as Tool | undefined;
  if (!askGenie) {
    throw new Error(
      "buildGenieTools did not register ask_genie (expected for default alias)",
    );
  }
  // One RequestContext per CLI invocation: the Genie tools
  // re-read `MASTRA_USER_KEY` on every execute, so a single
  // context is enough for the REPL loop. The conversation id
  // seeded on the context persists across REPL turns so we
  // exercise the same multi-turn caching path the live agent
  // uses.
  const requestContext = new RequestContext();
  requestContext.set(MASTRA_USER_KEY, makeServiceUser(client));
  const writer = makeStdoutWriter();

  try {
    for await (const question of contents) {
      await runOne({ question, askGenie, requestContext, writer });
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
