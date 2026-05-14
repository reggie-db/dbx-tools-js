# @dbx-tools/appkit-mastra-shared

Wire-format types shared between
[`@dbx-tools/appkit-mastra`](../appkit-mastra) (server plugin) and
[`@dbx-tools/appkit-mastra-ui`](../appkit-mastra-ui) (React components).

The protocol mirrors `@mastra/ai-sdk`'s `chatRoute()` (which is what
backs [ui-dojo.mastra.ai](https://ui-dojo.mastra.ai/)), so the AI SDK v5
`useChat()` hook on the client and `handleChatStream` on the server can
talk to each other with no custom payload manipulation.
