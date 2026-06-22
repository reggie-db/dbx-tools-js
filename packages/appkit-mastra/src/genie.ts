/**
 * Genie tools for Mastra.
 *
 * Surfaces each configured Genie space as a small set of flat Mastra
 * tools the calling agent drives directly - no inner orchestrator
 * agent. The central agent decomposes user questions, picks which
 * space to ask, streams the per-turn wire events (status, thinking,
 * sql, rows) through `ctx.writer`, and composes the final reply.
 * Rows are never fetched eagerly: the agent reads a statement's
 * values only when it needs to reason about them, otherwise it embeds
 * a `[data:<statement_id>]` marker in prose and lets the host UI
 * resolve the data. Charts are minted asynchronously and referenced
 * by `[chart:<chartId>]` markers so prose isn't blocked on chart
 * generation; the host UI fetches the cached spec by id once ready.
 * Space description and serialized-space lookups are available for
 * grounding when the agent needs schema context.
 *
 * Each tool's `execute` pulls the per-request
 * {@link WorkspaceClient} off `ctx.requestContext` (stamped by
 * `MastraServer` under {@link MASTRA_USER_KEY}) and the per-call
 * `writer` / `abortSignal` off `ctx`, so the tools are stateless
 * across requests and the central agent owns the loop.
 *
 * The tools talk to Genie directly via `@dbx-tools/genie`
 * (`genieEventChat`); statement-row fetching is delegated to
 * {@link fetchStatementData} from `./statement.js`, which wraps
 * the workspace `statementExecution.getStatement` API. AppKit's
 * stock `genie` plugin is honored only for its `spaces` config
 * so existing AppKit-style wiring keeps working without change.
 *
 * Suggested orchestration prompt for the central agent lives in
 * {@link GENIE_INSTRUCTIONS}; compose it into the agent's own
 * `instructions` when you want the canonical "how to drive the
 * Genie tools" guidance.
 */

import { CacheManager, genie } from "@databricks/appkit";
import { ApiError, HttpError, WorkspaceClient } from "@databricks/sdk-experimental";
import {
  ChartSchema,
  type MastraWriter,
  type StartedEvent,
} from "@dbx-tools/appkit-mastra-shared";
import { genieEventChat, genieSampleQuestions, getGenieSpace } from "@dbx-tools/genie";
import { GenieMessageSchema, type GenieMessage } from "@dbx-tools/genie-shared";
import { appkitUtils, commonUtils, logUtils, stringUtils } from "@dbx-tools/shared";
import type { RequestContext } from "@mastra/core/request-context";
import { MASTRA_THREAD_ID_KEY } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import type { MastraTools } from "./agents.js";
import { chartPlannerRequestSchema, prepareChart } from "./chart.js";
import type { MastraPluginConfig } from "./config.js";
import { MASTRA_USER_KEY, type User } from "./config.js";
import { fetchStatementData } from "./statement.js";
import { safeWrite } from "./writer.js";

const log = logUtils.logger("mastra/genie");

/** Default alias used when a single unnamed Genie space is wired up. */
export const DEFAULT_GENIE_ALIAS = "default";

/* --------------------------- config types --------------------------- */

/** Per-space Genie agent configuration. */
export interface GenieSpaceConfig {
  /** Genie `space_id`. Required; resolves via `client.genie.getSpace`. */
  spaceId: string;
  /**
   * Optional human-readable description appended to the per-space
   * tool descriptions so the calling LLM has hints about *what
   * data* this space covers (e.g. "orders, returns,
   * fulfillment"). When omitted, only the space's own
   * `description` (fetched on first use of `get_space_description`)
   * is shown.
   */
  hint?: string;
}

/** Map of alias -> space config. Accepts either explicit objects or bare space ids. */
export type GenieSpacesConfig = Record<string, GenieSpaceConfig | string>;

/* ------------------------- ctx helpers ------------------------- */

/**
 * Narrow view of the second arg Mastra passes to a tool's
 * `execute(input, ctx)`. Captures the fields the Genie tools
 * actually read - `requestContext` (for user / conversation
 * state), `writer` (for streaming events to the host UI), and
 * `abortSignal` (for per-call cancellation).
 */
type ToolExecuteCtx =
  | {
      requestContext?: RequestContext;
      writer?: MastraWriter;
      abortSignal?: AbortSignal;
    }
  | undefined;

/**
 * Pull the per-request {@link WorkspaceClient} off the active
 * `RequestContext`. The Mastra plugin's server middleware stamps
 * a {@link User} on the context under {@link MASTRA_USER_KEY}
 * for every request; tools fail loudly when it's missing because
 * that means the Mastra plugin isn't running (e.g. a tool was
 * invoked outside the chat route).
 */
function requireClient(
  ctx: ToolExecuteCtx,
  toolId: string,
): {
  client: WorkspaceClient;
  requestContext: RequestContext;
} {
  const requestContext = ctx?.requestContext;
  if (!requestContext) {
    throw new Error(
      `${toolId}: missing requestContext (MastraServer must stamp MASTRA_USER_KEY)`,
    );
  }
  const user = requestContext.get(MASTRA_USER_KEY) as User | undefined;
  if (!user) {
    throw new Error(`${toolId}: no user on requestContext (MASTRA_USER_KEY not set)`);
  }
  return { client: user.executionContext.client, requestContext };
}

