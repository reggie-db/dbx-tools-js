import { useMemo } from "react";
import { MastraChat } from "@dbx-tools/appkit-mastra-ui";
import type { MastraMemoryRef } from "@dbx-tools/appkit-mastra-shared";

// Demo wiring for `@dbx-tools/appkit-mastra-ui`. The component does all
// the chat plumbing: AI SDK v5 `useChat` + `DefaultChatTransport` ->
// the AppKit-Mastra `POST /chat` route -> `handleChatStream` from
// `@mastra/ai-sdk` (same UI Message Stream wire protocol that backs
// https://ui-dojo.mastra.ai/).
//
// `MastraMemoryRef` is the only AppKit-specific addition. Pass a
// stable `{thread, resource}` pair via the `memory` prop and Mastra
// will recall prior turns from PostgresStore + PgVector across reloads.

const SUGGESTIONS = [
  "What can you help me with?",
  "Remember that I prefer numbers in EUR.",
  "Always show me the SQL behind your answers.",
];

export default function App() {
  // Stable ids per browser session so Mastra Memory can recall across
  // hot reloads. Cleared on a hard refresh (sessionStorage scope).
  const memory = useMemo<MastraMemoryRef>(
    () => ({
      thread: getOrCreate("appkit-mastra.threadId"),
      resource: getOrCreate("appkit-mastra.resourceId"),
    }),
    [],
  );

  return (
    <div className="flex min-h-screen w-full justify-center bg-background p-4">
      <div className="flex h-[calc(100vh-2rem)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border bg-card shadow-sm">
        <MastraChat
          api="/api/appkit-mastra/chat"
          memory={memory}
          title="appkit-mastra demo"
          description={
            <>
              Mastra agent backed by Lakebase memory and a Databricks Model
              Serving endpoint resolved via the AppKit{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">serving</code>{" "}
              plugin. Each request runs in user context via{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">asUser</code>.
            </>
          }
          suggestions={SUGGESTIONS}
        />
      </div>
    </div>
  );
}

function getOrCreate(key: string): string {
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const id = randomId();
  sessionStorage.setItem(key, id);
  return id;
}

/** UUID v4 with fallbacks for non-secure contexts. `crypto.randomUUID()`
 *  is only available on HTTPS or localhost; in dev we may be hitting
 *  the app via an LAN IP, so degrade gracefully via getRandomValues()
 *  and ultimately Math.random(). These are session identifiers, not
 *  secrets. */
function randomId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}
