import { MastraClient } from "@mastra/client-js";

// Mounted by the Mastra plugin at `/api/mastra`. The default `apiPrefix`
// in MastraClient is `/api`, so the resulting URL for a built-in route
// like agent stream becomes `/api/mastra/api/agents/{id}/stream`. The
// custom chatRoute (used by useChat in pages/Chat.tsx) lives at
// `/api/mastra/route/chat` and is not reached through this client.
export const mastraClient = new MastraClient({
  apiPrefix: "/api/mastra",
  baseUrl:
    (typeof window !== "undefined" ? window.location.origin : "http://localhost") ,
});

export const DEFAULT_AGENT_ID = "analyst";
