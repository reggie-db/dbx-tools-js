/**
 * Conversation-thread listing exposed as a Mastra custom API route.
 *
 * Backed entirely by native Mastra: looks up the active agent by id,
 * asks its `Memory` instance to `listThreads` filtered to the caller's
 * resource, and shapes each into the JSON-safe {@link MastraThread}
 * wire type. A sibling `DELETE` removes a single named thread.
 *
 * A sibling `DELETE` removes a single named thread; a `PATCH` renames
 * one ({@link renameThread}).
 *
 * Like {@link historyRoute} this registers through Mastra's
 * `registerApiRoute` so it shares the `MastraServer` auth-middleware
 * pipeline (in `./server.ts`), which has already stamped the resource
 * id (`MASTRA_RESOURCE_ID_KEY`) and the targeted thread id
 * (`MASTRA_THREAD_ID_KEY`, resolved from the thread-selection header /
 * cookie) on `RequestContext` by the time a handler runs. Resource
 * scoping lives here so a caller can only ever see, rename, or delete
 * its own threads; no cookie or user lookups happen in this module.
 */

import {
  MastraUpdateThreadRequestSchema,
  type MastraDeleteThreadResponse,
  type MastraThread,
  type MastraThreadsResponse,
  type MastraUpdateThreadResponse,
} from "@dbx-tools/appkit-mastra-shared";
import { logUtils } from "@dbx-tools/shared";
import type { Agent } from "@mastra/core/agent";
import type { StorageThreadType } from "@mastra/core/memory";
import {
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_THREAD_ID_KEY,
} from "@mastra/core/request-context";
import type { ContextWithMastra } from "@mastra/core/server";
import { registerApiRoute } from "@mastra/core/server";

import { clampPerPage, parseIntParam } from "./pagination.js";

const log = logUtils.logger("mastra/threads");

/** Default threads page size. */
const DEFAULT_PER_PAGE = 30;
/** Hard cap so a misbehaving client can't fetch every thread at once. */
const MAX_PER_PAGE = 200;

/** Inputs accepted by {@link listThreads}. */
export interface ListThreadsOptions {
  agent: Agent;
  resourceId: string;
  page?: number;
  perPage?: number;
}

/**
 * Fetch a page of the resource's conversation threads, newest
 * (`updatedAt` DESC) first.
 *
 * Uses the agent's resolved `Memory` (`getMemory()`) so the per-agent
 * storage namespace (`mastra_<agentId>` schema) applies automatically.
 * When the agent has no memory configured the response is a successful
 * empty page so callers don't have to special-case stateless agents.
 */
export async function listThreads(
  opts: ListThreadsOptions,
): Promise<MastraThreadsResponse> {
  const perPage = clampPerPage(opts.perPage, {
    fallback: DEFAULT_PER_PAGE,
    max: MAX_PER_PAGE,
  });
  const page = Math.max(0, Math.trunc(opts.page ?? 0));
  const memory = await opts.agent.getMemory();
  if (!memory) {
    log.debug("list:no-memory", { agentId: opts.agent.id });
    return { threads: [], page, perPage, total: 0, hasMore: false };
  }
  const startedAt = Date.now();
  const result = await memory.listThreads({
    filter: { resourceId: opts.resourceId },
    page,
    perPage,
    orderBy: { field: "updatedAt", direction: "DESC" },
  });
  const threads = result.threads.map(toWireThread);
  log.debug("list:done", {
    agentId: opts.agent.id,
    resourceId: opts.resourceId,
    page,
    perPage,
    returned: threads.length,
    total: result.total,
    hasMore: result.hasMore,
    elapsedMs: Date.now() - startedAt,
  });
  return {
    threads,
    page,
    perPage,
    total: result.total,
    hasMore: result.hasMore,
  };
}

/** Inputs accepted by {@link deleteThread}. */
export interface DeleteThreadOptions {
  agent: Agent;
  threadId: string;
  resourceId: string;
}

