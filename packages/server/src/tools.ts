import { defineTool, type ToolEntry, type ToolRegistry } from "@databricks/appkit/beta";
import { z } from "zod";
import { buildMemoryToolRegistry } from "./memory.js";
import { describeGenieEvent, type ToolProgressBus } from "./progress-bus.js";
import type { GenieEventLike, GenieWiring, MemoryWiring } from "./types.js";

// Builds the `ToolRegistry` that the DbxTools plugin exposes through the
// AppKit `ToolProvider` interface (`getAgentTools`, `executeAgentTool`,
// `toolkit`). One entry per auto-wired Genie alias plus the memory
// subtree (when lakebase is wired), keyed by the tool name the agent sees.
// Keeping the registry build pure (no plugin state) makes it trivial to
// refresh whenever wirings change.

export interface ToolkitDeps {
  progress: ToolProgressBus;
  wirings: Map<string, GenieWiring>;
  memory?: MemoryWiring;
}

const _genieToolSchema = z.object({
  content: z
    .string()
    .describe("Natural-language question to send to the Genie space."),
  conversationId: z
    .string()
    .optional()
    .describe(
      "Optional Genie conversation id to continue an earlier Genie " +
        "thread within this chat. Omit on the first call.",
    ),
});

function _normalizeToolName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * Default tool name for a wired Genie alias. The well-known `default` alias
 * collapses to `genie`; everything else gets a `genie_` prefix so multiple
 * spaces stay disambiguated when an agent has more than one wired.
 */
export function defaultGenieToolName(alias: string): string {
  if (alias === "default") return "genie";
  return _normalizeToolName(`genie_${alias}`);
}

function _buildGenieToolEntry(
  deps: ToolkitDeps,
  toolName: string,
  wiring: GenieWiring,
): ToolEntry<typeof _genieToolSchema> {
  return defineTool({
    description:
      `Ask the Databricks Genie space "${wiring.alias}" a natural language ` +
      "question. The tool streams phase updates (Submitted, Executing SQL, " +
      "Fetching result, Completed) to the chat UI while it runs, then " +
      "returns the full Genie event log; the final `message_result` event " +
      "carries the assistant's natural-language answer and any " +
      "`query_result` events identify the underlying SQL statement.",
    schema: _genieToolSchema,
    annotations: { readOnly: true },
    execute: async ({ content, conversationId }) => {
      deps.progress.publish({
        tool: toolName,
        phase: "started",
        label: `Sending to Genie: "${content.slice(0, 80)}${
          content.length > 80 ? "..." : ""
        }"`,
      });

      const events: GenieEventLike[] = [];
      for await (const event of wiring.sendMessage(
        wiring.alias,
        content,
        conversationId,
      )) {
        events.push(event);
        const description = describeGenieEvent(event);
        if (description) {
          deps.progress.publish({
            tool: toolName,
            phase: description.phase,
            label: description.label,
            detail: description.detail,
          });
        }
      }
      return events;
    },
  });
}

/**
 * Build a fresh `ToolRegistry` reflecting the current set of wirings.
 * Called by the plugin every time wirings change (auto-wire at `setup()`,
 * any subsequent `wireGenie(...)` call, or memory rewire). Includes one
 * Genie tool per wired alias plus the memory subtree (when present).
 */
export function buildToolRegistry(deps: ToolkitDeps): ToolRegistry {
  const registry: ToolRegistry = {};
  for (const wiring of deps.wirings.values()) {
    const toolName = defaultGenieToolName(wiring.alias);
    registry[toolName] = _buildGenieToolEntry(deps, toolName, wiring);
  }
  if (deps.memory) {
    Object.assign(
      registry,
      buildMemoryToolRegistry({ progress: deps.progress, wiring: deps.memory }),
    );
  }
  return registry;
}
