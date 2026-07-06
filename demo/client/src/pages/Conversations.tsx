import { MastraChat } from "@dbx-tools/appkit-mastra-ui/react";

// Multi-conversation demo: MastraChat's built-in sidebar lists stored
// threads; selecting one switches the chat and re-hydrates its history.
// "New chat" creates a fresh thread. Thread management is on by default
// (`enableThreads`); this page highlights that flow vs the /stream page.

const Conversations = () => (
  <MastraChat showModelPicker className="h-full" />
);

export default Conversations;