/**
 * Lowercased placeholder strings we reject at the `ask_genie`
 * boundary so the LLM doesn't spend a Genie round-trip on a
 * non-question. Genie politely answers any of these with "Your
 * request '...' does not relate to..." which is pure UI noise.
 * Kept narrow on purpose - real questions sometimes start with
 * one of these tokens, so we only match the FULL trimmed string.
 */
const PLACEHOLDER_QUESTIONS = new Set([
  "noop",
  "no-op",
  "skip",
  "none",
  "n/a",
  "na",
  "null",
  "undefined",
  "test",
  "placeholder",
]);

/* ----------------------- conversation state ----------------------- */

/**
 * Estimated Genie conversation lifetime in seconds. Databricks
 * publishes no official TTL on the conversation resource itself;
 * community projects (e.g. the open-source Databricks Genie Bot)
 * converge on 4 hours of inactivity as a safe operating window.
 * Treat this as an estimate that gets *extended on every use* by
 * re-setting the cache entry after each successful turn (sliding
 * TTL via re-`set`). When the estimate ends up wrong (conversation
 * deleted, expired upstream, cross-space referenced), `ask_genie`
 * catches the SDK's `RESOURCE_DOES_NOT_EXIST`/404 and transparently
 * starts a fresh conversation.
 */
const CONVERSATION_TTL_SEC = 4 * 60 * 60;

/** Cache namespace prefix so coexisting Mastra caches don't collide. */
const CONVERSATION_CACHE_NAMESPACE = "mastra:genie:conversation";

/**
 * `userKey` for `CacheManager.getOrExecute` / `generateKey`. Genie
 * conversations are scoped to a single user + space + thread, and
 * `threadId` is already user-scoped (Mastra mints threads per
 * `resourceId`), so a constant user key here is safe and keeps the
 * cache key short.
 */
const CONVERSATION_USER_KEY = "mastra-genie";

/**
 * Build the per-request {@link RequestContext} key the active
 * Genie `conversation_id` lives under for `spaceId`. Scoped by
 * space so an app calling two Genie spaces in one request keeps
 * each conversation distinct (Genie conversation ids are
 * space-scoped on the wire). The same `RequestContext` instance
 * flows from the central agent through to every `ask_genie`
 * invocation, so writes on one call are visible on the next
 * without an explicit shared ref.
 */
const conversationContextKey = (spaceId: string): string =>
  `mastra__genie_conversation__${spaceId}`;

/**
 * Read the active Genie `conversation_id` for `spaceId` off the
 * per-request {@link RequestContext}. Returns `undefined` when no
 * conversation has been started yet this request.
 */
function readContextConversationId(
  requestContext: RequestContext,
  spaceId: string,
): string | undefined {
  return requestContext.get(conversationContextKey(spaceId)) as string | undefined;
}

/**
 * Write the active Genie `conversation_id` for `spaceId` onto the
 * per-request {@link RequestContext}. Subsequent `ask_genie` calls
 * in this request will reuse it.
 */
function writeContextConversationId(
  requestContext: RequestContext,
  spaceId: string,
  conversationId: string | undefined,
): void {
  requestContext.set(conversationContextKey(spaceId), conversationId);
}

/**
 * Build the canonical cache key for a `(spaceId, threadId)` pair.
 * Returns `undefined` when `threadId` is missing - callers should
 * skip caching entirely in that case (no Mastra memory wired up).
 */
async function conversationCacheKey(
  spaceId: string,
  threadId: string | undefined,
): Promise<string | undefined> {
  if (!threadId) return undefined;
  return (await CacheManager.getInstance()).generateKey(
    [CONVERSATION_CACHE_NAMESPACE, spaceId, threadId],
    CONVERSATION_USER_KEY,
  );
}

/**
 * Read the cached Genie conversation id for `(spaceId, threadId)`.
 * Returns `undefined` on miss, on expiry, or when the cache layer
 * is unhealthy - never throws. The TTL is renewed via re-`set`
 * after each successful turn (see {@link saveCachedConversationId}).
 */
async function readCachedConversationId(
  cacheKey: string | undefined,
): Promise<string | undefined> {
  if (!cacheKey) return undefined;
  try {
    const v = await CacheManager.getInstanceSync().get<string>(cacheKey);
    return v ?? undefined;
  } catch (err) {
    log.warn("conversation-cache:read-error", {
      error: commonUtils.errorMessage(err),
    });
    return undefined;
  }
}

/**
 * Persist the active conversation id under `cacheKey`, refreshing
 * its TTL. Idempotent; no-op when `cacheKey` or `conversationId`
 * is missing. Re-setting the same key acts as a sliding TTL: every
 * turn that uses the conversation extends the window by another
 * {@link CONVERSATION_TTL_SEC} seconds.
 */
async function saveCachedConversationId(
  cacheKey: string | undefined,
  conversationId: string | undefined,
): Promise<void> {
  if (!cacheKey || !conversationId) return;
  try {
    await CacheManager.getInstanceSync().set(cacheKey, conversationId, {
      ttl: CONVERSATION_TTL_SEC,
    });
  } catch (err) {
    log.warn("conversation-cache:write-error", {
      error: commonUtils.errorMessage(err),
    });
  }
}

/** Force-evict a cached conversation id. Used on the stale-id recovery path. */
async function evictCachedConversationId(cacheKey: string | undefined): Promise<void> {
  if (!cacheKey) return;
  try {
    await CacheManager.getInstanceSync().delete(cacheKey);
  } catch (err) {
    log.warn("conversation-cache:delete-error", {
      error: commonUtils.errorMessage(err),
    });
  }
}

