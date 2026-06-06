/**
 * Minimal raw-fetch Genie conversation poller. Reads a question from
 * stdin, opens a new Genie conversation against
 * `$DATABRICKS_GENIE_SPACE_ID`, polls the Genie message every 250ms,
 * and dumps the exact JSON response every time it changes (by
 * `JSON.stringify` equality). Exits when the message reaches a
 * terminal status (`COMPLETED`, `FAILED`, `CANCELLED`).
 *
 * Every poll is also appended to a per-run log file at
 * `<repo-root>/.tmp/genie-poll-<isoTimestamp>.log`, one JSON object
 * per line (duplicates included). When a response differs from the
 * previously logged one (pure string compare on the serialized JSON),
 * a `#UPDATED` marker line is written immediately before the new
 * payload so changes are visible at a glance when tailing the log.
 *
 * `@databricks/sdk-experimental` is used ONLY to mint an OAuth bearer
 * via the standard `.databrickscfg` / env-var resolution chain - all
 * actual Genie traffic is plain `fetch`, so this script doubles as a
 * concrete reference for the wire-level conversation API (request
 * shape, status-machine, polling cadence) without any SDK indirection.
 *
 * Run:
 *
 *   echo "Top 5 stores by revenue?" \
 *     | bun packages/genie/test/poll.ts
 *
 * or interactively (type the question, then Ctrl-D):
 *
 *   bun packages/genie/test/poll.ts
 *
 * Required env (already in repo `.env`):
 *
 *   DATABRICKS_GENIE_SPACE_ID
 *   DATABRICKS_CONFIG_PROFILE   (or any other SDK auth env)
 */

import fs from "node:fs";
import path from "node:path";

import { WorkspaceClient } from "@databricks/sdk-experimental";
import { diff as deepDiff, type Diff } from "deep-diff";

const POLL_INTERVAL_MS = 250;
const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const UPDATED_MARKER = "#UPDATED";
const DIFF_PREFIX = "#DIFF";

/**
 * Genie bumps `*_timestamp` fields on heartbeats (sometimes without
 * the payload otherwise changing, sometimes lagging behind a body
 * change). Treating those as real "what changed?" entries floods the
 * diff log with noise, so we strip them out via `deep-diff`'s
 * prefilter (return `true` to drop the key from the comparison).
 *
 * Matches `created_timestamp`, `last_updated_timestamp`, and any
 * future camelCase variant (`createdAt`, `updatedAt`, ...).
 */
const TIMESTAMP_KEY_RE = /(?:^|_)(?:timestamp|time)$|(?:At|At[Zz])$/;

function isTimestampKey(_path: unknown[], key: unknown): boolean {
  return typeof key === "string" && TIMESTAMP_KEY_RE.test(key);
}

/** Render one `deep-diff` change as a single human-readable line. */
function formatDiff(d: Diff<unknown, unknown>): string {
  const where = formatPath(d.path ?? []);
  switch (d.kind) {
    case "N":
      return `+ ${where} = ${stringifyValue(d.rhs)}`;
    case "D":
      return `- ${where} = ${stringifyValue(d.lhs)}`;
    case "E":
      return `~ ${where}: ${stringifyValue(d.lhs)} -> ${stringifyValue(d.rhs)}`;
    case "A":
      // Array delta: deep-diff nests the per-element change inside
      // `item`, with `index` telling us which slot moved. Flatten that
      // into a single line so the reader doesn't have to mentally
      // join `path` + `index`.
      return formatDiff({
        ...d.item,
        path: [...(d.path ?? []), d.index],
      } as Diff<unknown, unknown>);
  }
}

function formatPath(p: unknown[]): string {
  let out = "";
  for (const seg of p) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out.length === 0 ? String(seg) : `.${String(seg)}`;
  }
  return out.length > 0 ? out : "<root>";
}

const MAX_VALUE_PREVIEW = 160;

function stringifyValue(v: unknown): string {
  const s = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v);
  if (s === undefined) return "undefined";
  if (s.length <= MAX_VALUE_PREVIEW) return s;
  return `${s.slice(0, MAX_VALUE_PREVIEW)}... (+${s.length - MAX_VALUE_PREVIEW} chars)`;
}

function diffMessages(prev: unknown, next: unknown): string[] {
  const diffs = deepDiff(prev, next, isTimestampKey) ?? [];
  return diffs.map(formatDiff);
}

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`Could not locate repo root from ${startDir}`);
}

