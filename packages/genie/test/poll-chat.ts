/**
 * Smoke test for {@link genieChat} (the high-level `GenieChat`
 * handle). Builds an async iterable of questions (REPL, argv, or
 * piped stdin), drives a single `GenieChat` across every turn, and
 * writes every emitted event to a per-run tmp directory so you can
 * inspect deltas after the fact.
 *
 * Layout (one subdir per `GenieChat` event, plus `rows-data/`
 * for paired SQL fetches):
 *
 *   tmp/genie-run-<uuid>/
 *     raw/                  # `message` event - every yielded snapshot
 *     status/               # `status` event - top-level transitions
 *     attachment/           # `attachment` event - new attachment slots
 *     thinking/             # `thinking` event - new reasoning steps
 *     text/                 # `text` event - text-attachment changes
 *     query/                # `query` event - SQL finalized
 *     statement/            # `statement` event - warehouse submission
 *     rows/                 # `rows` event - row-count changes
 *     suggested_questions/  # `suggested_questions` event
 *     result/               # `result` event - terminal-status payloads
 *     rows-data/            # paired SQL fetches for terminals with
 *                           # a `query_result.statement_id`
 *
 * Each file is `<NNNN>.yaml` (counter per subdir, arrival order,
 * zero-padded so directory listings sort naturally). Stdout
 * carries a one-line summary per event with the relative path.
 *
 * REPL mode (interactive `isTTY`) keeps a single `GenieChat`
 * instance alive across questions, so multi-turn follow-ups land
 * in the same Genie conversation. Empty line / Ctrl+D exits.
 *
 * Run:
 *
 *   bun packages/genie/test/poll-chat.ts                          # REPL
 *   bun packages/genie/test/poll-chat.ts "Top 5 stores by revenue?"
 *   echo "Top 5 stores by revenue?" | bun packages/genie/test/poll-chat.ts
 *
 * Required env (already in repo `.env`):
 *
 *   DATABRICKS_GENIE_SPACE_ID
 *   DATABRICKS_CONFIG_PROFILE   (or any other SDK auth env)
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import yaml from "yaml";
import { WorkspaceClient } from "@databricks/sdk-experimental";
import { genieChat } from "../src/chat.js";

// All event files for one process invocation live under this dir.
const RUN_DIR = path.resolve("tmp", `genie-run-${randomUUID()}`);

// Per-type counters so each event subdir gets monotonically
// increasing file names (`0001.yaml`, `0002.yaml`, ...) in
// arrival order. The narrow `Record<EventType, number>` shape
// makes the counter type-checked against the event types we
// support.
const EVENT_TYPES = [
  "raw",
  "status",
  "attachment",
  "thinking",
  "text",
  "query",
  "statement",
  "rows",
  "suggested_questions",
  "result",
  "rows-data",
] as const;
type EventType = (typeof EVENT_TYPES)[number];
const counters: Record<EventType, number> = {
  raw: 0,
  status: 0,
  attachment: 0,
  thinking: 0,
  text: 0,
  query: 0,
  statement: 0,
  rows: 0,
  suggested_questions: 0,
  result: 0,
  "rows-data": 0,
};

/**
 * Synchronous event write. We use sync I/O so `EventEmitter.emit`
 * returns AFTER the file lands, which keeps the counter and file
 * order race-free even though `emit` itself is fire-and-forget.
 * For a smoke test against the local fs the latency is irrelevant.
 */
function writeEvent(type: EventType, payload: unknown): string {
  const dir = path.join(RUN_DIR, type);
  // mkdirSync({ recursive: true }) is idempotent and cheap for an
  // already-existing dir, so calling it per-write keeps subdirs
  // from being created when their event never fires.
  mkdirSync(dir, { recursive: true });
  counters[type] += 1;
  const file = path.join(dir, `${String(counters[type]).padStart(4, "0")}.yaml`);
  writeFileSync(file, yaml.stringify(payload, { indent: 2, lineWidth: 0 }));
  return path.relative(process.cwd(), file);
}

/**
 * Yield trimmed lines from the readline interface until the user
 * submits an empty line or hits Ctrl+D. The `yield` suspends the
 * generator until the consumer pulls the next item, so the prompt
 * only fires after the previous turn has fully drained.
 */
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

async function main(): Promise<void> {
  const spaceId = process.env.DATABRICKS_GENIE_SPACE_ID;
  if (!spaceId) {
    throw new Error(
      "DATABRICKS_GENIE_SPACE_ID is required (set it in repo .env or your shell)",
    );
  }

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

  mkdirSync(RUN_DIR, { recursive: true });
  process.stdout.write(
    `writing events to ${path.relative(process.cwd(), RUN_DIR)}\n`,
  );

  const client = new WorkspaceClient({});
  const chat = genieChat(spaceId, contents, { workspaceClient: client });

  chat.on("message", (m) => {
    const file = writeEvent("raw", m);
    process.stdout.write(
      `[raw          ] ${file}  status=${m.status ?? "<unknown>"}\n`,
    );
  });
  chat.on("status", (e) => {
    const file = writeEvent("status", e);
    process.stdout.write(
      `[status       ] ${file}  ${e.previous_status ?? "<initial>"} -> ${e.status}\n`,
    );
  });
  chat.on("attachment", (e) => {
    const file = writeEvent("attachment", e);
    process.stdout.write(
      `[attachment   ] ${file}  #${e.index} type=${e.type}\n`,
    );
  });
  chat.on("thinking", (e) => {
    const file = writeEvent("thinking", e);
    process.stdout.write(`[thinking     ] ${file}  ${e.thought_type}\n`);
  });
  chat.on("text", (e) => {
    const file = writeEvent("text", e);
    process.stdout.write(`[text         ] ${file}\n`);
  });
  chat.on("query", (e) => {
    const file = writeEvent("query", e);
    process.stdout.write(`[query        ] ${file}  ${e.sql.length} chars\n`);
  });
  chat.on("statement", (e) => {
    const file = writeEvent("statement", e);
    process.stdout.write(`[statement    ] ${file}  ${e.statement_id}\n`);
  });
  chat.on("rows", (e) => {
    const file = writeEvent("rows", e);
    process.stdout.write(
      `[rows         ] ${file}  ${e.previous_row_count ?? "?"} -> ${e.row_count}\n`,
    );
  });
  chat.on("suggested_questions", (e) => {
    const file = writeEvent("suggested_questions", e);
    process.stdout.write(
      `[suggested_q  ] ${file}  ${e.questions.length} question(s)\n`,
    );
  });

  // The SQL-statement fetch on terminal messages is async, so we
  // can't run it inline in the event handler (emit is sync). Track
  // each fetch's promise and await them all after the chat
  // finishes so the process doesn't exit mid-fetch.
  const queryFetches: Promise<void>[] = [];
  chat.on("result", (e) => {
    const file = writeEvent("result", e);
    process.stdout.write(`[result       ] ${file}  status=${e.status}\n`);
    const statementId = e.message.query_result?.statement_id;
    if (!statementId) return;
    queryFetches.push(fetchAndWriteQuery(client, statementId));
  });

  try {
    await chat.run();
    await Promise.all(queryFetches);
  } finally {
    rl?.close();
  }
}

async function fetchAndWriteQuery(
  client: WorkspaceClient,
  statementId: string,
): Promise<void> {
  const response = await client.statementExecution.getStatement({
    statement_id: statementId,
  });
  const file = writeEvent("rows-data", { statement_id: statementId, response });
  process.stdout.write(
    `[rows-data    ] ${file}  for statement ${statementId}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
