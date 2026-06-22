# @dbx-tools/genie-shared

Pure types and sync helpers for `@dbx-tools/genie`. Wire-format zod
schemas (extending the generated `@dbx-tools/sdk-shared` Genie
shapes), the high-level `GenieChatEvent` discriminated union the
`genieEventChat` driver emits, and the per-event detectors that
derive those events from a `GenieMessage` snapshot diff.

No `node:*`, no `WorkspaceClient`, no I/O. Safe to import from any
runtime, including browser bundles.

```ts
import {
  // Wire schemas (extended over @dbx-tools/sdk-shared)
  GenieMessageSchema,
  GenieAttachmentSchema,
  GenieQueryAttachmentSchema,
  GenieThoughtSchema,
  // High-level event union
  GenieChatEventSchema,
  type GenieChatEvent,
  type GenieChatLocation,
  // Status helpers
  TERMINAL_STATUSES,
  isTerminalStatus,
  humanizeStatus,
  // Attachment discriminator
  detectAttachmentType,
  // Pure event detectors + orchestrator
  eventsFromMessage,
  detectStatus,
  detectThinking,
  detectText,
  detectQuery,
  detectStatement,
  detectRows,
  detectSuggestedQuestions,
  detectAttachmentAdded,
} from "@dbx-tools/genie-shared";
```

Server-side chat driving (`genieChat`, `genieEventChat`) lives in
`@dbx-tools/genie` and pulls these types in. Frontends only need this
package.

## Widened wire schemas

The SDK shapes from `@dbx-tools/sdk-shared` are re-exported with a
few fields Genie ships on the wire that the upstream `.d.ts` doesn't
currently type:

| Schema                       | Extension                                                                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GenieMessageSchema`         | Adds `auto_regenerate_count: number` and re-types `attachments` to the local `GenieAttachmentSchema`.                                                                                                              |
| `GenieAttachmentSchema`      | Re-types `query` to the thoughts-aware `GenieQueryAttachmentSchema`, adds `attachment_type` discriminator literal so consumers can `switch (att.attachment_type)` instead of probing which sub-object is populated. |
| `GenieQueryAttachmentSchema` | Adds `thoughts: GenieThought[]` (the streamed reasoning payload).                                                                                                                                                  |
| `GenieThoughtSchema`         | New: `{ thought_type, content }`. See [`GenieThoughtType`](#thought-types) for the known kinds.                                                                                                                    |

### Thought types

Open at the type level (`| (string & {})`) so a new server-side
thought type doesn't break compilation; the four known types still
narrow correctly under `switch`:

| `thought_type`                  | Content                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| `THOUGHT_TYPE_DESCRIPTION`      | One-paragraph restatement of what the user asked.                                      |
| `THOUGHT_TYPE_DATA_SOURCING`    | Markdown bullets of the fully-qualified `catalog.schema.table` sources Genie chose.    |
| `THOUGHT_TYPE_STEPS`            | High-level plan Genie wrote before running SQL (one bullet per step).                  |
| `THOUGHT_TYPE_UNDERSTANDING`    | Ambiguity / interpretation notes ("'revenue' could be gross, net, or recognized...").  |

### Attachment discriminator

Genie populates only one of `query` / `text` / `suggested_questions`
per attachment slot. `detectAttachmentType(att)` returns the matching
discriminator literal (honoring a pre-set `att.attachment_type`).

```ts
import { detectAttachmentType } from "@dbx-tools/genie-shared";

switch (detectAttachmentType(att)) {
  case "query":               // att.query is non-null
  case "text":                // att.text is non-null
  case "suggested_questions": // att.suggested_questions is non-null
}
```

## Terminal-status helpers

```ts
import { TERMINAL_STATUSES, isTerminalStatus, humanizeStatus } from "@dbx-tools/genie-shared";

TERMINAL_STATUSES; // ["COMPLETED", "FAILED", "CANCELLED"] as const

if (isTerminalStatus(msg.status)) {
  // msg.status is now TerminalStatus
}

