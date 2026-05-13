import { createAgent } from "@databricks/appkit/beta";

// Minimal analyst agent. The only tool comes from the dbx-tools plugin's
// `toolkit()`, which auto-wires one tool per Genie space configured on the
// `genie` plugin. With the default `.env`, that's a single `genie` tool
// wired to the default space; phase updates (`Submitted`, `Executing SQL`,
// `Completed`) flow over the tool-progress SSE channel and surface live in
// the <AgentChat> UI. The plugins map key matches the manifest name
// (`dbx-tools`), so we use bracket notation here.
//
// We pass the model name as a plain string and let AppKit construct the
// default `DatabricksAdapter`. The dbx-tools plugin installs a conditional
// monkey-patch on `DatabricksAdapter.prototype.run` during its `setup()`
// that disables the Python-style text-tool-call parser whenever any tool
// in the agent's toolset carries the `_dbxToolsSkipTextFallback` marker
// (which our toolkit entries do by default). Without the patch, Claude
// responses containing SQL (`SUM(...)`, `date_trunc(...)`) trip AppKit's
// text fallback and the agent loops up to `maxSteps` times, duplicating
// the answer and surfacing a long list of `Unknown tool: X` calls in the UI.

const INSTRUCTIONS = `You are a data analyst. The user will ask questions about
business metrics from a Databricks Genie space, and may also share personal
preferences you should remember across turns.

Tools available (some may not be wired in this deployment - that's fine):

- \`genie\`: send a natural-language question to Genie. The final
  \`message_result\` event holds the answer; \`query_result\` events identify
  the SQL.
- \`recall_memory\`: BEFORE answering a question where the user's prior
  preferences could change the answer (units, language, default markets,
  etc.), call this with a short query and use any returned memories.
- \`save_memory\`: when the user states a preference or durable fact about
  themselves ("I'm in EU so use EUR", "always show me the SQL"), store it
  so future turns can recall it.

Rules:

1. Quote numbers exactly. Never invent data.
2. If the user asks a non-data question, answer directly without calling
   \`genie\`.
3. When you save memory, briefly confirm what you stored ("Noted - I'll
   default to EUR for you").`;

export const analystAgent = createAgent({
  model: "databricks-claude-sonnet-4-6",
  maxTokens: 2048,
  instructions: INSTRUCTIONS,
  tools(plugins) {
    return {
      ...plugins["dbx-tools"].toolkit(),
    };
  },
});