/**
 * Lazy-seed the active Genie `conversation_id` for `spaceId` from
 * the cross-request cache onto the per-request `RequestContext`.
 * No-op when the slot is already populated (subsequent
 * `ask_genie` calls in the same turn) so we hit the cache at most
 * once per request per space.
 */
async function ensureConversationSeeded(
  requestContext: RequestContext,
  spaceId: string,
  cacheKey: string | undefined,
): Promise<void> {
  if (readContextConversationId(requestContext, spaceId)) return;
  const cached = await readCachedConversationId(cacheKey);
  if (cached) writeContextConversationId(requestContext, spaceId, cached);
}

/**
 * True when `err` is the SDK error Genie returns for a
 * conversation id that no longer exists (deleted, expired upstream,
 * or referenced from the wrong space). Matches the typed
 * {@link ApiError} 404 / `RESOURCE_DOES_NOT_EXIST` shape first, then
 * falls back to the lower-level {@link HttpError} 404, then to a
 * loose message sniff for SDK shapes we haven't catalogued.
 */
function isConversationGoneError(err: unknown): boolean {
  if (err instanceof ApiError) {
    if (err.statusCode === 404) return true;
    if (err.errorCode === "RESOURCE_DOES_NOT_EXIST") return true;
  }
  if (err instanceof HttpError && err.code === 404) return true;
  if (err instanceof Error && /does not exist/i.test(err.message)) return true;
  return false;
}

/* ------------------------ prepare_chart input ------------------------ */

/**
 * Agent-facing `prepare_chart` input schema. Reuses
 * {@link chartPlannerRequestSchema} (the dataset-driven planner
 * contract) but swaps the inline `data` field for a Genie
 * `statement_id` the tool resolves into rows server-side.
 * `title` is loosened to optional - the planner falls back to a
 * generic placeholder when the agent doesn't supply one.
 *
 * Shaped to match Genie's wire form - `statement_id` (snake)
 * mirrors `query_result.statement_id` and the `get_statement`
 * tool's input field name, so the LLM only ever sees one
 * spelling for the same identifier.
 */
const prepareChartRequestSchema = chartPlannerRequestSchema
  .omit({ data: true, title: true })
  .extend({
    statement_id: z
      .string()
      .min(1, "statement_id is required")
      .describe(
        stringUtils.toDescription(`
          Genie \`statement_id\` to chart. Read from
          \`message.query_result.statement_id\` or
          \`message.attachments[*].query.statement_id\` returned by
          \`ask_genie\`.
        `),
      ),
    title: chartPlannerRequestSchema.shape.title.optional(),
  });

/* ----------------------------- tool ids ----------------------------- */

/**
 * Suffix appended to per-space tool ids when the alias isn't the
 * well-known `default`. Single-space deployments get the bare
 * names (`ask_genie`, `get_space_description`, ...); multi-space
 * deployments get `ask_genie_<alias>` etc. so each space's tools
 * stay disambiguated in the central agent's tool registry.
 */
function aliasSuffix(alias: string): string {
  if (alias === DEFAULT_GENIE_ALIAS) return "";
  const slug = stringUtils.toIdentifier(alias);
  return slug ? `_${slug}` : "";
}

/* --------------------------- per-space tools --------------------------- */

/**
 * Drop `suggested_questions` attachments from a {@link GenieMessage}
 * before handing it to the central LLM. Those entries already
 * surface in the UI as one-tap pills via the writer's
 * `suggested_questions` events (see `collectSuggestions` on the
 * client); if we let them ride back in the tool result the LLM
 * tends to quote them inline in its prose, double-showing the
 * same questions and stepping on the dedicated suggestion UI.
 * Query / text / row attachments are preserved so the model can
 * still read `statement_id`, SQL, and the answer text.
 */
function stripSuggestedQuestions(message: GenieMessage): GenieMessage {
  const attachments = message.attachments;
  if (!attachments || attachments.length === 0) return message;
  const filtered = attachments.filter((att) => !att.suggested_questions);
  if (filtered.length === attachments.length) return message;
  return { ...message, attachments: filtered };
}