humanizeStatus("EXECUTING_QUERY"); // "Running SQL query"
humanizeStatus("FUTURE_NEW_STATE"); // "Future new state" (falls back to tokenizer)
```

`humanizeStatus` is the single source of truth for status pill
labels. Both the server (via `@dbx-tools/genie`) and any UI that
subscribes to `status` events call it so labels stay in lock-step
across the wire.

## `GenieChatEvent` union

`genieEventChat` (in `@dbx-tools/genie`) drives a turn and yields a
stream of these. Each variant is a flat `{ type, ...fields }` object
with `type` as the discriminator and snake_case payload fields hoisted
to the top level - no `payload` wrapper.

| `type`                | Source                                                                                            | Notable fields                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `question`            | Lifecycle. Fires once per turn, on the first `message` yield.                                     | `content`, `message_id`, `conversation_id`, `space_id`                        |
| `message`             | Lifecycle. Fires once per poll yield.                                                             | `message: GenieMessage`                                                       |
| `status`              | Top-level `message.status` transitioned.                                                          | `status`, `previous_status`                                                   |
| `attachment`          | A new attachment slot appeared in `message.attachments[]`.                                        | `index`, `attachment_type`                                                    |
| `thinking`            | A new `(thought_type, content)` tuple on a query attachment (value-based dedupe).                 | `text`, `thought_type`                                                        |
| `text`                | Text-attachment `content` appeared or changed.                                                    | `text`                                                                        |
| `query`               | SQL was finalized on a query attachment (transitioned undefined -> string or rewrote).            | `sql`, `title?`, `description?`                                               |
| `statement`           | SQL submitted to a warehouse and a `statement_id` was assigned.                                   | `statement_id`                                                                |
| `rows`                | Row count on a query attachment changed (fires for `undefined -> 0` and `0 -> N`).                | `row_count`, `previous_row_count`, `statement_id`                             |
| `suggested_questions` | Follow-up suggested-questions array appeared or rewrote.                                          | `questions: string[]`                                                         |
| `result`              | Lifecycle. Fires once on the terminal snapshot.                                                   | `status: TerminalStatus`, `message: GenieMessage`                             |

Every variant carries a `GenieChatLocation` mixin (`space_id`,
`conversation_id?`, `message_id?`, `attachment_id?`) so subscribers
can route, log, or correlate without re-walking the message.

```ts
import { type GenieChatEvent } from "@dbx-tools/genie-shared";

function handleEvent(event: GenieChatEvent) {
  switch (event.type) {
    case "question":
      console.log(`[Q]`, event.content);
      break;
    case "thinking":
      console.log(`[think:${event.thought_type}]`, event.text);
      break;
    case "query":
      console.log(`[sql]`, event.title, "\n", event.sql);
      break;
    case "rows":
      console.log(`[rows]`, event.previous_row_count, "->", event.row_count);
      break;
    case "result":
      console.log(`[done]`, event.status);
      break;
  }
}
```

### Stream order per turn

1. `question` (deferred to the first `message` yield so the
   assigned `message_id` is present).
2. `message` for every poll yield (carries the raw snapshot on
   `event.message`).
3. Any derived events the snapshot diff produced (`status`,
   `attachment`, `thinking`, `text`, `query`, `statement`, `rows`,
   `suggested_questions`) in that fixed order.
4. On the terminal snapshot, a final `result` event.

Errors propagate via the generator throwing - there is no `error`
variant on the union. Wrap the `for await` in `try / catch` if you
need to handle failures.

## Detectors + `eventsFromMessage`

If you want to derive events from `GenieMessage` snapshots on the
client (e.g. replaying persisted history, or driving your own loop
that bypasses `genieEventChat`), use the pure detectors directly:

```ts
import {
  eventsFromMessage,
  detectStatus,
  detectText,
} from "@dbx-tools/genie-shared";

// All detectors, in stable wire order:
for (const event of eventsFromMessage(current, previous, spaceId)) {
  handleEvent(event);
}

// Or one detector at a time:
const statusEvent = detectStatus.detect(current, previous, spaceId);
const textEvent   = detectText.detect(currAttachment, prevAttachment, location, idx);
```

Each detector is built with `eventDetector(name, detect)` so the
event name (`"status"`) is a string literal that TS uses to look up
the diff signature (`message` vs `attachment`) and the allowed
return-fields shape (`DetectorResult<T>`). Mis-typing the event name
or returning the wrong fields fails to compile.

## License

Apache-2.0
