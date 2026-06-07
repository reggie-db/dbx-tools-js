/**
 * Thread history loader exposed as a Mastra custom API route.
 *
 * Backed entirely by native Mastra: looks up the active agent by id,
 * asks its `Memory` instance to `recall` a page of `MastraDBMessage`s,
 * and converts the result to AI SDK V5 `UIMessage`s with the official
 * {@link toAISdkV5Messages} helper from `@mastra/ai-sdk/ui`. No direct
 * database reads.
 *
 * The route is registered through {@link historyRoute} as a Mastra
 * `registerApiRoute` so it sits in the same dispatcher pipeline as
 * `chatRoute`. That means the `MastraServer` auth middleware (in
 * `./server.ts`) has already populated `RequestContext` with
 * `MASTRA_THREAD_ID_KEY` and `MASTRA_RESOURCE_ID_KEY` by the time
 * the handler runs - no cookie or user lookups happen here, and the
 * session-cookie logic stays the single source of truth in `server.ts`.
 */

import { logUtils } from "@dbx-tools/shared";
import { toAISdkV5Messages } from "@mastra/ai-sdk/ui";
import type { Agent } from "@mastra/core/agent";
import type { MastraDBMessage } from "@mastra/core/agent/message-list";
import {
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_THREAD_ID_KEY,
} from "@mastra/core/request-context";
import { registerApiRoute } from "@mastra/core/server";
import type { ContextWithMastra } from "@mastra/core/server";
import type {
  MastraClearHistoryResponse,
  MastraHistoryResponse,
  MastraHistoryUIMessage,
} from "@dbx-tools/appkit-mastra-shared";

const log = logUtils.logger("mastra/history");

/** Default history page size; matches the Mastra storage default. */
const DEFAULT_PER_PAGE = 20;
/** Hard cap so a misbehaving client can't fetch the whole thread at once. */
const MAX_PER_PAGE = 200;

/** Inputs accepted by {@link loadHistory}. */
export interface LoadHistoryOptions {
  agent: Agent;
  threadId: string;
  resourceId?: string;
  page?: number;
  perPage?: number;
  /** When true, returns the *oldest* page first (chronological). */
  ascending?: boolean;
}

/**
 * Fetch a page of UI-formatted messages for a thread.
 *
 * Uses the agent's resolved `Memory` (`getMemory()`) so per-agent
 * storage namespaces (`mastra_<agentId>` schemas) and any future
 * memory-side filters apply automatically. When the agent has no
 * memory configured the response is a successful empty page so
 * callers don't have to special-case stateless agents.
 *
 * Pagination is descending-by-default: page 0 is the most recent
 * page, page 1 the page before that, etc. The returned `uiMessages`
 * are always re-sorted into chronological order (oldest -> newest)
 * so the client can prepend them above the existing transcript
 * without sorting locally.
 */
export async function loadHistory(
  opts: LoadHistoryOptions,
): Promise<MastraHistoryResponse> {
  const perPage = clampPerPage(opts.perPage);
  const page = Math.max(0, Math.trunc(opts.page ?? 0));
  const memory = await opts.agent.getMemory();
  if (!memory) {
    log.debug("recall:no-memory", { agentId: opts.agent.id, threadId: opts.threadId });
    return { uiMessages: [], page, perPage, total: 0, hasMore: false };
  }
  const startedAt = Date.now();
  const result = await memory.recall({
    threadId: opts.threadId,
    ...(opts.resourceId ? { resourceId: opts.resourceId } : {}),
    page,
    perPage,
    orderBy: {
      field: "createdAt",
      direction: opts.ascending ? "ASC" : "DESC",
    },
  });
  const chronological = sortChronological(result.messages);
  const uiMessages = toAISdkV5Messages(
    chronological,
  ) as unknown as MastraHistoryUIMessage[];
  log.debug("recall:done", {
    agentId: opts.agent.id,
    threadId: opts.threadId,
    page,
    perPage,
    returned: uiMessages.length,
    total: result.total,
    hasMore: result.hasMore,
    elapsedMs: Date.now() - startedAt,
  });
  return {
    uiMessages,
    page,
    perPage,
    total: result.total,
    hasMore: result.hasMore,
  };
}

/** Inputs accepted by {@link clearHistory}. */
export interface ClearHistoryOptions {
  agent: Agent;
  threadId: string;
}

/**
 * Wipe every persisted message tied to a thread. Returns the count
 * of messages that were on the thread at delete time so the caller
 * can render a "cleared N messages" affordance without an
 * additional round-trip.
 *
 * Agents without a configured `Memory` resolve to a no-op (count
 * 0), matching {@link loadHistory}'s "stateless agents return an
 * empty page" stance so callers don't have to special-case them.
 * Threads that don't exist yet are also a successful no-op - the
 * operation is idempotent so the UI can fire-and-forget without
 * tracking thread existence.
 */