function buildAskGenieTool(opts: { spaceId: string; alias: string; hint?: string }) {
  const { spaceId, alias, hint } = opts;
  const toolId = `ask_genie${aliasSuffix(alias)}`;
  const hintLine = hint ? ` (${hint})` : "";
  return createTool({
    id: toolId,
    description: stringUtils.toDescription(`
      Ask the Genie space "${alias}"${hintLine} ONE focused
      natural-language sub-question and wait for the turn to
      complete. Genie answers best when each call covers a
      single metric / dimension / time window, so expect to
      call this tool MULTIPLE TIMES per user turn (typically
      two to six) and let the results from earlier calls inform
      later ones - that's the normal pattern, not the exception.
      Do NOT try to cram a multi-part question into a single
      call; decompose first, then ask each piece.

      Returns the final \`GenieMessage\`. Rows are NOT included -
      the Genie wire response carries the \`statement_id\` for any
      SQL that ran (at \`message.query_result.statement_id\` or the
      first attachment's \`query.statement_id\`); call
      \`get_statement\` with that id only when you need to read
      the underlying values to reason about them. If you just
      want to display the rows to the user, embed a
      \`[data:<statement_id>]\` marker in your prose instead -
      the host UI fetches and renders the rows on its own. Wire
      events (status, thinking, sql) stream to the user
      automatically while the call is in flight.
    `),
    inputSchema: z.object({
      question: z.string().min(1, "question is required"),
    }),
    outputSchema: z.object({
      message: GenieMessageSchema,
    }),
    execute: async ({ question }, ctxRaw) => {
      const ctx = ctxRaw as ToolExecuteCtx;
      const { client, requestContext } = requireClient(ctx, toolId);
      const writer = ctx?.writer;
      const signal = ctx?.abortSignal;
      const threadId = requestContext.get(MASTRA_THREAD_ID_KEY) as string | undefined;

      // Bounce placeholder / no-op questions BEFORE spending a Genie
      // round-trip on them. Genie answers any of these with "Your
      // request 'noop' does not relate to..." - useless noise that
      // shows up in the UI and eats one of the workspace's 5
      // questions/minute. Returning a clear error here surfaces the
      // issue to the agent loop so the model corrects course instead
      // of wasting a turn.
      const trimmed = question.trim();
      if (trimmed.length === 0 || PLACEHOLDER_QUESTIONS.has(trimmed.toLowerCase())) {
        throw new Error(
          `${toolId}: refusing placeholder question "${question}" - ` +
            `call ${toolId} only with a real natural-language question, ` +
            `or skip the call entirely`,
        );
      }

      // Seed the active Genie `conversation_id` onto `RequestContext`
      // from the cross-request cache when a Mastra `threadId` is
      // present so multi-turn chats reuse the same Genie conversation
      // (and Genie's accumulated context) across separate user turns.
      // The same `RequestContext` is reused across every `ask_genie`
      // call within one user turn, so `ensureConversationSeeded`
      // hits the cache at most once per request per space.
      const cacheKey = await conversationCacheKey(spaceId, threadId);
      await ensureConversationSeeded(requestContext, spaceId, cacheKey);

      // Fire the lifecycle `started` event before any LLM /
      // network round-trip so the host UI can pop a "Thinking..."
      // pill the instant the model decides to delegate.
      const startedEvent: StartedEvent = {
        type: "started",
        spaceId,
        content: question,
      };
      await safeWrite(log, writer, startedEvent);

      // Single turn of `genieEventChat`. Hoisted into a closure so
      // we can re-run it after evicting a stale `conversation_id`
      // without duplicating the event-loop body.
      const runTurn = async (): Promise<GenieMessage> => {
        const seedConversationId = readContextConversationId(requestContext, spaceId);
        let finalMessage: GenieMessage | undefined;
        for await (const event of genieEventChat(spaceId, question, {
          workspaceClient: client,
          ...(seedConversationId ? { conversationId: seedConversationId } : {}),
          ...(signal ? { context: signal } : {}),
        })) {
          if (event.type !== "message") {
            await safeWrite(log, writer, event);
          }
          const eventConversationId = event.conversation_id;
          if (eventConversationId) {
            writeContextConversationId(requestContext, spaceId, eventConversationId);
          }
          if (event.type === "result") {
            finalMessage = event.message;
          }
        }
        if (!finalMessage) {
          throw new Error("Genie turn ended without a result event");
        }
        return finalMessage;
      };

      let finalMessage: GenieMessage;
      try {
        finalMessage = await runTurn();
      } catch (err) {
        // The seeded `conversation_id` was rejected by Genie - most
        // commonly because it was deleted upstream, expired past
        // Databricks' (undocumented) lifetime, or was minted in a
        // different space. Drop both the cached id AND the
        // per-request value so the retry calls `startConversation`,
        // and try once more. Only retry when we *had* a seeded id -
        // a fresh call that 404s shouldn't loop.
        const seeded = readContextConversationId(requestContext, spaceId);
        if (seeded && isConversationGoneError(err)) {
          log.warn("conversation-cache:stale, resetting", {
            spaceId,
            conversationId: seeded,
            error: commonUtils.errorMessage(err),
          });
          await evictCachedConversationId(cacheKey);
          writeContextConversationId(requestContext, spaceId, undefined);
          finalMessage = await runTurn();
        } else {
          throw err;
        }
      }

      // Refresh the cache entry on every successful turn. Re-setting
      // the same key both persists newly-minted ids (cache miss path)
      // and extends the TTL on active conversations (sliding window).
      await saveCachedConversationId(
        cacheKey,
        readContextConversationId(requestContext, spaceId),
      );

      return { message: stripSuggestedQuestions(finalMessage) };
    },
  });
}

function buildSpaceDescriptionTool(opts: { spaceId: string; alias: string }) {
  const { spaceId, alias } = opts;
  const toolId = `get_space_description${aliasSuffix(alias)}`;
  return createTool({
    id: toolId,
    description: stringUtils.toDescription(`
      Return the Genie space "${alias}"'s title, description, and
      warehouse id. Cheap (single REST call, no LLM round-trip).
      Call this FIRST on any user turn that's going to touch
      \`ask_genie\`, unless the same description already landed
      earlier in this conversation - the title + description tell
      you what tables, metrics, and time windows the space
      actually covers, which is what lets you decompose the
      user's question into the right \`ask_genie\` sub-questions.
    `),
    inputSchema: z.object({}),
    outputSchema: z.object({
      spaceId: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      warehouseId: z.string().optional(),
    }),
    execute: async (_input, ctxRaw) => {
      const ctx = ctxRaw as ToolExecuteCtx;
      const { client } = requireClient(ctx, toolId);
      const signal = ctx?.abortSignal;
      // Route through the package's central Genie space fetch. The
      // description surface (title / description / warehouse id) lives
      // on the directory-listing shape, so skip the larger
      // `serialized_space` payload here.
      const space = await getGenieSpace(spaceId, {
        workspaceClient: client,
        serialized: false,
        ...(signal ? { context: signal } : {}),
      });
      return {
        spaceId,
        ...(space.title ? { title: space.title } : {}),
        ...(space.description ? { description: space.description } : {}),
        ...(space.warehouse_id ? { warehouseId: space.warehouse_id } : {}),
      };
    },
  });
}

