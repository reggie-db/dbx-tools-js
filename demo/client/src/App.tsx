import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { Button, Separator } from "@databricks/appkit-ui/react";
import Chat from "@/pages/Chat";
import Stream from "@/pages/Stream";

// Real browser routes so deep links (and refreshing on `/stream`) land
// on the right page. AppKit's dev and static servers already SPA-fallback
// any non-`/api`, non-`/query` path to index.html, so BrowserRouter is
// safe in both `bun run dev` and a deployed Databricks App.

type RouteDef = {
  path: string;
  label: string;
  description: string;
  element: React.ReactNode;
};

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

const Nav = () => {
  const { pathname } = useLocation();
  return (
    <nav className="max-w-4xl mx-auto flex items-center gap-1 px-4 md:px-6 py-2">
      {ROUTES.map((r) => (
        <Button
          key={r.path}
          asChild
          size="sm"
          variant={pathname === r.path ? "default" : "ghost"}
        >
          <Link to={r.path} title={r.description}>
            {r.label}
          </Link>
        </Button>
      ))}
    </nav>
  );
};

const App = () => (
  <BrowserRouter>
    <div className="flex flex-col h-screen">
      <header>
        <Nav />
        <Separator />
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

export default App;
