// Public entry point for `@dbx-tools/appkit-mastra-ui`.

export { MastraChat, type MastraChatProps } from "./mastra-chat.js";

// Lower-level AI Elements primitives, re-exported so callers can build
// their own chat surface without re-vendoring the registry.
export {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
  type ConversationProps,
  type ConversationContentProps,
  type ConversationEmptyStateProps,
  type ConversationScrollButtonProps,
} from "./ai-elements/conversation.js";
export {
  Message,
  MessageContent,
  type MessageProps,
  type MessageContentProps,
} from "./ai-elements/message.js";
export { Response } from "./ai-elements/response.js";
export { Loader, type LoaderProps } from "./ai-elements/loader.js";
export {
  PromptInput,
  PromptInputControl,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputToolbar,
  type PromptInputProps,
  type PromptInputControlProps,
  type PromptInputSubmitProps,
  type PromptInputTextareaProps,
  type PromptInputToolbarProps,
} from "./ai-elements/prompt-input.js";
export {
  Suggestion,
  Suggestions,
  type SuggestionProps,
  type SuggestionsProps,
} from "./ai-elements/suggestion.js";

// Shared shadcn-style primitives the AI Elements depend on. Exposed so
// host apps can match the look-and-feel without duplicating cva config.
export { Button, buttonVariants, type ButtonProps } from "./components/button.js";
export { cn } from "./lib/utils.js";

// Wire-format types come from @dbx-tools/appkit-mastra-shared. Re-export
// them so UI consumers don't have to install the shared package directly.
export type {
  MastraChatRequest,
  MastraInfoResponse,
  MastraMemoryRef,
} from "@dbx-tools/appkit-mastra-shared";