function buildSpaceSerializedTool(opts: { spaceId: string; alias: string }) {
  const { spaceId, alias } = opts;
  const toolId = `get_space_serialized${aliasSuffix(alias)}`;
  return createTool({
    id: toolId,
    description: stringUtils.toDescription(`
      Return the full \`GenieSpace\` JSON for the "${alias}" space.
      Use only when you need exact column / table identifiers
      \`get_space_description\` doesn't expose. Larger payload, so
      prefer the description tool when it's enough.
    `),
    inputSchema: z.object({}),
    outputSchema: z.object({ space: z.unknown() }),
    execute: async (_input, ctxRaw) => {
      const ctx = ctxRaw as ToolExecuteCtx;
      const { client } = requireClient(ctx, toolId);
      const signal = ctx?.abortSignal;
      // Central Genie space fetch with the opt-in `serialized_space`
      // blob (catalogs, tables, sample questions, prompts) that the
      // typed SDK `getSpace` omits - the whole point of this tool.
      const space = await getGenieSpace(spaceId, {
        workspaceClient: client,
        ...(signal ? { context: signal } : {}),
      });
      return { space };
    },
  });
}

/* --------------------------- shared tools --------------------------- */

/**
 * Default row cap for {@link buildGetStatementTool} when the agent
 * doesn't supply a `limit`. Sized to keep result sets out of the
 * model context unless the agent explicitly opts into more rows -
 * the cheap shape (column names + a handful of representative
 * rows) is usually enough to reason about a query.
 */
const DEFAULT_STATEMENT_LIMIT = 50;

function buildGetStatementTool() {
  const toolId = "get_statement";
  return createTool({
    id: toolId,
    description: stringUtils.toDescription(`
      Fetch the rows of a Genie statement by its \`statement_id\` (the
      value at \`message.query_result.statement_id\` or
      \`message.attachments[*].query.statement_id\` returned from
      \`ask_genie\`). Use this ONLY when you need to read the underlying
      values to reason about them in your reply - e.g. naming the
      largest row, computing a delta the visualization wouldn't already
      convey, or filtering down to a specific record. If you'd just be
      reciting numbers the user will see anyway, skip the call and
      embed a \`[data:<statement_id>]\` marker in your prose instead;
      the host UI fetches and renders the rows on its own. \`limit\`
      caps the number of rows returned (defaults to
      ${DEFAULT_STATEMENT_LIMIT}). \`rowCount\` reflects the full
      upstream total - compare to \`rows.length\` to detect truncation.
    `),
    inputSchema: z.object({
      statement_id: z.string().min(1, "statement_id is required"),
      limit: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Max rows to return. Defaults to a small sample; raise only when more rows are genuinely needed.",
        ),
    }),
    outputSchema: z.object({
      columns: z.array(z.string()),
      rows: z.array(z.record(z.string(), z.unknown())),
      rowCount: z.number(),
      truncated: z.boolean(),
    }),
    execute: async ({ statement_id, limit }, ctxRaw) => {
      const ctx = ctxRaw as ToolExecuteCtx;
      const { client } = requireClient(ctx, toolId);
      const signal = ctx?.abortSignal;
      const effectiveLimit = limit ?? DEFAULT_STATEMENT_LIMIT;
      const data = await fetchStatementData(client, statement_id, {
        limit: effectiveLimit,
        ...(signal ? { signal } : {}),
      });
      return {
        columns: data.columns,
        rows: data.rows,
        rowCount: data.rowCount,
        truncated: data.rows.length < data.rowCount,
      };
    },
  });
}

/**
 * `prepare_chart` Mastra tool. Thin wrapper over
 * {@link prepareChart} that resolves the dataset by fetching the
 * Genie statement's rows on demand. The tool mints a `chartId`
 * synchronously, caches an empty placeholder, and kicks off the
 * planner in the background so the agent loop never blocks. The
 * host UI resolves `[chart:<chartId>]` markers by reading the
 * cached {@link Chart} entry (1h TTL).
 *
 * Space-agnostic: a Genie `statement_id` is workspace-scoped, so
 * one shared `prepare_chart` tool covers every wired Genie space.
 *
 * Cancellation: deliberately does NOT forward the per-call
 * `abortSignal` to {@link prepareChart}. The planner task is
 * fire-and-forget background work; the tool's own `execute`
 * resolves the moment the `chartId` is minted, so the per-call
 * signal aborts the second the tool returns. The 1h cache TTL
 * caps abandoned entries.
 */