/**
 * Delete a single named thread (and every message on it).
 *
 * Ownership is enforced: the thread is only removed when it belongs to
 * the calling resource, so a client can't delete another user's
 * conversation by guessing its id. A thread that doesn't exist (or
 * isn't owned by the caller) is a successful no-op (`deleted: false`)
 * so the UI can fire-and-forget.
 */
export async function deleteThread(
  opts: DeleteThreadOptions,
): Promise<{ deleted: boolean }> {
  const memory = await opts.agent.getMemory();
  if (!memory) {
    log.debug("delete:no-memory", { agentId: opts.agent.id });
    return { deleted: false };
  }
  // Confirm the thread exists and is owned by the caller before
  // deleting; never let a guessed id touch another resource's data.
  const existing = await memory.getThreadById({ threadId: opts.threadId });
  if (!existing || existing.resourceId !== opts.resourceId) {
    log.debug("delete:not-owned", {
      agentId: opts.agent.id,
      threadId: opts.threadId,
      found: existing !== null,
    });
    return { deleted: false };
  }
  const startedAt = Date.now();
  await memory.deleteThread(opts.threadId);
  log.info("delete:done", {
    agentId: opts.agent.id,
    threadId: opts.threadId,
    elapsedMs: Date.now() - startedAt,
  });
  return { deleted: true };
}

/** Inputs accepted by {@link renameThread}. */
export interface RenameThreadOptions {
  agent: Agent;
  threadId: string;
  resourceId: string;
  title: string;
}

/**
 * Rename a single thread, returning the updated wire thread.
 *
 * Ownership is enforced the same way {@link deleteThread} enforces it:
 * the title is only changed when the thread belongs to the calling
 * resource, so a client can't rename another user's conversation by
 * guessing its id. Existing thread `metadata` is preserved untouched
 * (Mastra's `updateThread` replaces the row, so it must be passed back
 * in). Returns `null` when the thread doesn't exist, isn't owned by the
 * caller, or the agent has no memory configured, letting the route map
 * that to a 404.
 */
export async function renameThread(
  opts: RenameThreadOptions,
): Promise<MastraThread | null> {
  const memory = await opts.agent.getMemory();
  if (!memory) {
    log.debug("rename:no-memory", { agentId: opts.agent.id });
    return null;
  }
  const existing = await memory.getThreadById({ threadId: opts.threadId });
  if (!existing || existing.resourceId !== opts.resourceId) {
    log.debug("rename:not-owned", {
      agentId: opts.agent.id,
      threadId: opts.threadId,
      found: existing !== null,
    });
    return null;
  }
  const startedAt = Date.now();
  const updated = await memory.updateThread({
    id: opts.threadId,
    title: opts.title,
    metadata: existing.metadata ?? {},
  });
  log.info("rename:done", {
    agentId: opts.agent.id,
    threadId: opts.threadId,
    elapsedMs: Date.now() - startedAt,
  });
  return toWireThread(updated);
}

/** Options accepted by {@link threadsRoute}. */
export type ThreadsRouteOptions =
  | { path: `${string}:agentId${string}`; agent?: never }
  | { path: string; agent: string };

/**
 * Register the `<path>` Mastra custom API route. Handles three methods
 * on the same mount:
 *
 *   - `GET`: a page of the resource's conversation threads
 *     ({@link listThreads}).
 *   - `DELETE`: remove the thread named by the thread-selection header
 *     / `?threadId=` query ({@link deleteThread}). The id is read from
 *     `RequestContext` (the auth middleware resolves it the same way it
 *     does for streaming and history), so the client deletes any of its
 *     threads by stamping the target id - no separate path param.
 *   - `PATCH`: rename the thread named by the thread-selection header /
 *     `?threadId=` query to the `{ title }` in the JSON body
 *     ({@link renameThread}). Targets a thread the same way `DELETE`
 *     does; 404s when the thread isn't owned by the caller.
 *
 * Follows the `@mastra/ai-sdk` agent-binding convention: pass `agent`
 * for a fixed-agent mount, or include `:agentId` in the path for
 * dynamic routing. The plugin registers both `/route/threads` (default
 * agent) and `/route/threads/:agentId`.
 */
