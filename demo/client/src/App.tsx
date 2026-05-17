import { useState } from "react";
import Chat from "@/pages/Chat";
import Stream from "@/pages/Stream";

type Page = "chat" | "stream";

const PAGES: { id: Page; label: string; description: string }[] = [
  {
    id: "chat",
    label: "Chat",
    description: "useChat against the chatRoute()",
  },
  {
    id: "stream",
    label: "Stream",
    description: "@mastra/client-js agent.stream()",
  },
];

const App = () => {
  const [page, setPage] = useState<Page>("chat");

  return (
    <div className="flex flex-col h-screen">
      <header className="border-b">
        <nav className="max-w-4xl mx-auto flex items-center gap-1 px-4 md:px-6 py-2">
          {PAGES.map((p) => {
            const active = p.id === page;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setPage(p.id)}
                title={p.description}
                className={
                  "px-3 py-1.5 rounded-md text-sm transition-colors " +
                  (active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted")
                }
              >
                {p.label}
              </button>
            );
          })}
        </nav>
      </header>
      <main className="flex-1 min-h-0">{page === "chat" ? <Chat /> : <Stream />}</main>
    </div>
  );
};

export default App;