function buildPrepareChartTool(opts: { config: MastraPluginConfig }) {
  const { config } = opts;
  const toolId = "prepare_chart";
  return createTool({
    id: toolId,
    description: stringUtils.toDescription([
      `
        Queue a chart for the rows of a Genie statement. Mints a
        short \`chartId\` synchronously and kicks off a BACKGROUND
        task that fetches the statement's rows, runs the
        chart-planner to pick a chart type and Echarts spec, and
        caches the result under the \`chartId\` for one hour. The
        host UI fetches the cached chart on its own once it lands.
      `,
      `
        To display the chart in your reply, embed
        \`[chart:<chartId>]\` on its own line at the position you
        want it to appear, using the EXACT \`chartId\` string this
        call returned. Never construct a chart id yourself (it is
        not the \`statement_id\` or any variation of it) - only a
        value returned by this tool resolves to a real chart. The
        tool returns immediately - do NOT wait or call it again to
        "check progress"; the chart resolves asynchronously on the
        host UI's side.
      `,
      `
        Use this only when the data has a story a chart conveys
        better than a table (trends, rankings, distributions,
        parts-of-a-whole). For raw rows, embed
        \`[data:<statement_id>]\` instead and skip this tool.
      `,
    ]),
    inputSchema: prepareChartRequestSchema,
    outputSchema: ChartSchema.pick({ chartId: true }),
    execute: async (request, ctxRaw) => {
      const ctx = ctxRaw as ToolExecuteCtx;
      const { client } = requireClient(ctx, toolId);
      return prepareChart({
        config,
        ...(request.title ? { title: request.title } : {}),
        ...(request.description ? { description: request.description } : {}),
        resolveData: (taskSignal) =>
          fetchStatementData(client, request.statement_id, {
            ...(taskSignal ? { signal: taskSignal } : {}),
          }),
        ...(ctx?.requestContext ? { requestContext: ctx.requestContext } : {}),
      });
    },
  });
}

/* --------------------------- orchestration prompt --------------------------- */

/**
 * Suggested orchestration prompt for the central agent that owns
 * the Genie tools. Compose into your agent's `instructions` to
 * get the canonical "decompose questions, ask Genie focused
 * sub-questions, place data / chart markers in prose" behavior:
 *
 * ```ts
 * createAgent({
 *   instructions: `${myAgentInstructions}\n\n${GENIE_INSTRUCTIONS}`,
 *   tools(plugins) {
 *     return { ...plugins.genie?.toolkit() };
 *   },
 * });
 * ```
 *
 * The prompt references the bare tool names (`ask_genie`,
 * `get_space_description`, `get_space_serialized`,
 * `get_statement`, `prepare_chart`) used for the single-space
 * default alias. Multi-space deployments should write their own
 * variant that names the suffixed per-space tools
 * (e.g. `ask_genie_sales`).
 */
export const GENIE_INSTRUCTIONS = stringUtils.toDescription([
  "Genie orchestration. For every user question that needs SQL-backed data:",
  {
    numbered: [
      `
        Start by calling \`get_space_description\` to ground yourself
        in what the space covers (tables, metrics, time windows),
        unless you already saw the same description earlier in this
        conversation. Reach for \`get_space_serialized\` only when you
        need exact column / table identifiers the description doesn't
        expose - it's a much larger payload.
      `,
      `
        Decompose the user's question into focused sub-questions
        BEFORE asking Genie anything. One sub-question per distinct
        metric, dimension, or time window. Then call \`ask_genie\`
        once per sub-question - usually two to six calls per turn,
        and let earlier answers inform what you ask next. Cramming
        a multi-part question into one \`ask_genie\` call almost
        always produces a worse answer than asking the pieces
        separately. Only collapse to a single call when the question
        is genuinely atomic ("what was Q3 revenue?").

        Worked example: user asks "How did SKU 1234's revenue
        compare to its category average last quarter, and which
        regions drove the gap?" Decomposes to: (a) \`ask_genie\`
        for SKU 1234's Q3 revenue, (b) \`ask_genie\` for the
        category-average Q3 revenue, (c) \`ask_genie\` for SKU
        1234's Q3 revenue split by region. Three focused calls,
        each grounded in the prior results.
      `,
      `
        Each \`ask_genie\` call returns the terminal \`GenieMessage\`.
        When the turn ran SQL the result has a \`statement_id\` - read
        it from \`message.query_result.statement_id\` (or the first
        attachment's \`query.statement_id\`).
      `,
      [
        `
          To DISPLAY a result set in your reply, embed a marker on its
          own line where the visualization should appear. Two marker
          shapes:
        `,
        {
          bullets: [
            `
              \`[data:<statement_id>]\` - render the rows as a table.
              Use this when there's no clear visual story (long lists,
              reference data, single-row results, or the user just
              wants to see the data). Embed the marker directly; no
              tool call needed.
            `,
            `
              \`[chart:<chartId>]\` - render the rows as a chart. To
              get a \`<chartId>\`, call \`prepare_chart\` with the
              statement's id (and an optional \`title\` / one-line
              \`description\` of the insight to surface). The tool
              returns the \`chartId\` synchronously and prepares the
              chart spec in the background; embed the returned id as
              \`[chart:<chartId>]\` on its own line wherever the
              chart should appear. Use a chart when the data has a
              story a visual conveys better than a table (trends,
              rankings, distributions, parts-of-a-whole).

              NEVER invent or hand-build a \`<chartId>\`. A valid
              \`<chartId>\` is the opaque token a \`prepare_chart\`
              call returned to you in THIS turn - nothing else. It
              is NOT a \`statement_id\`, and it is NOT a
              \`statement_id\` prefix with a label appended (e.g.
              \`01f1...-region-fill\`). If you have not called
              \`prepare_chart\` and received an id back, do not write
              a \`[chart:...]\` marker at all - use \`[data:...]\`
              instead. A fabricated chart id renders nothing and
              wastes a request.
            `,
          ],
        },
        `
          The host UI resolves both markers on its own once it sees
          them - you do NOT need to call \`get_statement\` just to
          display data, and you do NOT need to wait on
          \`prepare_chart\` (it returns the id immediately and the
          host UI fetches the cached chart later). Pick at most one
          marker per statement; don't chart AND table the same result
          side by side.
        `,
      ],
      `
        Call \`get_statement(statement_id, limit?)\` ONLY when you need
        to read the actual values to reason about them (e.g. naming a
        specific row, computing a delta the table or chart wouldn't
        show, or sanity-checking a result before interpreting it). If
        you'd just be reciting numbers the visualization already shows,
        skip the call and use a marker instead. \`limit\` defaults to a
        small sample; raise it only when you genuinely need more rows.
      `,
      `
        Compose your final reply as plain prose. Interleave paragraphs
        with \`[data:...]\` / \`[chart:...]\` markers wherever a result
        should render. Don't dump all markers at the end - place each
        one next to the prose that interprets it. Don't restate every
        number the visualization already shows; call out deltas,
        anomalies, takeaways.
      `,
    ],
  },
]);

