# @dbx-tools/genie

Server-side Genie chat drivers. Two async generators that take a
`space_id` + a single `content` string for one turn against a Genie
space and yield either the raw `GenieMessage` snapshots
(`genieChat`) or a typed `GenieChatEvent` stream of flat
`{ type, ...fields }` records (`genieEventChat`).

Multi-turn conversations are caller-driven: read `conversation_id`
off the prior turn's terminal `GenieMessage` (or the `result`
event's `conversation_id`) and thread it into the next call's
`options.conversationId`.

```ts
import { genieEventChat } from "@dbx-tools/genie";

for await (const event of genieEventChat(spaceId, "Top 5 stores?")) {
  switch (event.type) {
    case "thinking":
      console.log("[think]", event.thought_type, event.text);
      break;
    case "query":
      console.log("[sql]", event.title, "\n", event.sql);
      break;
    case "result":
      console.log("[done]", event.status);
      break;
  }
}
```

Browser safety: `chat.ts` pulls in `WorkspaceClient` from
`@databricks/sdk-experimental` and is Node-only. Browser bundles
should import from [`@dbx-tools/genie-shared`](../genie-shared)
directly - the protocol types, the `GenieChatEvent` union, the pure
detectors, and `eventsFromMessage` all live there and are also
re-exported from `@dbx-tools/genie` for server-side convenience.

## `genieChat` - low-level snapshot stream

Yields every poll-observed `GenieMessage` for a single turn. Use it
when you want the raw stream (e.g. to drive a custom UI off the wire
shape, or to derive events yourself with the detectors in
`@dbx-tools/genie-shared`).

```ts
import { genieChat } from "@dbx-tools/genie";

// Single turn.
for await (const m of genieChat(spaceId, "Top 5 stores?")) {
  render(m);
}

// Multi-turn: caller threads the conversation id.
let conversationId: string | undefined;
for (const question of questions) {
  for await (const m of genieChat(spaceId, question, { conversationId })) {
    conversationId = m.conversation_id ?? conversationId;
    render(m);
  }
}
```

Turn lifecycle:

- **No `options.conversationId`**: opens a new conversation via
  `client.genie.startConversation`. The assigned id surfaces on
  every yielded `GenieMessage.conversation_id`.
- **With `options.conversationId`**: appends to that conversation
  via `client.genie.createMessage`.
- In both cases, after the create/start the driver polls
  `client.genie.getMessage` every `options.pollIntervalMs` (default
  500ms) until the message hits a terminal status
  (`COMPLETED` / `FAILED` / `CANCELLED`), then yields the terminal
  snapshot and returns.

Identical consecutive snapshots are filtered out (deep equal)
because Genie often returns the exact same payload twice during
quiet periods.

## `genieEventChat` - high-level typed events

Wraps `genieChat` and yields a `GenieChatEvent` discriminated union.
Stream order per turn:

1. `{ type: "message", message }` - the raw `GenieMessage`, once
   per poll yield.
2. `{ type: "question", content, message_id, ... }` - fires
   exactly once, on the first `message` yield. Carries the prompt
   text Genie echoed back and the assigned `message_id` so
   subscribers can group everything for one Genie call under that
   one key.
3. Any of `status` / `attachment` / `thinking` / `text` / `query` /
   `statement` / `rows` / `suggested_questions` the diff against
   the prior snapshot produced.
4. On the terminal snapshot, `{ type: "result", status, message }`
   as the final yield.

See [`@dbx-tools/genie-shared`](../genie-shared) for the full event
catalogue, field shapes, and the pure detectors that derive each
event from a snapshot diff.

Errors propagate by the generator throwing - there is no `error`
variant. Wrap the `for await` in `try / catch` if you need to handle
failures.

## Options

`GenieChatOptions` is the same shape for both drivers:

| Option            | Default                                    | Description                                                                                                          |
| ----------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `conversationId`  | `undefined`                                | Seed conversation id. When set, this turn appends to the existing conversation via `createMessage`.                  |
| `workspaceClient` | resolved (see below)                       | Explicit `WorkspaceClient`. Defaults to AppKit's per-request client when available; otherwise env-var auth.          |
| `pollIntervalMs`  | `500`                                      | Cadence between successive `getMessage` calls.                                                                       |
| `context`         | new internal `AbortController` per call    | External cancellation. Accepts an `AbortSignal` or a fully-built SDK `Context` (`apiUtils.ContextLike`).             |

### Workspace client resolution

Resolved in priority order:

1. Caller-supplied `options.workspaceClient`.
2. AppKit's per-request execution-context client, when
   `@databricks/appkit` is installed AND we're inside an active
   request scope. OBO auth is preserved automatically.
3. Fresh `new WorkspaceClient({})` (env-var auth via
   `DATABRICKS_CONFIG_PROFILE` / `DATABRICKS_HOST` /
   `DATABRICKS_TOKEN`).

AppKit is loaded lazily, so this package is usable from non-AppKit
environments (smoke scripts, batch jobs, tests, ...).

### Cancellation

A single internal `AbortController` covers each call. `options.context`
ties into that controller, so an external abort tears down every
in-flight SDK call AND the inter-poll sleep. Breaking out of the
`for await` does the same via the `try / finally`.

```ts
const ac = new AbortController();
setTimeout(() => ac.abort(), 30_000); // hard 30s ceiling

try {
  for await (const event of genieEventChat(spaceId, content, { context: ac.signal })) {
    handle(event);
  }
} catch (err) {
  if (ac.signal.aborted) console.log("timed out");
  else throw err;
}
```

## Smoke test

[`test/poll-chat.ts`](test/poll-chat.ts) drives `genieEventChat` from
argv / stdin / a REPL and writes every emitted event to a per-run tmp
directory so you can inspect deltas after the fact. One subdirectory
per `GenieChatEvent` variant, plus a `rows-data/` directory for paired
SQL fetches on terminals that carry a `query_result.statement_id`.

```bash
# Required env (already in repo .env):
#   DATABRICKS_GENIE_SPACE_ID
#   DATABRICKS_CONFIG_PROFILE   (or any SDK auth env)

bun packages/genie/test/poll-chat.ts                          # REPL
bun packages/genie/test/poll-chat.ts "Top 5 stores by revenue?"
echo "Top 5 stores by revenue?" | bun packages/genie/test/poll-chat.ts
```

Stdout carries a one-line summary per event with the relative path;
the per-run directory is printed at the top.

## License

Apache-2.0
