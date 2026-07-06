import { ConversationShell } from "@dbx-tools/appkit-mastra-ui/react";

// Multi-conversation demo: a sidebar lists all stored threads for the
// current user; clicking one switches the chat to that conversation and
// re-hydrates its history. "New chat" creates a fresh thread.

const Conversations = () => (
  <ConversationShell showModelPicker className="h-full" />
);

export default Conversations;
