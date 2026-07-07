# @dbx-tools/appkit-mastra-ui

React chat UI for Mastra agents mounted through
[`@dbx-tools/appkit-mastra`](../appkit-mastra). Packaged the same way
`@databricks/appkit-ui` ships its Genie components: a `./react` subpath
for the components and hooks, a `./styles.css` entry for the stylesheet,
and brand-agnostic styling that themes itself from the host app's AppKit
semantic tokens.

## Install

```bash
npm install @dbx-tools/appkit-mastra-ui
```

Peer dependencies: `ai` (for the `UIMessage` type). React, React DOM, and
`@databricks/appkit-ui` are provided transitively via
[`@dbx-tools/appkit-ui`](../appkit-ui).

## Styles

Import the stylesheet once from your Tailwind entry, after Tailwind and
your AppKit-UI theme:

```css
@import "tailwindcss";
@import "@databricks/appkit-ui/styles.css";
@import "@dbx-tools/appkit-mastra-ui/styles.css";
```

The stylesheet defines no core design tokens; the components style with
AppKit semantic tokens (`--background`, `--primary`, `--success`,
`--destructive`, `--warning`, ...) and inherit the host theme. Shared
Streamdown / shiki styling comes from `@dbx-tools/appkit-ui`.

## Drop-in: `MastraChat`

The headline component. Mount it anywhere under the Mastra plugin and it
wires itself from the plugin's published client config (mount paths,
default agent). It drives the conversation directly over
`@mastra/client-js`, so it gets streaming, inline tool-session pills,
approval gating, a stop control, and history pagination out of the box.

```tsx
import { MastraChat } from "@dbx-tools/appkit-mastra-ui/react";

export default function ChatPage() {
  return <MastraChat />;
}
```

The model picker is **off by default** (the catalogue isn't even
fetched). Opt in with `showModelPicker` to let the user override the
serving endpoint per turn:

```tsx
<MastraChat showModelPicker />
```

### Conversation management

Conversation (thread) management is **on by default**. `MastraChat`
renders a sidebar listing the threads the signed-in user owns for this
agent, lets them switch between conversations, start a new one, rename
one (inline text field on hover; commit on Enter / blur, cancel on
Escape), and delete one - and persists the active thread id in
`localStorage` so a reload reopens the same conversation. A brand-new
conversation's row is titled from its first question instantly (a
truncated preview), so it never lingers as "New conversation" while the
server catches up. Each thread is then auto-titled from its opening turn
on the small / fast model tier (the plugin's `summarize` helper, not the
agent's primary model), so the list reads like a chat history rather than
a list of ids without spending the heavyweight model; that auto-title
supersedes the first-message preview, and a manual rename overrides
both.

A header toggle shows/hides the sidebar so the conversation view is
easily turned on and off in the UI; that show/hide choice is also
persisted to `localStorage`, so the chat reopens the way the user left
it. The feature stays active when the panel is hidden (threads keep
tracking) - the toggle only reclaims the width.

Under the hood the client picks a thread id (from the `/route/threads`
listing, or a freshly minted one for a new chat) and stamps it on every
call via the thread-selection header, so streaming, history, and clear
all target the selected conversation. The server scopes the listing to
the caller's resource, so a user only ever sees their own threads.

Turn the whole feature off for a classic single-thread chat (anchored to
the per-session cookie, no sidebar) with `enableThreads={false}`:

```tsx
<MastraChat enableThreads={false} />
```

### Export

Chat export is **opt-in** (off by default). Turn it on with
`enableExport`:

```tsx
<MastraChat enableExport />
```

With it on, an **Export** menu appears in the header (whole conversation)
and a per-message export menu appears on each assistant bubble. Both
offer two formats:

- **PDF** - opens a print-ready document in a new tab and triggers the
  browser's print dialog, so the user saves a real PDF ("Save as PDF").
  If a popup blocker stops the tab, the document is downloaded as an HTML
  file instead.
- **Markdown** - downloads a `.md` file.

Exports are **self-contained and include charts**: each `[chart:<id>]`
marker is resolved against the plugin's chart cache and rendered to an
inline SVG via Echarts' server-side renderer (so it renders offline with
no runtime), and `[data:<id>]` markers resolve to real tables (GFM tables
in Markdown). Expired / unknown embeds are skipped.

Human turns are labelled with the signed-in identity (e.g.
`User (someone@example.com)`), derived from the resource id the thread
list carries. The PDF is tuned for clean print output: messages and long
tables flow across page boundaries (tables repeat their header) instead
of being pushed whole onto a new page, and the browser's print
header/footer (the `about:blank` URL, date, and page numbers) is
suppressed.

