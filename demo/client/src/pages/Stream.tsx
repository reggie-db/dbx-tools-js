import { MastraChat } from "@dbx-tools/appkit-mastra-ui/react";

// Drop-in demo: `MastraChat` drives the whole conversation over
// `@mastra/client-js` (streaming, tool-session pills, approvals, model
// picker, history pagination, and chat export) by wiring itself from the
// Mastra plugin's published client config - no host transport code.

const Stream = () => <MastraChat showModelPicker enableExport />;

export default Stream;