/* --------------------- multi-alias surface --------------------- */

/**
 * Normalize the {@link GenieSpacesConfig} record. Bare-string
 * entries (`{ default: "01ef..." }`) get wrapped as
 * `{ spaceId: "01ef..." }`; object entries pass through unchanged.
 * `undefined` and empty-string values are dropped so callers can
 * pass `process.env.X` directly (matches AppKit `genie()`'s
 * defensive treatment of unset env vars).
 */
export function normalizeGenieSpaces(
  spaces:
    | GenieSpacesConfig
    | Record<string, string | GenieSpaceConfig | undefined>
    | undefined,
): Record<string, GenieSpaceConfig> {
  if (!spaces) return {};
  const out: Record<string, GenieSpaceConfig> = {};
  for (const [alias, value] of Object.entries(spaces)) {
    if (value === undefined) continue;
    if (typeof value === "string") {
      if (!value) continue;
      out[alias] = { spaceId: value };
      continue;
    }
    if (!value.spaceId) continue;
    out[alias] = value;
  }
  return out;
}

/**
 * AppKit `genie` plugin's config shape, derived from the factory
 * itself so it stays in lock-step with the upstream type without
 * deep-importing `IGenieConfig` (which the package's top-level
 * barrel doesn't surface). The plugin's `config` field is
 * `protected` in TS only; the runtime layout is plain object
 * property access, so reading off the instance with a structural
 * cast is safe.
 */
type AppKitGenieConfig = NonNullable<Parameters<typeof genie>[0]>;

/**
 * Discover Genie space aliases from every supported source and
 * merge them into a single record. Precedence (highest first):
 *
 *   1. {@link MastraPluginConfig.genieSpaces} on the `mastra(...)`
 *      call. Explicit Mastra wiring always wins so users can
 *      override AppKit's defaults per-agent.
 *   2. AppKit `genie({ spaces: { ... } })` plugin instance. Lets
 *      users keep using the existing AppKit config format
 *      (`genie({ spaces: { sales: "...", ops: "..." } })`)
 *      without restating the same record on the Mastra plugin.
 *      Read off the live plugin instance via a structural cast
 *      since `Plugin.config` is TS-protected (not runtime-private).
 *   3. `DATABRICKS_GENIE_SPACE_ID` env var (registered under the
 *      well-known `default` alias). Matches the AppKit `genie()`
 *      plugin's fallback behavior so a bare `mastra()` + `genie()`
 *      pair just works.
 *
 * Aliases collide cleanly: a higher-precedence source's value
 * replaces a lower one's wholesale. Sources that contribute zero
 * aliases (or contribute only `undefined` / empty entries) are
 * silently ignored.
 */
export function resolveGenieSpaces(
  config: MastraPluginConfig,
  context: appkitUtils.PluginContextLike | undefined,
): Record<string, GenieSpaceConfig> {
  const merged: Record<string, GenieSpaceConfig> = {};

  // Source 3 (lowest precedence): env var.
  const envSpaceId = process.env["DATABRICKS_GENIE_SPACE_ID"];
  if (envSpaceId) {
    merged[DEFAULT_GENIE_ALIAS] = { spaceId: envSpaceId };
  }

  // Source 2: AppKit `genie()` plugin instance config. Use a
  // structural cast - `Plugin.config` is `protected` in TS only,
  // and the runtime layout is plain object property access.
  const geniePlugin = appkitUtils.instance(context, genie);
  if (geniePlugin) {
    const pluginSpaces = (geniePlugin as unknown as { config?: AppKitGenieConfig })
      .config?.spaces;
    if (pluginSpaces) {
      Object.assign(merged, normalizeGenieSpaces(pluginSpaces));
    }
  }

  // Source 1 (highest precedence): explicit Mastra wiring.
  if (config.genieSpaces) {
    Object.assign(merged, normalizeGenieSpaces(config.genieSpaces));
  }

  return merged;
}

