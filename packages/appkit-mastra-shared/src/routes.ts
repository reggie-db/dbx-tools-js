/**
 * Route segments the Mastra plugin mounts under its `basePath`
 * (`/api/<plugin-name>`). Shared between the server's route
 * registration and the browser client (`MastraPluginClient` in
 * `@dbx-tools/appkit-mastra-ui`) so a relayout - or a rename of a
 * sub-path - is a one-line change here and the two can never drift.
 *
 * The agent-scoped segments (`history`, `threads`, `suggestions`) take
 * an optional `/:agentId` suffix; the default agent uses the bare
 * segment. Conversation streaming itself rides the standard Mastra
 * agent routes (`@mastra/client-js`'s `getAgent(id).stream()`), so
 * there's no chat segment here.
 *
 * `feedback` is the plugin-owned POST endpoint the chat UI calls to
 * log a thumbs / comment assessment against a turn's MLflow trace (see
 * `feedback.ts`); it is not agent-scoped (a trace id identifies the
 * turn on its own).
 */
export const MASTRA_ROUTES = {
  history: "/route/history",
  threads: "/route/threads",
  feedback: "/route/feedback",
  suggestions: "/suggestions",
  models: "/models",
  embed: "/embed",
} as const;