export function threadsRoute(options: ThreadsRouteOptions) {
  const { path } = options;
  const fixedAgent = "agent" in options ? options.agent : undefined;
  if (!fixedAgent && !path.includes(":agentId")) {
    throw new Error(
      "threadsRoute path must include `:agentId` or `agent` must be passed explicitly",
    );
  }
  // Shared by GET / DELETE: resolve the active agent and the caller's
  // resource id, returning a JSON error response when either is
  // missing. Keeps both handlers thin with identical validation.
  const resolveContext = (c: ContextWithMastra) => {
    const mastra = c.get("mastra");
    const requestContext = c.get("requestContext");
    const agentId = fixedAgent ?? c.req.param("agentId");
    if (!agentId) {
      return { error: c.json({ error: "agentId is required" }, 400) } as const;
    }
    const agent = mastra.getAgentById(agentId);
    if (!agent) {
      return {
        error: c.json({ error: `Unknown agent "${agentId}"` }, 404),
      } as const;
    }
    const resourceId = requestContext.get(MASTRA_RESOURCE_ID_KEY) as string | undefined;
    if (!resourceId) {
      return {
        error: c.json({ error: "resource id missing from request context" }, 400),
      } as const;
    }
    return { agentId, agent, requestContext, resourceId } as const;
  };

  return [
    registerApiRoute(path, {
      method: "GET",
      handler: async (c: ContextWithMastra) => {
        const ctx = resolveContext(c);
        if ("error" in ctx) return ctx.error;
        const payload = await listThreads({
          agent: ctx.agent,
          resourceId: ctx.resourceId,
          page: parseIntParam(c.req.query("page")),
          perPage: parseIntParam(c.req.query("perPage")),
        });
        return c.json(payload);
      },
    }),
    registerApiRoute(path, {
      method: "DELETE",
      handler: async (c: ContextWithMastra) => {
        const ctx = resolveContext(c);
        if ("error" in ctx) return ctx.error;
        const threadId = ctx.requestContext.get(MASTRA_THREAD_ID_KEY) as
          | string
          | undefined;
        if (!threadId) {
          return c.json({ error: "thread id missing from request context" }, 400);
        }
        const { deleted } = await deleteThread({
          agent: ctx.agent,
          threadId,
          resourceId: ctx.resourceId,
        });
        const payload: MastraDeleteThreadResponse = {
          ok: true,
          agentId: ctx.agentId,
          threadId,
          deleted,
        };
        return c.json(payload);
      },
    }),
    registerApiRoute(path, {
      method: "PATCH",
      handler: async (c: ContextWithMastra) => {
        const ctx = resolveContext(c);
        if ("error" in ctx) return ctx.error;
        const threadId = ctx.requestContext.get(MASTRA_THREAD_ID_KEY) as
          | string
          | undefined;
        if (!threadId) {
          return c.json({ error: "thread id missing from request context" }, 400);
        }
        const body = MastraUpdateThreadRequestSchema.safeParse(await c.req.json());
        if (!body.success) {
          return c.json({ error: body.error.message }, 400);
        }
        const thread = await renameThread({
          agent: ctx.agent,
          threadId,
          resourceId: ctx.resourceId,
          title: body.data.title,
        });
        if (!thread) {
          return c.json({ error: `Unknown thread "${threadId}"` }, 404);
        }
        const payload: MastraUpdateThreadResponse = {
          ok: true,
          agentId: ctx.agentId,
          thread,
        };
        return c.json(payload);
      },
    }),
  ];
}

/** Coerce a Mastra `StorageThreadType` into the JSON-safe wire shape. */
function toWireThread(thread: StorageThreadType): MastraThread {
  return {
    id: thread.id,
    ...(thread.title ? { title: thread.title } : {}),
    resourceId: thread.resourceId,
    createdAt: toIso(thread.createdAt),
    updatedAt: toIso(thread.updatedAt),
    ...(thread.metadata ? { metadata: thread.metadata } : {}),
  };
}

/** Render a storage timestamp as an ISO-8601 string for the wire. */
function toIso(value: Date | string | number): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? new Date(0).toISOString()
    : parsed.toISOString();
}
