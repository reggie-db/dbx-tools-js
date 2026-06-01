import {
  BrowserRouter,
  NavLink,
  Navigate,
  Route,
  Routes,
} from "react-router-dom";
import Chat from "@/pages/Chat";
import Stream from "@/pages/Stream";

// Real browser routes so deep links (and refreshing on `/stream`) land
// on the right page. AppKit's dev and static servers already SPA-fallback
// any non-`/api`, non-`/query` path to index.html, so BrowserRouter is
// safe in both `bun run dev` and a deployed Databricks App.

type RouteDef = { path: string; label: string; description: string; element: React.ReactNode };

const ROUTES: RouteDef[] = [
  {
    path: "/chat",
    label: "Chat",
    description: "useChat against the chatRoute()",
    element: <Chat />,
  },
  {
    path: "/stream",
    label: "Stream",
    description: "@mastra/client-js agent.stream()",
    element: <Stream />,
  },
];

const App = () => {
  return (
    <BrowserRouter>
      <div className="flex flex-col h-screen">
        <header className="border-b">
          <nav className="max-w-4xl mx-auto flex items-center gap-1 px-4 md:px-6 py-2">
            {ROUTES.map((r) => (
              <NavLink
                key={r.path}
                to={r.path}
                title={r.description}
                className={({ isActive }) =>
                  "px-3 py-1.5 rounded-md text-sm transition-colors " +
                  (isActive
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted")
                }
              >
                {r.label}
              </NavLink>
            ))}
          </nav>
        </header>
        <main className="flex-1 min-h-0">
          <Routes>
            <Route path="/" element={<Navigate to="/chat" replace />} />
            {ROUTES.map((r) => (
              <Route key={r.path} path={r.path} element={r.element} />
            ))}
            <Route path="*" element={<Navigate to="/chat" replace />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
};

export default App;
