import { AgentChat } from "@reggie-db/dbx-tools-appkit-ui";

// Minimal embed of <AgentChat>. The component handles:
//
// - POSTing turns to /api/agents/chat (default agents-plugin endpoint).
// - Streaming assistant text and tool-call deltas via SSE.
// - Subscribing to /api/dbx-tools/tool-progress and threading phase labels
//   (e.g. "Executing SQL") under the matching tool-call card.
// - Persisting the agents-plugin thread id to localStorage so the
//   conversation survives page reloads.

export default function App() {
  return (
    <div className="flex min-h-screen w-full justify-center bg-background p-4">
      <div className="flex h-[calc(100vh-2rem)] w-full max-w-3xl flex-col gap-4">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            dbx-tools demo
          </h1>
          <p className="text-sm text-muted-foreground">
            AgentChat wired to a Databricks Genie space via{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              appkit-plugin-dbx-tools
            </code>
            . Tool progress streams live underneath each tool-call card.
          </p>
        </header>

        <div className="flex-1 min-h-0 overflow-hidden rounded-xl border bg-card shadow-sm">
          <AgentChat
            agent="analyst"
            placeholder="Ask about a metric in your Genie space..."
            welcome={
              <div className="space-y-2">
                <p className="text-base font-medium">Try asking:</p>
                <ul className="space-y-1 text-sm text-muted-foreground">
                  <li>What were sales last week?</li>
                  <li>Which stores had the biggest YoY change?</li>
                  <li>Break down revenue by category for the last 4 weeks.</li>
                </ul>
              </div>
            }
          />
        </div>
      </div>
    </div>
  );
}