export async function clearHistory(
  opts: ClearHistoryOptions,
): Promise<{ cleared: number }> {
  const memory = await opts.agent.getMemory();
  if (!memory) {
    log.debug("clear:no-memory", { agentId: opts.agent.id, threadId: opts.threadId });
    return { cleared: 0 };
  }
  // Mastra's `deleteThread` cascades to the message table, so we
  // can't ask for a count after the fact. Read it pre-delete with a
  // one-page recall sized to fit common threads in a single round
  // trip; the value is for telemetry / UI, not correctness.
  let cleared = 0;
  try {
    const probe = await memory.recall({
      threadId: opts.threadId,
      page: 0,
      perPage: 1,
    });
    cleared = probe.total;
  } catch (err) {
    // A missing-thread error is the happy-path "nothing to count";
    // every other error is logged but doesn't block the delete.
    log.debug("clear:probe-failed", {
      agentId: opts.agent.id,
      threadId: opts.threadId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const startedAt = Date.now();
  try {
    await memory.deleteThread(opts.threadId);
  } catch (err) {
    // Mastra's `deleteThread` raises when the thread row was never
    // created (e.g. clearing an empty session). Surface as a soft
    // warn and treat as success - the user-facing semantic is
    // "history is now empty" which is already true.
    log.warn("clear:delete-soft-failed", {
      agentId: opts.agent.id,
      threadId: opts.threadId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  log.info("clear:done", {
    agentId: opts.agent.id,
    threadId: opts.threadId,
    cleared,
    elapsedMs: Date.now() - startedAt,
  });
  return { cleared };
}

/** Options accepted by {@link historyRoute}. */
export type HistoryRouteOptions =
  | { path: `${string}:agentId${string}`; agent?: never }
  | { path: string; agent: string };

/**
 * Register the `<path>` Mastra custom API route. Handles two
 * methods on the same mount:
 *
 *   - `GET`: return a page of AI SDK V5 `UIMessage`s for the
 *     caller's current thread ({@link loadHistory}).
 *   - `DELETE`: wipe every persisted message on the caller's
 *     thread ({@link clearHistory}). The session cookie that
 *     anchors the thread id is left alone so the user keeps the
 *     same thread - only the contents go away.
 *
 * Modeled after `chatRoute` from `@mastra/ai-sdk`: pass `agent` for a
 * fixed-agent mount, or include `:agentId` in the path for dynamic
 * routing. Pairs cleanly with the AppKit Mastra plugin's chat route
 * layout (`/route/chat` + `/route/chat/:agentId`).
 *
 * The handler reads `threadId` and `resourceId` from `RequestContext`
 * (populated upstream by `MastraServer.registerAuthMiddleware`), so
 * no cookie or user lookups happen here.
 */
export function historyRoute(options: HistoryRouteOptions) {
  const { path } = options;
  const fixedAgent = "agent" in options ? options.agent : undefined;
  if (!fixedAgent && !path.includes(":agentId")) {
    throw new Error(
      "historyRoute path must include `:agentId` or `agent` must be passed explicitly",
    );
  }
  // Tiny resolver shared by GET / DELETE: derive the active agent
  // and thread id, returning a JSON error response when either is
  // missing. Keeps both handlers thin and gives them identical
  // validation behaviour.
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
    const threadId = requestContext.get(MASTRA_THREAD_ID_KEY) as string | undefined;
    if (!threadId) {
      return {
        error: c.json({ error: "thread id missing from request context" }, 400),
      } as const;
    }
    const resourceId = requestContext.get(MASTRA_RESOURCE_ID_KEY) as
      | string
      | undefined;
    return { agentId, agent, threadId, resourceId } as const;
  };

  return [
    registerApiRoute(path, {
      method: "GET",
      handler: async (c: ContextWithMastra) => {
        const ctx = resolveContext(c);
        if ("error" in ctx) return ctx.error;
        const payload = await loadHistory({
          agent: ctx.agent,
          threadId: ctx.threadId,
          ...(ctx.resourceId ? { resourceId: ctx.resourceId } : {}),
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
        const { cleared } = await clearHistory({
          agent: ctx.agent,
          threadId: ctx.threadId,
        });
        const payload: MastraClearHistoryResponse = {
          ok: true,
          agentId: ctx.agentId,
          threadId: ctx.threadId,
          cleared,
        };
        return c.json(payload);
      },
    }),
  ];
}

/** Coerce / clamp `perPage`; falls back to the page-size default. */
function clampPerPage(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value)) return DEFAULT_PER_PAGE;
  const n = Math.trunc(value);
  if (n <= 0) return DEFAULT_PER_PAGE;
  return Math.min(n, MAX_PER_PAGE);
}

/**
 * Sort messages oldest-first by `createdAt`, falling back to whatever
 * order the storage returned them in. The native `recall` call honors
 * `orderBy` but doesn't guarantee a stable secondary sort, so we
 * normalize here before handing the page to the AI SDK converter.
 */
function sortChronological(messages: MastraDBMessage[]): MastraDBMessage[] {
  return [...messages].sort((a, b) => {
    const ta = toEpoch(a.createdAt);
    const tb = toEpoch(b.createdAt);
    return ta - tb;
  });
}

function toEpoch(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/**
 * Coerce a Hono query value into a non-negative integer. Returns
 * `undefined` for empty / non-numeric / negative inputs so
 * {@link loadHistory} can apply its built-in defaults.
 */
function parseIntParam(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.trunc(n);
}