function openPollLog(): { stream: fs.WriteStream; filePath: string } {
  const repoRoot = findRepoRoot(import.meta.dirname);
  const tmpDir = path.join(repoRoot, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(tmpDir, `genie-poll-${stamp}.log`);
  // `flags: "a"` so multiple invocations could in theory share a path,
  // but the per-second timestamp in the filename already avoids
  // collisions between concurrent runs.
  const stream = fs.createWriteStream(filePath, { flags: "a" });
  return { stream, filePath };
}

async function readStdinToEnd(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function resolveBearer(client: WorkspaceClient): Promise<string> {
  // `Config.authenticate(headers)` mutates the passed Headers object,
  // adding `Authorization: Bearer <token>` (PAT / OAuth / Azure CLI,
  // depending on the resolved auth strategy). We do the absolute
  // minimum here: hand it a fresh Headers, then read the result back.
  const headers = new Headers();
  await client.config.authenticate(headers);
  const auth = headers.get("Authorization");
  if (!auth) {
    throw new Error(
      "WorkspaceClient.config.authenticate() did not produce an Authorization header",
    );
  }
  return auth;
}

async function resolveHost(client: WorkspaceClient): Promise<string> {
  const url = await client.config.getHost();
  return url.toString().replace(/\/+$/, "");
}

interface GenieFetchOptions {
  method: "GET" | "POST";
  body?: unknown;
}

async function genieFetch<T = unknown>(
  host: string,
  bearer: string,
  path: string,
  options: GenieFetchOptions,
): Promise<T> {
  const res = await fetch(`${host}${path}`, {
    method: options.method,
    headers: {
      Authorization: bearer,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `${options.method} ${path} -> ${res.status} ${res.statusText}\n${text}`,
    );
  }
  return text.length > 0 ? (JSON.parse(text) as T) : (undefined as T);
}

interface GenieMessage {
  message_id: string;
  conversation_id: string;
  status: string;
  [k: string]: unknown;
}

function emit(label: string, payload: unknown): void {
  process.stdout.write(`--- ${label} ---\n`);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n\n`);
}

async function main(): Promise<void> {
  const spaceId = process.env.DATABRICKS_GENIE_SPACE_ID;
  if (!spaceId) {
    throw new Error(
      "DATABRICKS_GENIE_SPACE_ID is required (set it in repo .env or your shell)",
    );
  }

  const question = (process.argv[2] ?? (await readStdinToEnd())).trim();
  if (!question) {
    throw new Error("No question provided on argv or stdin");
  }

  const client = new WorkspaceClient({});
  const [bearer, host] = await Promise.all([
    resolveBearer(client),
    resolveHost(client),
  ]);

  const { stream: pollLog, filePath: pollLogPath } = openPollLog();
  emit("question", { spaceId, host, question, pollLog: pollLogPath });

  const startUrl =
    `/api/2.0/genie/spaces/${encodeURIComponent(spaceId)}` + `/start-conversation`;
  const created = await genieFetch<{
    conversation_id: string;
    message: GenieMessage;
  }>(host, bearer, startUrl, {
    method: "POST",
    body: { content: question },
  });

  emit("start-conversation response", created);

  const conversationId = created.conversation_id;
  const messageId = created.message.message_id;
  const pollUrl =
    `/api/2.0/genie/spaces/${encodeURIComponent(spaceId)}` +
    `/conversations/${encodeURIComponent(conversationId)}` +
    `/messages/${encodeURIComponent(messageId)}`;

  // Track the previously *logged* serialized line so we can stamp a
  // `#UPDATED` divider only when the wire response actually changed.
  // The initial message returned by start-conversation counts as the
  // first logged line. We also keep the parsed object around so we
  // can compute a timestamp-ignoring deep diff against the next poll.
  let lastSerialized = JSON.stringify(created.message);
  let lastMessage: GenieMessage = created.message;
  let lastStatus = created.message.status;
  pollLog.write(`${lastSerialized}\n`);

  while (!TERMINAL_STATUSES.has(lastStatus)) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const current = await genieFetch<GenieMessage>(host, bearer, pollUrl, {
      method: "GET",
    });
    const serialized = JSON.stringify(current);
    const changed = serialized !== lastSerialized;
    if (changed) {
      pollLog.write(`${UPDATED_MARKER}\n`);
      // Deep diff (ignoring timestamps) explains *what* changed,
      // separately from the full JSON payload that follows. When the
      // only difference between two polls is a heartbeat timestamp
      // bump the diff comes back empty and we record a single
      // marker so the log still reflects that we noticed the wire
      // payload changed even if nothing semantic moved.
      const changes = diffMessages(lastMessage, current);
      if (changes.length === 0) {
        pollLog.write(`${DIFF_PREFIX}: <timestamp-only>\n`);
      } else {
        for (const line of changes) pollLog.write(`${DIFF_PREFIX}: ${line}\n`);
      }
      emit(`poll status=${current.status}`, {
        changes: changes.length > 0 ? changes : ["<timestamp-only>"],
        current,
      });
    }
    pollLog.write(`${serialized}\n`);
    lastSerialized = serialized;
    lastMessage = current;
    lastStatus = current.status;
  }

  emit("terminal", {
    status: lastStatus,
    conversationId,
    messageId,
    pollLog: pollLogPath,
  });
  await new Promise<void>((resolve, reject) => {
    pollLog.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });
  process.exit(lastStatus === "COMPLETED" ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
  process.exit(2);
});
