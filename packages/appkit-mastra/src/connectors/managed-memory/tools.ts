/**
 * Ambient Mastra tools for Databricks Managed Agent Memory:
 * `save_memory` (persist a durable fact) and `search_memory` (look up
 * prior memories). Built only when managed memory is the active
 * long-term backend and merged into every agent's tool set by
 * `buildAgents`.
 *
 * Both tools resolve the OBO user scope from trusted request state via
 * {@link resolveMemoryContext} - the model passes only the content /
 * query, never the scope (honoring the Managed Memory security
 * guidance). On a stateless turn (no resolvable user) the tools no-op
 * with a clear message instead of writing cross-user data, and any REST
 * failure degrades to a short error string rather than aborting the
 * turn.
 */

import { commonUtils, logUtils, stringUtils } from "@dbx-tools/shared";
import type { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { search, writeEntry } from "./client.js";
import { resolveMemoryContext } from "./context.js";
import type { ManagedMemoryRuntime, MemoryEntry } from "./types.js";

const log = logUtils.logger("mastra/managed-memory/tools");

/** Mastra tool record shape (kept local to avoid an `agents.ts` cycle). */
type MastraTools = Record<string, ReturnType<typeof createTool>>;

const saveMemoryInput = z.object({
  content: z.string().describe("The durable fact or preference to remember."),
  summary: z
    .string()
    .optional()
    .describe("Optional one-line summary used to label the memory."),
});

const searchMemoryInput = z.object({
  query: z.string().describe("What to look up in the user's saved memories."),
});

/**
 * Build the `save_memory` / `search_memory` tool pair bound to a
 * resolved managed-memory runtime. The runtime supplies the store name,
 * recall size, and default entry path; the per-request client and scope
 * are resolved inside each `execute`.
 */
export function buildManagedMemoryTools(runtime: ManagedMemoryRuntime): MastraTools {
  return {
    save_memory: createTool({
      id: "save_memory",
      description: stringUtils.toDescription([
        `
          Save a durable fact or preference about the user to long-term
          memory so it can be recalled in future conversations. Use when
          the user states something worth remembering across sessions
          ("I'm in the EU, use EUR", "always show the SQL"). Pass the
          fact as \`content\` and an optional one-line \`summary\`.
        `,
        `
          The memory is automatically scoped to the current user - never
          include another person's data.
        `,
      ]),
      inputSchema: saveMemoryInput,
      execute: async (input, ctxRaw) => {
        const { content, summary } = input as z.infer<typeof saveMemoryInput>;
        const ctx = resolveMemoryContext(requestContextOf(ctxRaw));
        if (!ctx) return "Memory is not available for this conversation.";
        try {
          await writeEntry(ctx.client, runtime.storeName, ctx.scope, {
            path: runtime.entryPath,
            contents: content,
            ...(summary ? { description: summary } : {}),
          });
          log.debug("saved", { scope: ctx.scope });
          return "Saved to memory.";
        } catch (err) {
          log.warn("save:error", { error: commonUtils.errorMessage(err) });
          return "Could not save to memory right now.";
        }
      },
    }),
    search_memory: createTool({
      id: "search_memory",
      description: stringUtils.toDescription([
        `
          Search the user's long-term memory for relevant saved facts or
          preferences. Use before answering when prior context might
          help. Pass what you're looking for as \`query\`; returns the
          most relevant saved memories (scoped to the current user).
        `,
      ]),
      inputSchema: searchMemoryInput,
      execute: async (input, ctxRaw) => {
        const { query } = input as z.infer<typeof searchMemoryInput>;
        const ctx = resolveMemoryContext(requestContextOf(ctxRaw));
        if (!ctx) return { memories: [] as string[] };
        try {
          const entries = await search(
            ctx.client,
            runtime.storeName,
            ctx.scope,
            query,
            runtime.topK,
          );
          return { memories: entries.map(renderEntry) };
        } catch (err) {
          log.warn("search:error", { error: commonUtils.errorMessage(err) });
          return { memories: [] as string[] };
        }
      },
    }),
  };
}

/** Render an entry to a single recall line (summary prefix when present). */
export function renderEntry(entry: MemoryEntry): string {
  return entry.description ? `${entry.description}: ${entry.contents}` : entry.contents;
}

/** Pull the Mastra `RequestContext` out of a tool's execution context arg. */
function requestContextOf(ctxRaw: unknown): RequestContext | undefined {
  return (ctxRaw as { requestContext?: RequestContext } | undefined)?.requestContext;
}
