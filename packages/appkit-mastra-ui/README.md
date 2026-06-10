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
approval gating, model selection, and history pagination out of the box.

```tsx
import { MastraChat } from "@dbx-tools/appkit-mastra-ui/react";

export default function ChatPage() {
  return <MastraChat />;
}
```

## Controlled: `ChatView`

For full control over message state and transport, render the
presentational `ChatView` and feed it your own `messages` / `status` /
`sendMessage`. This is what powers `MastraChat` internally and pairs
naturally with the AI SDK's `useChat`:

```tsx
import { ChatView, useChatUrl, useMastraModels } from "@dbx-tools/appkit-mastra-ui/react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";

function Chat() {
  const api = useChatUrl();
  const { models } = useMastraModels();
  const { messages, status, sendMessage, regenerate } = useChat({
    transport: new DefaultChatTransport({ api }),
  });
  return (
    <ChatView
      messages={messages}
      status={status}
      sendMessage={sendMessage}
      regenerate={regenerate}
      models={models}
    />
  );
}
```

## Features

- Streaming markdown with GFM, KaTeX, and Mermaid (via Streamdown).
- Syntax-highlighted, copyable SQL blocks (shiki).
- Interactive result tables (sort, column show/hide, CSV export).
- Inline chart and data embed slots resolved from `[chart:<id>]` /
  `[data:<id>]` markers in the model's prose.
- Consolidated tool-session pills with per-call Genie progress detail.
- Suggested follow-up question pills.
- Inline approval cards for `requireApproval` tools.
- Infinite-scroll-up thread history.
