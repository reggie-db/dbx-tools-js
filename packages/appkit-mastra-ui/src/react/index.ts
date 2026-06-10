// Public surface of @dbx-tools/appkit-mastra-ui/react.
//
// - `MastraChat` / `useMastraChat`: the self-contained drop-in (and its
//   headless driver) that wire themselves from the Mastra plugin config.
// - `ChatView`: the controlled, presentational shell for callers that
//   own message state and transport themselves.
// - The Mastra client hooks the controlled path needs (chat URL, model
//   catalogue, history paging, embed fetches).
//
// Internal building blocks (bubbles, tool pills, markdown, data grid,
// embed slots, suggestions) are intentionally not re-exported.

export { ChatView } from "./chat-view.js";
export { MastraChat, useMastraChat } from "./mastra-chat.js";
export type { MastraChatProps, UseMastraChatOptions } from "./mastra-chat.js";
export type {
  ApprovalDecision,
  ChatModelOption,
  ChatStatus,
  ChatViewProps,
  PendingApproval,
  ToolEvent,
  ToolProgress,
} from "./types.js";
export {
  clearMastraHistory,
  fetchMastraHistory,
  useChartFetch,
  useChatUrl,
  useMastraClient,
  useMastraConfig,
  useMastraModels,
  useStatementFetch,
} from "../lib/mastra-client.js";
export type { ByIdFetchState, MastraHistoryPage } from "../lib/mastra-client.js";
