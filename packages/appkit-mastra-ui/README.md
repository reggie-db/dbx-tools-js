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

Peer dependencies: `react`, `react-dom`, `@databricks/appkit-ui`, and
`ai` (for the `UIMessage` type).

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
`--destructive`, `--warning`, ...) and inherit the host theme.

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
`clearHistory()`, `models()`, `suggestions()`, and `chart()` /
`statement()` over the plugin's own routes. `useMastraModels()` and
`useMastraSuggestions()` are thin hooks over the catalogue and Genie
starter questions.

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
