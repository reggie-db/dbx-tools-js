// Wire-format types shared between `@dbx-tools/appkit-mastra` (server)
// and `@dbx-tools/appkit-mastra-ui` (React). This package is pure types
// (plus a single zod schema): no Node-only imports, safe for browser
// bundles.
//
// The endpoint shape mirrors `@mastra/ai-sdk`'s `chatRoute()` (which is
// what backs https://ui-dojo.mastra.ai/) so the AI SDK v5 `useChat()`
// hook on the client and `handleChatStream` on the server can talk to
// each other without any custom payload manipulation. The only AppKit
// addition is the optional `memory` field, which Mastra threads through
// to its `Memory` module so the agent can remember the user across
// turns.

import { z } from "zod";
import type { UIMessage } from "ai";

/** Mastra memory addressing. `thread` is the conversation id; `resource`
 *  is the user / agent identity that scopes recall. Both are opaque
 *  strings the client owns. */
export interface MastraMemoryRef {
  thread: string;
  resource: string;
}

/** Body sent by the AI SDK v5 `useChat()` hook to the AppKit-Mastra
 *  `POST /chat` route. `messages`, `id`, and `trigger` come from
 *  `@ai-sdk/react`; `memory` is the only AppKit extension.
 *
 *  Server-side, the entire body is forwarded to
 *  `handleChatStream({ params })` from `@mastra/ai-sdk`, so anything
 *  else the underlying Mastra agent accepts (`maxSteps`, `toolChoice`,
 *  ...) can be passed through too. */
export interface MastraChatRequest {
  messages: UIMessage[];
  id?: string;
  trigger?: "submit-message" | "regenerate-message";
  memory?: MastraMemoryRef;
}

/** Zod schema for the request body. Use on the server to validate the
 *  client-supplied envelope before forwarding to `handleChatStream`. The
 *  `messages` array is intentionally `z.array(z.any())` because the AI
 *  SDK v5 UI message shape is large, well-validated downstream by Mastra
 *  itself, and changes between minor versions of `ai`. */
export const mastraChatRequestSchema = z.object({
  messages: z.array(z.any()),
  id: z.string().optional(),
  trigger: z.enum(["submit-message", "regenerate-message"]).optional(),
  memory: z
    .object({
      thread: z.string(),
      resource: z.string(),
    })
    .optional(),
});

/** Response shape of `GET /info` on the AppKit-Mastra plugin. */
export interface MastraInfoResponse {
  defaultAgent: string;
  servingEndpoint: string | null;
}