The headless driver exposes `onExportConversation(format)` and
`onExportMessage(message, format)` on the `useMastraChat` prop bag when
`enableExport` is set; the underlying `exportChat(...)` helper and the
`ExportMenu` component are exported for custom wiring.

### Feedback (MLflow)

When the plugin has MLflow feedback enabled (see
[`@dbx-tools/appkit-mastra`](../appkit-mastra) - it publishes
`clientConfig().feedbackEnabled`), each assistant bubble gets thumbs
up / down controls and a comment popover. A rating / comment is logged
as a HUMAN assessment on that turn's MLflow trace, attributed to the
signed-in user.

Feedback **defaults to `enableExport`'s value** (rating a turn pairs
naturally with exporting it) and can be forced independently with
`enableFeedback`:

```tsx
<MastraChat enableFeedback />          {/* force on */}
<MastraChat enableExport enableFeedback={false} />  {/* export, no feedback */}
```

The controls only render for a turn once the client has captured that
turn's `tr-<hex>` trace id from the stream response, and only when the
server reports `feedbackEnabled` - so they degrade to nothing when
tracing is off. The headless driver exposes `feedbackByMessage` and
`onFeedback(message, submission)` on the `useMastraChat` prop bag when
feedback is available; `MastraPluginClient.feedback(...)` is the
underlying call.

### Starter suggestions

The empty state carries **no built-in example prompts**. When the agent
has a Genie space wired up, `MastraChat` auto-fills the starter
questions from that space's curated `sample_questions` (fetched from the
plugin's `/suggestions` endpoint); when it has no Genie space, the empty
state stays bare. Pass an explicit `suggestions` list to override that
lookup, or `[]` to force none:

```tsx
<MastraChat suggestions={["What were last quarter's top stores?"]} />
```

## Headless: `useMastraChat` + `ChatView`

`useMastraChat` is the headless driver behind `MastraChat`: it owns the
full conversation lifecycle (streaming over `@mastra/client-js`,
tool-event tracking, approvals, model selection, clear, and
infinite-scroll-up history) and returns the exact prop bag the
presentational `ChatView` consumes. Use it when you want the drop-in
behaviour but need to render the shell yourself:

```tsx
import { ChatView, useMastraChat } from "@dbx-tools/appkit-mastra-ui/react";

function Chat() {
  const chat = useMastraChat({ showModelPicker: true });
  return <ChatView {...chat} className="h-full" />;
}
```

For lower-level access, `useMastraClient()` returns a
`MastraPluginClient` (a `@mastra/client-js` `MastraClient` subclass)
that streams turns via `getAgent(id).stream()` and adds `history()` /
`clearHistory()`, `threads()` / `removeThread()` / `renameThread()` /
`setThreadId()`,
`models()`, `suggestions()`, `feedback()`, and `chart()` /
`statement()` over the plugin's own routes. `useMastraModels()`,
`useMastraSuggestions()`, and `useMastraThreads()` are thin hooks over
the catalogue, Genie starter questions, and the conversation list.

`ChatView` itself shows no suggestions unless you pass them (it has no
built-in defaults); `useMastraSuggestions()` resolves the agent's Genie
space starter questions, or an empty list when none are configured.

## Features

- Streaming markdown with GFM, KaTeX, and Mermaid (via Streamdown).
- Syntax-highlighted, copyable SQL blocks (shiki).
- Interactive result tables (sort, column show/hide, CSV export).
- Inline chart and data embed slots resolved from `[chart:<id>]` /
  `[data:<id>]` markers in the model's prose.
- Consolidated tool-session pills with per-call Genie progress detail.
- Suggested follow-up question pills.
- Starter-question prompts on the empty state, auto-sourced from the
  agent's Genie space `sample_questions` (or a caller-supplied list);
  nothing shown when neither is available.
- Inline approval cards for `requireApproval` tools.
- Stop button to abort an in-flight response (Send is disabled while
  streaming; `ChatView` takes an `onStop` callback).
- Destructive error Alert with a Retry action when a turn fails
  (`ChatView` takes an `error` prop; the drop-in surfaces it itself).
- Optional model picker (`showModelPicker`, off by default).
- Infinite-scroll-up thread history.
- Built-in conversation management (on by default): a sidebar of the
  user's auto-titled threads (titled on the small / fast model tier) with
  select / new / delete, persisted across reloads, plus a persisted
  show/hide toggle; opt out with `enableThreads={false}`.
- Chat export (opt-in via `enableExport`): whole-conversation and
  per-message export to PDF (browser print) or Markdown, with charts
  (inline SVG) and data tables inlined so the export is self-contained.
- Per-turn MLflow feedback (thumbs + comment) when the plugin enables it;
  defaults to `enableExport`, overridable with `enableFeedback`.
