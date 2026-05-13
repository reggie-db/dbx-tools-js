import { defineTool, type ToolEntry, type ToolRegistry } from "@databricks/appkit/beta";
import { z } from "zod";
import type { ToolProgressBus } from "./progress-bus.js";
import type { MemoryWiring } from "./types.js";

// Agent tools backed by a mem0 `Memory` instance. Two operations are
// exposed: `save_memory` writes a new memory (mem0 may dedup or skip if
// the content overlaps existing ones), and `recall_memory` runs a
// semantic search scoped to the current user. Both publish progress
// events to the in-process bus so the UI can show "Storing memory..."
// and "Searching memories..." while the underlying vector / LLM calls
// run.

const _saveMemorySchema = z.object({
  content: z
    .string()
    .describe(
      "The text to remember. Be specific - mem0's extractor turns this " +
        "into one or more long-term memory entries scoped to the current " +
        "user. Good: 'User prefers dark mode and dislikes auto-playing " +
        "video.' Bad: 'remember this'.",
    ),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Optional key-value tags stored alongside the memory (e.g. " +
        '`{"topic":"preferences"}`). Used as additional filters by ' +
        "`recall_memory`.",
    ),
});

const _recallMemorySchema = z.object({
  query: z
    .string()
    .describe(
      "Natural-language description of what to recall. Returns the " +
        "top-N most semantically similar memories for the current user.",
    ),
  topK: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe(
      "How many memories to return. Default: 5. Max: 50. Use a small " +
        "number unless you need to scan widely.",
    ),
});

export interface MemoryToolkitDeps {
  progress: ToolProgressBus;
  wiring: MemoryWiring;
}

function _truncate(s: string, max = 80): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function _buildSaveMemoryEntry(
  deps: MemoryToolkitDeps,
): ToolEntry<typeof _saveMemorySchema> {
  return defineTool({
    description:
      "Store a long-term memory for the current user. Use this whenever the " +
      "user states a preference, fact about themselves, or context that " +
      "should persist across conversations. mem0's extractor decides " +
      "internally whether the content represents new information; calling " +
      "this for a duplicate is safe (it'll be deduped).",
    schema: _saveMemorySchema,
    annotations: { readOnly: false },
    execute: async ({ content, metadata }) => {
      const userId = deps.wiring.resolveUser() ?? "default";
      deps.progress.publish({
        tool: "save_memory",
        phase: "started",
        label: `Storing memory: "${_truncate(content)}"`,
      });
      try {
        // Resolve the Memory instance lazily; it's constructed in the
        // plugin's `setup:complete` handler, after the lakebase pool
        // exists. Throws if memory isn't ready, which shouldn't happen
        // for HTTP-triggered tool calls (those run after setup:complete).
        const memory = deps.wiring.getMemory();
        const result = await memory.add(content, {
          userId,
          metadata,
        });
        deps.progress.publish({
          tool: "save_memory",
          phase: "completed",
          label: `Stored ${result.results.length} memory entr${
            result.results.length === 1 ? "y" : "ies"
          }`,
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.progress.publish({
          tool: "save_memory",
          phase: "error",
          label: `save_memory failed: ${message}`,
        });
        throw error;
      }
    },
  });
}

function _buildRecallMemoryEntry(
  deps: MemoryToolkitDeps,
): ToolEntry<typeof _recallMemorySchema> {
  return defineTool({
    description:
      "Search the current user's long-term memories for context related to " +
      "the query. Returns an array of `{id, memory, score, metadata}` " +
      "objects, ordered by similarity. Call this BEFORE answering questions " +
      "where prior user preferences or facts could change the answer.",
    schema: _recallMemorySchema,
    annotations: { readOnly: true },
    execute: async ({ query, topK }) => {
      const userId = deps.wiring.resolveUser() ?? "default";
      deps.progress.publish({
        tool: "recall_memory",
        phase: "started",
        label: `Searching memories: "${_truncate(query)}"`,
      });
      try {
        // Note the API asymmetry: `add()` takes `userId` at top level
        // (per the `Entity` interface) while `search()` requires the
        // user id inside `filters.user_id` and rejects top-level entity
        // params via `rejectTopLevelEntityParams`. mem0's TS docs are
        // wrong here - the d.ts and runtime both gate on `filters`.
        const memory = deps.wiring.getMemory();
        const result = await memory.search(query, {
          topK,
          filters: { user_id: userId },
        });
        deps.progress.publish({
          tool: "recall_memory",
          phase: "completed",
          label: `Found ${result.results.length} matching memor${
            result.results.length === 1 ? "y" : "ies"
          }`,
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.progress.publish({
          tool: "recall_memory",
          phase: "error",
          label: `recall_memory failed: ${message}`,
        });
        throw error;
      }
    },
  });
}

/**
 * Build the memory subtree of the dbx-tools registry. Emits both
 * `save_memory` and `recall_memory` keyed at the top level (no
 * namespace prefix) so agents see them as plain tool names alongside
 * any wired Genie tools.
 */
export function buildMemoryToolRegistry(deps: MemoryToolkitDeps): ToolRegistry {
  return {
    save_memory: _buildSaveMemoryEntry(deps),
    recall_memory: _buildRecallMemoryEntry(deps),
  };
}
