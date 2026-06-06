/**
 * Reference CLI for `@dbx-tools/genie`'s async-generator service.
 *
 * Drives one Genie conversation turn end-to-end and prints every
 * yielded event to stdout, so the `[<event>] ...` log doubles as a
 * live spec for what {@link streamGenie} surfaces per poll.
 *
 * Run:
 *
 *   bun packages/genie/test/cli.ts --question "Top 5 stores by revenue?"
 *
 * or pipe the question on stdin (useful for chained shell tools):
 *
 *   echo "Top 5 stores by revenue?" | bun packages/genie/test/cli.ts
 *
 * To follow up on an existing thread:
 *
 *   bun packages/genie/test/cli.ts \
 *     --conversation-id 01f1612a... \
 *     --question "Now show just the bottom 5"
 *
 * Required env (already in repo `.env`):
 *
 *   DATABRICKS_GENIE_SPACE_ID     # default --space-id
 *   DATABRICKS_CONFIG_PROFILE     # or any other SDK auth env
 */

import { WorkspaceClient } from "@databricks/sdk-experimental";
import { Command, Option } from "commander";

import { GenieEventType } from "../src/protocol.js";
import { streamGenie, type GenieFetchRowsMode } from "../src/service.js";

const DEFAULT_FETCH_ROWS: GenieFetchRowsMode = "on-complete";
const DEFAULT_POLL_INTERVAL_MS = 500;
// Reuse the same env name the raw-fetch poll.ts script reads so a
// single `DATABRICKS_GENIE_SPACE_ID` covers both test entry points.
const SPACE_ID_ENV = "DATABRICKS_GENIE_SPACE_ID";

