import { MastraChat } from "@dbx-tools/appkit-mastra-ui/react";

// Drop-in demo: `MastraChat` drives the whole conversation over
// `@mastra/client-js` (streaming, tool-session pills, approvals, model
// picker, and history pagination) by wiring itself from the Mastra
// plugin's published client config. Contrast with pages/Chat.tsx, which
// owns message state via the AI SDK's `useChat` and feeds the
// controlled `ChatView`.

const Stream = () => <MastraChat />;

export default Stream;