/**
 * Build the flat Mastra tools record for every configured Genie
 * space. Two shared, space-agnostic tools (`get_statement`,
 * `prepare_chart`) are registered once regardless of how many
 * spaces are wired; the per-space tools (`ask_genie`,
 * `get_space_description`, `get_space_serialized`) are suffixed
 * with `_<alias>` for non-default aliases so multi-space
 * deployments stay disambiguated.
 *
 * Returns a record keyed by tool id, ready to spread into the
 * central `Agent`'s `tools` map (or surfaced via the
 * `plugins.genie?.toolkit()` callback). Returns an empty record
 * when `spaces` resolves to zero entries so the caller can spread
 * safely.
 */
export function buildGenieTools(opts: {
  spaces: GenieSpacesConfig | Record<string, GenieSpaceConfig>;
  config: MastraPluginConfig;
}): MastraTools {
  const normalized = normalizeGenieSpaces(opts.spaces);
  const tools: Record<string, ReturnType<typeof createTool>> = {};
  if (Object.keys(normalized).length === 0) return tools;

  // Shared, space-agnostic tools.
  tools.get_statement = buildGetStatementTool();
  tools.prepare_chart = buildPrepareChartTool({ config: opts.config });

  for (const [alias, space] of Object.entries(normalized)) {
    const askTool = buildAskGenieTool({
      spaceId: space.spaceId,
      alias,
      ...(space.hint ? { hint: space.hint } : {}),
    });
    const descTool = buildSpaceDescriptionTool({ spaceId: space.spaceId, alias });
    const serTool = buildSpaceSerializedTool({ spaceId: space.spaceId, alias });
    tools[askTool.id] = askTool;
    tools[descTool.id] = descTool;
    tools[serTool.id] = serTool;
  }
  return tools;
}

/**
 * Plugin-toolkit adapter so the `plugins.genie?.toolkit()` lookup
 * inside an agent's `tools(plugins)` callback returns the
 * flat Genie tools record instead of throwing on missing plugin.
 * Mirrors AppKit's `PluginToolkitProvider` shape.
 */
export function buildGenieToolkitProvider(opts: {
  spaces: GenieSpacesConfig | Record<string, GenieSpaceConfig>;
  config: MastraPluginConfig;
}): {
  toolkit(opts?: unknown): MastraTools;
} {
  return {
    toolkit(_opts?: unknown) {
      return buildGenieTools(opts);
    },
  };
}

/* --------------------------- starter suggestions --------------------------- */

/**
 * Default cap on starter suggestions surfaced to the chat empty
 * state. Sample-question lists can run long (10+ on a curated
 * space); a handful of one-tap prompts reads better than a wall of
 * buttons.
 */
const SUGGESTION_LIMIT = 6;

/**
 * How long a space's parsed sample questions stay cached. They're
 * authored config that changes rarely, and the lookup is an extra
 * REST round-trip per chat mount, so a few minutes of caching keeps
 * the empty state instant on reload without going stale for long.
 */
const SUGGESTION_CACHE_TTL_MS = 10 * 60_000;

/** Space-id -> cached sample questions with an absolute expiry. */
const _suggestionCache = new Map<string, { questions: string[]; expires: number }>();

/** Read a space's cached questions, or `undefined` on miss / expiry. */
function readSuggestionCache(spaceId: string): string[] | undefined {
  const entry = _suggestionCache.get(spaceId);
  if (!entry) return undefined;
  if (entry.expires <= Date.now()) {
    _suggestionCache.delete(spaceId);
    return undefined;
  }
  return entry.questions;
}

/** Cache a space's parsed questions for {@link SUGGESTION_CACHE_TTL_MS}. */
function writeSuggestionCache(spaceId: string, questions: string[]): void {
  _suggestionCache.set(spaceId, {
    questions,
    expires: Date.now() + SUGGESTION_CACHE_TTL_MS,
  });
}

/**
 * Collect the curated starter questions across every resolved Genie
 * space, deduped and capped. Each space's `sample_questions` are
 * fetched once (cached for {@link SUGGESTION_CACHE_TTL_MS}) via
 * {@link getGenieSpace} + {@link genieSampleQuestions}, then merged in
 * alias-iteration order so a single-space app surfaces that space's
 * questions and a multi-space app round-trips breadth-first up to the
 * cap. A per-space fetch failure degrades to "no questions for that
 * space" (logged, not thrown) so one unreachable space never blanks
 * the whole list. Returns `[]` when no spaces are configured.
 */
export async function collectSpaceSuggestions(opts: {
  spaces: Record<string, GenieSpaceConfig>;
  client: WorkspaceClient;
  signal?: AbortSignal;
  limit?: number;
}): Promise<string[]> {
  const limit = opts.limit ?? SUGGESTION_LIMIT;
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const { spaceId } of Object.values(opts.spaces)) {
    let questions = readSuggestionCache(spaceId);
    if (!questions) {
      try {
        const space = await getGenieSpace(spaceId, {
          workspaceClient: opts.client,
          ...(opts.signal ? { context: opts.signal } : {}),
        });
        questions = genieSampleQuestions(space);
        writeSuggestionCache(spaceId, questions);
      } catch (err) {
        log.warn("suggestions:fetch-error", {
          spaceId,
          error: commonUtils.errorMessage(err),
        });
        questions = [];
      }
    }
    for (const question of questions) {
      if (seen.has(question)) continue;
      seen.add(question);
      merged.push(question);
      if (merged.length >= limit) return merged;
    }
  }
  return merged;
}
