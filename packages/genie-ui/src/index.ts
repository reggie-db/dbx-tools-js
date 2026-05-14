// Public entry point for `@dbx-tools/appkit-genie-ui`.

export { AgentChat, type AgentChatProps } from "./agent-chat.js";
export {
  AgentChatInput,
  type AgentChatInputProps,
} from "./agent-chat-input.js";
export {
  AgentChatMessage,
  type AgentChatMessageProps,
} from "./agent-chat-message.js";
export {
  AgentChatMessageList,
  type AgentChatMessageListProps,
} from "./agent-chat-message-list.js";
export { Markdown, type MarkdownProps } from "./markdown.js";
export { ToolCallCard, type ToolCallCardProps } from "./tool-call-card.js";
export {
  useAgentChat,
  type UseAgentChatOptions,
  type UseAgentChatResult,
} from "./use-agent-chat.js";
export {
  useToolProgress,
  type UseToolProgressOptions,
} from "./use-tool-progress.js";

// Wire-format types come from @dbx-tools/appkit-genie-shared. Re-export them
// so UI consumers do not have to install the shared package directly.
export type {
  ToolProgressEvent,
  ToolProgressPhase,
} from "@dbx-tools/appkit-genie-shared";

// UI-internal types exposed for advanced compositions.
export type { ChatTurn, ToolCall, ToolStatusUpdate } from "./types.js";