/** Read the entire stdin stream to a string (used when `--question` is omitted). */
async function readStdinToEnd(): Promise<string> {
  if (process.stdin.isTTY) {
    process.stderr.write(
      "Enter question, then Ctrl-D (or pass --question on the command line):\n",
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

/**
 * Truncate a string to `max` chars with an explicit ellipsis. We
 * never want to dump 80-row SQL result payloads through the
 * one-line event log - rerun with `--fetch-rows never` and pull
 * rows via the SDK directly if the full array is needed.
 */
function truncate(s: string, max = 200): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 3)}...`;
}

/** Indent every line of `s` by `prefix` for nested event payloads. */
function indent(s: string, prefix = "    "): string {
  return s
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

/** Emit a structured `[<event>] <one-line summary>` plus optional indented body. */
function log(event: string, summary: string, body?: string): void {
  process.stdout.write(`[${event}] ${summary}\n`);
  if (body) process.stdout.write(`${indent(body)}\n`);
}

async function main(): Promise<void> {
  const program = new Command()
    .name("genie-cli")
    .description(
      "Run a Genie conversation against a Databricks space and stream every wire event.",
    )
    .option("-q, --question <text>", "Question to send. If omitted, reads stdin.")
    .option(
      "-s, --space-id <id>",
      `Genie space id. Defaults to $${SPACE_ID_ENV}.`,
      process.env[SPACE_ID_ENV],
    )
    .option(
      "-c, --conversation-id <id>",
      "Continue an existing conversation instead of starting a new one.",
    )
    .option(
      "-i, --interval <ms>",
      "Poll cadence in milliseconds.",
      (v) => Number.parseInt(v, 10),
      DEFAULT_POLL_INTERVAL_MS,
    )
    .addOption(
      new Option("-f, --fetch-rows <mode>", "When to fetch SQL row data.")
        .choices(["on-next", "on-complete", "never"] satisfies GenieFetchRowsMode[])
        .default(DEFAULT_FETCH_ROWS),
    )
    .parse(process.argv);

  const opts = program.opts<{
    question?: string;
    spaceId?: string;
    conversationId?: string;
    interval: number;
    fetchRows: GenieFetchRowsMode;
  }>();

  // Use process.exit (typed as `never`) for required-flag
  // validation rather than `program.error()` so narrowing back to
  // `string` is reliable across TS versions / commander typings.
  if (!opts.spaceId) {
    console.error(`Error: --space-id is required (or set ${SPACE_ID_ENV})`);
    process.exit(1);
  }
  const spaceId = opts.spaceId;
  const question = opts.question ?? (await readStdinToEnd());
  if (!question) {
    console.error("Error: No question provided. Pass --question or pipe one on stdin.");
    process.exit(1);
  }

  log("config", `spaceId=${spaceId} pollMs=${opts.interval} fetchRows=${opts.fetchRows}`);
  if (opts.conversationId) {
    log("config", `continuing conversation ${opts.conversationId}`);
  }
  log("question", question);

  // The SDK reads `.databrickscfg` / DATABRICKS_* env on construct.
  // Empty `{}` means "use whatever auth chain is already wired up".
  const client = new WorkspaceClient({});

  // Hard-cancel on Ctrl-C so the user sees a clean teardown rather
  // than a hung poll loop.
  const controller = new AbortController();
  const sigintHandler = (): void => {
    log("signal", "SIGINT, aborting run");
    controller.abort("user SIGINT");
  };
  process.on("SIGINT", sigintHandler);

  // Counters for the summary line at the end. Accumulated from the
  // event stream itself - the old `snapshot()` surface is gone now
  // that everything flows through the generator.
  let attachmentsSeen = 0;
  let statementsSeen = 0;
  let thoughtsSeen = 0;
  let queryResultsSeen = 0;

  try {
    for await (const event of streamGenie({
      client,
      spaceId,
      question,
      conversationId: opts.conversationId,
      pollIntervalMs: opts.interval,
      fetchRows: opts.fetchRows,
      signal: controller.signal,
    })) {
      switch (event.type) {
        case GenieEventType.RAW:
          // Intentionally quiet: every poll fires this. The
          // `updated` event below is the noise-filtered version.
          break;
        case GenieEventType.UPDATED:
          log("updated", "(wire payload changed since last poll)");
          break;
        case GenieEventType.STATUS:
          log("status", `${event.prev ?? "<none>"} -> ${event.status}`);
          break;
        case GenieEventType.ATTACHMENT: {
          attachmentsSeen += 1;
          const kind = event.attachment.query
            ? "query"
            : event.attachment.text
              ? "text"
              : event.attachment.suggested_questions
                ? "suggested_questions"
                : "unknown";
          log(
            "attachment",
            `[${event.index}] kind=${kind} id=${event.attachment.attachment_id ?? "<anonymous>"}`,
          );
          break;
        }
        case GenieEventType.STATEMENT_ID:
          statementsSeen += 1;
          log(
            "statementId",
            `statement=${event.statementId} attachment=${event.attachmentId ?? "<anon>"}`,
          );
          break;
        case GenieEventType.DESCRIPTION:
          log("description", `attachment=${event.attachmentId ?? "<anon>"}`, event.description);
          break;
        case GenieEventType.SQL:
          log("sql", `attachment=${event.attachmentId ?? "<anon>"}`, event.sql);
          break;
        case GenieEventType.THOUGHT:
          thoughtsSeen += 1;
          log(
            "thought",
            `${event.thought.thought_type} attachment=${event.attachmentId ?? "<anon>"}`,
            event.thought.content,
          );
          break;
        case GenieEventType.TEXT:
          log(
            "text",
            `attachment=${event.attachmentId ?? "<anon>"}${
              event.purpose ? ` purpose=${event.purpose}` : ""
            }`,
            event.content,
          );
          break;
        case GenieEventType.SUGGESTED_QUESTIONS:
          log(
            "suggestedQuestions",
            `attachment=${event.attachmentId ?? "<anon>"} count=${event.questions.length}`,
            event.questions.map((q, i) => `${i + 1}. ${q}`).join("\n"),
          );
          break;
        case GenieEventType.ROW_COUNT:
          log(
            "rowCount",
            `${event.prev ?? 0} -> ${event.rowCount} (attachment=${event.attachmentId ?? "<anon>"})`,
          );
          break;
        case GenieEventType.QUERY_RESULT: {
          queryResultsSeen += 1;
          const manifest = event.data.statement_response?.manifest;
          const rows = event.data.statement_response?.result?.data_array?.length ?? 0;
          log(
            "queryResult",
            `statement=${event.statementId} attachment=${event.attachmentId} rows=${rows} schema=${
              manifest?.schema?.columns?.length ?? "?"
            }`,
            truncate(JSON.stringify(event.data.statement_response?.result?.data_array ?? [])),
          );
          break;
        }
        case GenieEventType.QUERY_ERROR:
          log(
            "queryError",
            `statement=${event.statementId} attachment=${event.attachmentId}`,
            event.error instanceof Error
              ? event.error.stack ?? event.error.message
              : String(event.error),
          );
          break;
        case GenieEventType.MESSAGE_ERROR:
          log("messageError", `type=${event.errorType ?? "<unknown>"}`, event.error);
          break;
        case GenieEventType.TERMINAL:
          log(
            "terminal",
            `status=${event.status} conversation=${event.message.conversation_id ?? "<unknown>"} message=${
              event.message.message_id ?? "<unknown>"
            }`,
          );
          break;
      }
    }
    log(
      "summary",
      `attachments=${attachmentsSeen} statements=${statementsSeen} thoughts=${thoughtsSeen} queryResults=${queryResultsSeen}`,
    );
    process.exit(0);
  } catch (err) {
    log("error", err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    process.off("SIGINT", sigintHandler);
  }
}

await main();
