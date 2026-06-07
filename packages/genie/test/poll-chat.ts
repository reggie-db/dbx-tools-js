/**
 * Smoke test for {@link genieEventChat}. Pulls a single question
 * from argv, piped stdin, or a REPL (one question per turn,
 * caller-threaded `conversation_id` so a REPL session is a
 * multi-turn Genie conversation), drives `genieEventChat`, and
 * writes every emitted event to a per-run tmp directory so you can
 * inspect deltas after the fact.
 *
 * Layout (one subdir per `genieEventChat` event variant, plus
 * `rows-data/` for paired SQL fetches):
 *
 *   tmp/genie-run-<uuid>/
 *     message/              # `message` event - every yielded snapshot
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
import type { GenieChatEvent, GenieChatEventType } from "@dbx-tools/genie-shared";
import { genieEventChat } from "../src/chat.js";

// All event files for one process invocation live under this dir.
const RUN_DIR = path.resolve("tmp", `genie-run-${randomUUID()}`);

// Per-type counters so each event subdir gets monotonically
// increasing file names (`0001.yaml`, `0002.yaml`, ...) in
// arrival order. The narrow `Record<...>` shape makes the counter
// type-checked against the event variants we support.
type SubDir = GenieChatEventType | "rows-data";
const counters: Record<SubDir, number> = {
  message: 0,
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
 * Synchronous event write. We use sync I/O so the writer returns
 * AFTER the file lands, which keeps the counter and file order
 * race-free even when events arrive back-to-back. For a smoke
 * test against the local fs the latency is irrelevant.
 */
function writeEvent(type: SubDir, payload: unknown): string {
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
 * Render one event to stdout and persist its full body to the
 * matching subdir. Each variant's flat `{type, ...fields}` shape
 * narrows on `event.type`, so per-event field access (e.g.
 * `event.sql`, `event.statement_id`) is type-safe.
 */
function renderEvent(event: GenieChatEvent): void {
  const file = writeEvent(event.type, event);
  switch (event.type) {
    case "message":
      process.stdout.write(
        `[message      ] ${file}  status=${event.message.status ?? "<unknown>"}\n`,
      );
      break;
    case "status":
      process.stdout.write(
        `[status       ] ${file}  ${event.previous_status ?? "<initial>"} -> ${event.status}\n`,
      );
      break;
    case "attachment":
      process.stdout.write(
        `[attachment   ] ${file}  #${event.index} type=${event.attachment_type}\n`,
      );
      break;
    case "thinking":
      process.stdout.write(
        `[thinking     ] ${file}  ${event.thought_type}\n`,
      );
      break;
    case "text":
      process.stdout.write(`[text         ] ${file}\n`);
      break;
    case "query":
      process.stdout.write(
        `[query        ] ${file}  ${event.sql.length} chars\n`,
      );
      break;
    case "statement":
      process.stdout.write(
        `[statement    ] ${file}  ${event.statement_id}\n`,
      );
      break;
    case "rows":
      process.stdout.write(
        `[rows         ] ${file}  ${event.previous_row_count ?? "?"} -> ${event.row_count}\n`,
      );
      break;
    case "suggested_questions":
      process.stdout.write(
        `[suggested_q  ] ${file}  ${event.questions.length} question(s)\n`,
      );
      break;
    case "result":
      process.stdout.write(
        `[result       ] ${file}  status=${event.status}\n`,
      );
      break;
  }
}

/**
 * Yield trimmed lines from the readline interface until the user
 * submits an empty line or hits Ctrl+D.
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
  // Caller-threaded multi-turn: every question reuses the
  // conversation id we read off the prior turn's result.
  let conversationId: string | undefined;

  // The SQL-statement fetch on terminal messages is async, so we
  // can't run it inline in the event loop. Track each fetch's
  // promise and await them all after the run so the process
  // doesn't exit mid-fetch.
  const queryFetches: Promise<void>[] = [];

  try {
    for await (const question of contents) {
      for await (const event of genieEventChat(spaceId, question, {
        workspaceClient: client,
        conversationId,
      })) {
        renderEvent(event);
        if (event.type === "result") {
          conversationId = event.conversation_id ?? conversationId;
          const statementId = event.message.query_result?.statement_id;
          if (statementId) {
            queryFetches.push(fetchAndWriteQuery(client, statementId));
          }
        }
      }
    }
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
