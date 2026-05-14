# @dbx-tools/appkit-mastra-ui

React `<MastraChat>` component for
[`@dbx-tools/appkit-mastra`](../mastra), backed by the AI SDK v5
`useChat()` hook and the
[AI Elements](https://github.com/mastra-ai/ui-dojo/tree/main/src/components/ai-elements)
components used in [ui-dojo.mastra.ai](https://ui-dojo.mastra.ai/).

```tsx
import { MastraChat } from "@dbx-tools/appkit-mastra-ui";

export default function App() {
  return (
    <MastraChat
      api="/api/mastra/chat"
      title="Analyst"
      description="Mastra agent backed by Lakebase memory and Databricks Model Serving."
      suggestions={["Show me last month's revenue", "I prefer EUR"]}
      memory={{ thread: myThreadId, resource: myResourceId }}
    />
  );
}
```

The component is a thin wrapper around `useChat` from `@ai-sdk/react`
with a `DefaultChatTransport` pointed at the mastra plugin's `POST /chat`
route. The route emits an AI SDK v5 UI Message Stream (via
`@mastra/ai-sdk`'s `handleChatStream`), so there is no custom payload
parsing on either side.

## Lower-level primitives

The vendored AI Elements components are also exported individually so
you can build your own chat surface:

```tsx
import {
  Conversation,
  ConversationContent,
  Message,
  MessageContent,
  PromptInputControl,
  Response,
} from "@dbx-tools/appkit-mastra-ui";
```
