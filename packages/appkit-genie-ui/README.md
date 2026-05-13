# @dbx-tools/appkit-genie-ui

React UI for [`@dbx-tools/appkit-genie`](../appkit-genie). Drops in an `<AgentChat>` component that renders an agent's streaming response plus live tool-progress updates, styled to match [`@databricks/appkit-ui`](https://www.npmjs.com/package/@databricks/appkit-ui)'s `<GenieChat>` so the two can sit side by side.

This package has **no runtime dependency on the server plugin**. Shared wire-format types (`ToolProgressEvent`, `ToolProgressPhase`) come from [`@dbx-tools/appkit-genie-shared`](../appkit-genie-shared), so the UI can be bundled into a browser without dragging in Node-only AppKit code.

## Quick start

```tsx
import { AgentChat } from "@dbx-tools/appkit-genie-ui";
import "@databricks/appkit-ui/styles.css";

export function ChatPage() {
  return (
    <div className="h-[calc(100vh-7rem)] max-w-3xl mx-auto">
      <AgentChat agent="kpi-writer" />
    </div>
  );
}
```

With nothing else configured the component:

- POSTs each user turn to `/api/agents/chat` (the agents plugin's default endpoint).
- Subscribes to `/api/dbx-tools/tool-progress` (the server plugin's SSE channel) and threads phase labels under the matching tool-call card.
- Persists the agents-plugin thread id to `localStorage` under `dbx-tools.agent.<agent>.threadId` and silently re-establishes a fresh thread if the server's in-memory thread store has been cleared.

## Props

```ts
interface AgentChatProps {
  /** Required. Agent name registered with the agents plugin. */
  agent: string;
  /** Chat SSE endpoint. Default `"/api/agents/chat"`. */
  endpoint?: string;
  /**
   * Tool-progress SSE URL produced by @dbx-tools/appkit-genie. Default
   * `"/api/dbx-tools/tool-progress"`. Pass `false` to disable the side channel.
   */
  progressUrl?: string | false;
  /** localStorage key for the thread id. Default `"dbx-tools.agent.<agent>.threadId"`. */
  storageKey?: string;
  /** Placeholder shown in the input. Default `"Ask a question..."`. */
  placeholder?: string;
  /** Empty-state content shown before the first message. */
  welcome?: ReactNode;
  /** Additional CSS class for the root container. */
  className?: string;
}
```

## Building blocks

`<AgentChat>` is a thin composition. If you need a custom layout (sidebar, header, multi-agent switcher), import the pieces directly:

```ts
import {
  AgentChatInput,
  AgentChatMessage,
  AgentChatMessageList,
  ToolCallCard,
  useAgentChat,
  useToolProgress,
  type ChatTurn,
  type ToolProgressEvent,
} from "@dbx-tools/appkit-genie-ui";
```

`useAgentChat` and `useToolProgress` are the same hooks `<AgentChat>` uses internally. They cover thread persistence + stale-thread retry and the dbx-tools SSE channel respectively.

## Styling

The components use Tailwind utility classes from `@databricks/appkit-ui`'s design system. Import the stylesheet once in your app:

```ts
import "@databricks/appkit-ui/styles.css";
```

## Development

```bash
pnpm install
pnpm --filter @dbx-tools/appkit-genie-ui typecheck
```

## License

Apache-2.0
