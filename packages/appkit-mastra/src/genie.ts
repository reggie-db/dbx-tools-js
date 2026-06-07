/**
 * Genie agent for Mastra.
 *
 * Each configured Genie space exposes a single Mastra tool to the
 * calling agent (`genie` for the `"default"` alias, `genie_<alias>`
 * otherwise). When invoked, the tool runs end-to-end:
 *
 *   1. Pulls the per-request {@link WorkspaceClient} off
 *      `ctx.requestContext` (stamped by `MastraServer`) and emits a
 *      `started` writer event so the host UI can show progress
 *      immediately, before any LLM round-trip.
 *   2. Spins up a per-call inner Mastra `Agent` with three tools:
 *        - `ask_genie`: drives one `genieEventChat` turn, fetches
 *          the matching statement's rows when the turn ran SQL,
 *          and forwards every wire event (status, thinking, sql,
 *          rows) through `ctx.writer` for streaming UI updates.
 *        - `get_space_description`: cheap title / description /
 *          warehouse id lookup for grounding.
 *        - `get_space_serialized`: full `GenieSpace` JSON for
 *          column-level grounding when the description isn't
 *          enough.
 *   3. Runs the inner agent with `structuredOutput` (Mastra's
 *      two-pass mode + `jsonPromptInjection`) to coerce the
 *      agent's final answer into a tagged
 *      `[{type:"text"|"data", ...}]` array. The two-pass design
 *      avoids Databricks Model Serving's `response_format` +
 *      `tools` collision; prompt injection sidesteps the
 *      separate `response_format` + streaming collision in the
 *      structuring agent.
 *   4. Charts every `data` item in parallel via
 *      {@link runChartPlanner}, maps `text` items to the shared
 *      {@link GenieSummaryItem} `string` variant, and returns the
 *      hydrated {@link GenieAgentResult}.
 *
 * The legacy AppKit `genie` plugin (`@databricks/appkit`'s `genie`)
 * is no longer used at runtime. The inner agent talks to Genie
 * directly via `@dbx-tools/genie` (`genieEventChat`) and the
 * workspace `statementExecution.getStatement` API. The plugin's
 * `spaces` config is still honored so existing AppKit-style wiring
 * keeps working without change.
 */

import { CacheManager, genie } from "@databricks/appkit";
import { ApiError, HttpError, WorkspaceClient } from "@databricks/sdk-experimental";
import { genieEventChat } from "@dbx-tools/genie";
import { type GenieMessage } from "@dbx-tools/genie-shared";
import {
  type ChartEvent,
  type GenieAgentResult,
  type GenieDataset,
  type GenieDatasetData,
  type GenieSummaryItem,
  type MastraGenieErrorEvent,
  type MinimalWriter,
  type StartedEvent,
  type SummaryEvent,
} from "@dbx-tools/appkit-mastra-shared";
import {
  apiUtils,
  appkitUtils,
  commonUtils,
  logUtils,
  stringUtils,
} from "@dbx-tools/shared";
import { Agent } from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";
import { MASTRA_THREAD_ID_KEY } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import type { MastraTools } from "./agents.js";
import { runChartPlanner } from "./chart.js";
import type { MastraPluginConfig } from "./config.js";
import { MASTRA_USER_KEY, type User } from "./config.js";
import { buildModel } from "./model.js";

const log = logUtils.logger("mastra/genie");

/** Default alias used when a single unnamed Genie space is wired up. */
export const DEFAULT_GENIE_ALIAS = "default";

/**
 * Cap on the inner agent's tool-loop steps. 5 (Mastra default) is
 * tight - one `get_space_description` + one `ask_genie` per
 * sub-question saturates fast. 16 leaves room for ~10 `ask_genie`
 * rounds plus grounding plus the structuring pass (which runs
 * after the loop and is its own single call).
 */
const DEFAULT_MAX_STEPS = 16;

/* --------------------------- config types --------------------------- */

/** Per-space Genie agent configuration. */
export interface GenieSpaceConfig {
  /** Genie `space_id`. Required; resolves via `client.genie.getSpace`. */
  spaceId: string;
  /**
   * Optional human-readable description appended to the Genie
   * tool's description so the calling LLM has hints about
   * *what data* this space covers (e.g. "orders, returns,
   * fulfillment"). When omitted, only the space's own
   * `description` (fetched on first use) is shown.
   */
  hint?: string;
}

/** Map of alias -> space config. Accepts either explicit objects or bare space ids. */
export type GenieSpacesConfig = Record<string, GenieSpaceConfig | string>;

/* ------------------------- helpers ------------------------- */

/** Best-effort numeric coercion for Genie's all-strings cells. */
function coerceCell(cell: string | null): unknown {
  if (cell === null) return null;
  if (/^-?\d+(\.\d+)?$/.test(cell)) {
    const n = Number(cell);
    if (Number.isFinite(n)) return n;
  }
  return cell;
}

/**
 * Fetch a single Genie statement's rows via the Statement
 * Execution API and reshape into the shared
 * {@link GenieDatasetData} shape (column array + row records).
 */
async function fetchStatementData(
  client: WorkspaceClient,
  statementId: string,
  signal?: AbortSignal,
): Promise<GenieDatasetData> {
  const ctx = signal ? apiUtils.toContext(signal) : undefined;
  const r = await client.statementExecution.getStatement(
    { statement_id: statementId },
    ctx,
  );
  const columns = (r.manifest?.schema?.columns ?? []).map((c) => c.name ?? "");
  const dataArray = (r.result?.data_array ?? []) as Array<Array<string | null>>;
  const rows = dataArray.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      obj[col] = coerceCell(row[i] ?? null);
    });
    return obj;
  });
  return {
    columns,
    rows,
    rowCount: r.manifest?.total_row_count ?? rows.length,
  };
}

/**
 * Resolve the message's representative `statement_id`. Genie
 * returns one statement per turn in practice; we read the
 * (deprecated-but-singular) `message.query_result.statement_id`
 * first and fall back to the first attachment's
 * `query.statement_id`. Returns `undefined` when the turn had no
 * SQL run (pure prose answer).
 */
function extractStatementId(message: GenieMessage): string | undefined {
  const top = (message.query_result as { statement_id?: string } | undefined)
    ?.statement_id;
  if (top) return top;
  for (const att of message.attachments ?? []) {
    const id = att.query?.statement_id;
    if (id) return id;
  }
  return undefined;
}

/**
 * Best-effort `writer.write`. The writer carries the unified flat
 * event vocabulary directly - no translation layer - so
 * subscribers narrow on `event.type` and read fields inline.
 * Failures (downstream stream closed, cancelled request) are
 * swallowed with a `warn` log so an in-flight Genie turn isn't
 * taken down by a navigated-away client.
 */
async function safeWrite(
  writer: MinimalWriter | undefined,
  chunk: unknown,
): Promise<void> {
  if (!writer) return;
  try {
    await writer.write(chunk);
  } catch (err) {
    log.warn("writer:error", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
 * deleted, expired upstream, cross-space referenced), the wrapper
 * catches the SDK's `RESOURCE_DOES_NOT_EXIST`/404 and transparently
 * starts a fresh conversation.
 */
const CONVERSATION_TTL_SEC = 4 * 60 * 60;

/** Cache namespace prefix so coexisting Mastra caches don't collide. */
const CONVERSATION_CACHE_NAMESPACE = "mastra:genie:conversation";

/**
 * Build the per-request {@link RequestContext} key the active
 * Genie `conversation_id` lives under for `spaceId`. Scoped by
 * space so an app calling two Genie spaces in one request keeps
 * each conversation distinct (Genie conversation ids are
 * space-scoped on the wire). The same `RequestContext` instance
 * flows from the outer `genie` tool through to the inner
 * `ask_genie` tool via Mastra, so writes on one side are visible
 * on the other without an explicit shared ref.
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
 * in this request will reuse it; the wrapper's tail logic also
 * reads it back out for the {@link GenieAgentResult}.
 */
function writeContextConversationId(
  requestContext: RequestContext,
  spaceId: string,
  conversationId: string | undefined,
): void {
  requestContext.set(conversationContextKey(spaceId), conversationId);
}

/* ------------------------- chart inventory ------------------------- */

/**
 * Per-request {@link RequestContext} key the resolved chart
 * inventory lives under. Keyed by `chartId`, the inventory is a
 * `Map<string, ChartEvent>` carrying the full Echarts spec for
 * every chart minted on this request - the same payload that
 * goes out on the writer stream, kept in-process so output
 * processors and downstream tools can resolve `[[chart:<id>]]`
 * markers without re-running the planner or pulling from the
 * writer stream.
 *
 * Shared across all Genie spaces because chart ids are minted
 * via `commonUtils.shortId()` and are unique within a single
 * request regardless of which space produced them.
 */
const CHART_INVENTORY_CONTEXT_KEY = "mastra__genie_chart_inventory__";

/**
 * Get the chart inventory map for this request, creating it on
 * first access. Subsequent reads return the same map so callers
 * mutate in place. The map is request-scoped (collected with the
 * `RequestContext` at end of request), so there's no per-process
 * leak.
 */
export function chartInventoryFromContext(
  requestContext: RequestContext,
): Map<string, ChartEvent> {
  const existing = requestContext.get(CHART_INVENTORY_CONTEXT_KEY);
  if (existing instanceof Map) {
    return existing as Map<string, ChartEvent>;
  }
  const fresh = new Map<string, ChartEvent>();
  requestContext.set(CHART_INVENTORY_CONTEXT_KEY, fresh);
  return fresh;
}

/**
 * Stash a resolved chart on the request-scoped inventory so any
 * subsequent code in this request (output processors validating
 * `[[chart:<id>]]` markers, follow-up tools that want to chart
 * the same dataset differently, etc.) can look it up by id.
 * No-op when `requestContext` is missing.
 */
function recordChartInContext(
  requestContext: RequestContext | undefined,
  chart: ChartEvent,
): void {
  if (!requestContext) return;
  chartInventoryFromContext(requestContext).set(chart.chartId, chart);
}

/**
 * `userKey` for `CacheManager.getOrExecute` / `generateKey`. Genie
 * conversations are scoped to a single user + space + thread, and
 * `threadId` is already user-scoped (Mastra mints threads per
 * `resourceId`), so a constant user key here is safe and keeps the
 * cache key short.
 */
const CONVERSATION_USER_KEY = "mastra-genie";

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
      error: err instanceof Error ? err.message : String(err),
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
      error: err instanceof Error ? err.message : String(err),
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
      error: err instanceof Error ? err.message : String(err),
    });
  }
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

/* --------------------------- inner tools --------------------------- */

/**
 * One entry in {@link InnerToolDeps.resultSets}: the rows for a
 * Genie statement plus the Genie `message_id` of the `ask_genie`
 * turn that produced it. Tracking `messageId` here lets the
 * outer chart loop stamp the chart event (and any chart-error
 * writer event) with the same `messageId` the rest of that
 * ask's wire events carry, so the host UI groups the chart into
 * the same `message_id` pill bucket without a separate lookup.
 */
interface StatementEntry {
  data: GenieDatasetData;
  messageId: string;
}

/**
 * Per-call mutable state shared by the inner agent's three tools.
 * `resultSets` lets the wrapper pull rows by `statementId` after
 * the agent finishes, so the chart-planner doesn't re-fetch. The
 * active Genie `conversation_id` lives on `RequestContext` (read
 * via {@link readContextConversationId} on the inner tool's `ctx`)
 * rather than a shared ref - the same `RequestContext` instance
 * threads from `agent.generate({requestContext})` through to every
 * tool invocation, so writes propagate to subsequent `ask_genie`
 * calls without an extra object. `cacheKey` is the
 * {@link CacheManager} key for cross-request persistence (`undefined`
 * when `threadId` isn't available and caching is disabled).
 */
interface InnerToolDeps {
  spaceId: string;
  client: WorkspaceClient;
  writer?: MinimalWriter;
  signal?: AbortSignal;
  resultSets: Map<string, StatementEntry>;
  cacheKey?: string;
}

function buildAskGenieTool(deps: InnerToolDeps) {
  const { spaceId, client, writer, signal, resultSets, cacheKey } = deps;
  return createTool({
    id: "ask_genie",
    description: stringUtils.toDescription`
      Send ONE focused natural-language question to the Genie
      space and wait for the turn to complete. Returns the final
      \`GenieMessage\` plus, when the turn ran SQL, the rows of
      the resulting query as \`query_result_data\`. The
      \`statement_id\` you reference in your final \`data\`
      blocks lives at \`message.query_result.statement_id\` (or
      the first attachment's \`query.statement_id\`). Wire
      events (status, thinking, sql) stream to the user
      automatically. Call multiple times to gather different
      angles before composing the final response.
    `,
    inputSchema: z.object({
      question: z.string().min(1, "question is required"),
    }),
    outputSchema: z.object({
      message: z.custom<GenieMessage>(),
      query_result_data: z.custom<GenieDatasetData>().optional(),
    }),
    execute: async ({ question }, ctxRaw) => {
      const ctx = ctxRaw as { requestContext?: RequestContext } | undefined;
      const requestContext = ctx?.requestContext;
      if (!requestContext) {
        // Mastra always passes a `RequestContext` to tools when the
        // parent agent received one. The outer Genie tool insists on
        // it (it sources the user from there), so this only fires
        // if a misconfigured caller invokes `ask_genie` directly.
        throw new Error(
          "ask_genie: missing requestContext (parent agent must propagate it)",
        );
      }

      // Bounce placeholder / no-op questions BEFORE spending a Genie
      // round-trip on them. The structuring pass occasionally pads
      // out the tool loop with a fake `ask_genie("noop")` call,
      // which Genie answers with "Your request 'noop' does not
      // relate to..." - useless noise that shows up in the UI and
      // eats one of the workspace's 5 questions/minute. Returning
      // a clear error here surfaces the issue to the agent loop so
      // the model corrects course instead of wasting a turn.
      const trimmed = question.trim();
      if (trimmed.length === 0 || PLACEHOLDER_QUESTIONS.has(trimmed.toLowerCase())) {
        throw new Error(
          `ask_genie: refusing placeholder question "${question}" - ` +
            `call ask_genie only with a real natural-language question, ` +
            `or skip the call entirely`,
        );
      }

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
          await safeWrite(writer, event);
          // Wire events come in two flavors: the lifecycle `message`
          // event embeds the raw `GenieMessage` (read its
          // `conversation_id`), and the rest carry a flat
          // `conversation_id` field at the top level. The terminal
          // `result` event also carries the final `GenieMessage`
          // inline so we can capture the snapshot without re-reading
          // a buffered `message` event.
          const eventConversationId =
            event.type === "message"
              ? event.message.conversation_id
              : event.conversation_id;
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
            error: err instanceof Error ? err.message : String(err),
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

      const statementId = extractStatementId(finalMessage);
      let queryResultData: GenieDatasetData | undefined;
      if (statementId) {
        const data = await fetchStatementData(client, statementId, signal);
        if (data.rowCount > 0) {
          queryResultData = data;
          // Stash with this ask's `message_id` so the outer chart
          // loop can stamp downstream `chart` events with the
          // same id the wire events carry - keeps the chart in
          // the same `message_id` pill bucket on the host UI.
          resultSets.set(statementId, {
            data,
            messageId: finalMessage.message_id,
          });
        }
      }
      return {
        message: finalMessage,
        ...(queryResultData ? { query_result_data: queryResultData } : {}),
      };
    },
  });
}

function buildSpaceDescriptionTool(deps: {
  spaceId: string;
  client: WorkspaceClient;
  signal?: AbortSignal;
}) {
  const { spaceId, client, signal } = deps;
  return createTool({
    id: "get_space_description",
    description: stringUtils.toDescription`
      Return the Genie space's title, description, and warehouse id.
      Cheap. Call once at the start of a turn to ground yourself
      in what data the space covers.
    `,
    inputSchema: z.object({}),
    outputSchema: z.object({
      spaceId: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      warehouseId: z.string().optional(),
    }),
    execute: async () => {
      const ctx = signal ? apiUtils.toContext(signal) : undefined;
      const space = await client.genie.getSpace({ space_id: spaceId }, ctx);
      return {
        spaceId,
        ...(space.title ? { title: space.title } : {}),
        ...(space.description ? { description: space.description } : {}),
        ...(space.warehouse_id ? { warehouseId: space.warehouse_id } : {}),
      };
    },
  });
}

function buildSpaceSerializedTool(deps: {
  spaceId: string;
  client: WorkspaceClient;
  signal?: AbortSignal;
}) {
  const { spaceId, client, signal } = deps;
  return createTool({
    id: "get_space_serialized",
    description: stringUtils.toDescription`
      Return the full \`GenieSpace\` JSON for this space. Use only
      when you need exact column / table identifiers
      \`get_space_description\` doesn't expose. Larger payload, so
      prefer the description tool when it's enough.
    `,
    inputSchema: z.object({}),
    outputSchema: z.object({ space: z.unknown() }),
    execute: async () => {
      const ctx = signal ? apiUtils.toContext(signal) : undefined;
      const space = await client.genie.getSpace({ space_id: spaceId }, ctx);
      return { space };
    },
  });
}

/* --------------------------- inner agent --------------------------- */

const AGENT_INSTRUCTIONS = stringUtils.toDescription`
  You orchestrate a Databricks Genie space. For every user
  question:

    1. Optionally call \`get_space_description\` to ground; reach
       for \`get_space_serialized\` only when you need exact
       column / table names the description doesn't expose.
    2. Decompose the question into focused sub-questions (one per
       distinct metric / dimension / time window) and call
       \`ask_genie\` once per sub-question. Two to six calls is
       typical for a non-trivial question; one call is fine when
       the question is genuinely atomic.
    3. Each \`ask_genie\` call returns the terminal
       \`GenieMessage\`. When the turn ran SQL it also returns
       \`query_result_data\` - the actual rows. The matching
       \`statement_id\` is on
       \`message.query_result.statement_id\` (or the first
       attachment's \`query.statement_id\`). You will reference
       that exact id in your final \`data\` blocks.
    4. Produce a final structured summary as an ordered array
       interleaving \`text\` paragraphs with \`data\` blocks.
       INTERLEAVE: prose first, then the \`data\` block it
       interprets, then the next prose / data pair. Never dump
       all data at the end.
    5. For every \`data\` block, supply the exact
       \`statement_id\` you saw on the \`ask_genie\` response. A
       short \`description\` ("compare quarterly revenue across
       regions", "highlight the steep drop after position 5")
       biases the chart-planner's choice of visual. Do NOT pick
       chart types or axis labels - the host wraps each \`data\`
       block in a chart automatically.
    6. Each \`data\` block should be followed by a short
       \`text\` interpretation (deltas, anomalies, takeaways).
       Don't paraphrase numbers the visualization will already
       show. Skip openers / closers. Plain prose, hyphens (not em
       / en dashes), no emojis.
`;

/**
 * Boundary schema for the inner agent's structured output. Two
 * tagged shapes only - text or data. The wrapper maps these onto
 * the shared {@link GenieSummaryItem} (`string` / `visualize`)
 * after charting; we don't redefine GenieSummaryItem here.
 */
const agentSummarySchema = z.object({
  summary: z.array(
    z.discriminatedUnion("type", [
      z.object({
        type: z.literal("text"),
        text: z.string(),
      }),
      z.object({
        type: z.literal("data"),
        statementId: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
      }),
    ]),
  ),
});

type AgentSummaryItem = z.infer<typeof agentSummarySchema>["summary"][number];

/* ----------------------------- factory ----------------------------- */

/**
 * Options for {@link createGenieTool}. Only carries config that
 * doesn't vary per request - the per-request {@link WorkspaceClient},
 * `RequestContext`, writer, and abort signal flow through the
 * tool's `execute(_, ctx)` and are not captured here.
 */
export interface CreateGenieToolOptions {
  /** Genie space id this tool targets. */
  spaceId: string;
  /** Plugin config; resolves the LLM and chart planner agent. */
  config: MastraPluginConfig;
  /** Override the registered tool id. Defaults to `"genie"`. */
  toolId?: string;
  /** Override the tool description shown to the calling LLM. */
  toolDescription?: string;
  /**
   * Override the inner agent's max tool-loop steps. Defaults to
   * {@link DEFAULT_MAX_STEPS}.
   */
  maxSteps?: number;
}

/**
 * Build the calling agent's Genie tool. The returned Mastra tool
 * runs end-to-end on each invocation:
 *
 *   1. Pull the per-request `WorkspaceClient` off
 *      `ctx.requestContext` (stamped by `MastraServer` under
 *      {@link MASTRA_USER_KEY}) and emit a `started` writer
 *      event so the host UI shows progress immediately.
 *   2. Spin up the inner Mastra agent + three tools, fresh per
 *      call so the row cache stays invocation-scoped.
 *   3. Run the agent with `structuredOutput` against
 *      {@link agentSummarySchema}. Mastra's two-pass design keeps
 *      the inner loop tools-only (no `response_format`), so the
 *      Databricks Model Serving `response_format`+`tools`
 *      collision never fires.
 *   4. Walk the returned `[text|data][]`, map `text` items to
 *      shared `GenieSummaryItem.string`, and chart every `data`
 *      item in parallel via {@link runChartPlanner} to a
 *      `GenieSummaryItem.visualize`. Items referencing a missing
 *      `statementId` are dropped with a warn log; chart-planner
 *      failures leave `dataset.chart` unset so the host UI falls
 *      back to a table.
 */
export function createGenieTool(opts: CreateGenieToolOptions) {
  const {
    spaceId,
    config,
    toolId = "genie",
    toolDescription = stringUtils.toDescription`
      Ask a question about the Databricks Genie space.

      Returns \`{ summary: SummaryItem[] }\` where each item is
      one of:

      - \`{ type: "string", text }\` - prose to weave into your
        reply verbatim or paraphrase.
      - \`{ type: "visualize", statementId, title?, description?,
        dataset: { data: { columns, rows, rowCount },
        chart?: { chartId, chartType } } }\` - a chartable result
        set. When \`dataset.chart\` is present the chart is ALREADY
        rendered and queued for inline display; embed the marker
        \`[[chart:<chartId>]]\` on its own line at the position
        you want it to appear and the host UI drops the rendered
        chart in. Re-use the chartId verbatim - do NOT call
        \`render_data\` for the same dataset (it would render the
        same chart a second time and stall your stream). Only
        fall back to \`render_data\` when \`dataset.chart\` is
        missing (chart-planner failed) AND you genuinely need a
        picture; otherwise present the data inline as prose or a
        short table.
    `,
    maxSteps = DEFAULT_MAX_STEPS,
  } = opts;

  return createTool({
    id: toolId,
    description: toolDescription,
    inputSchema: z.object({
      question: z.string().describe(stringUtils.toDescription`
        Natural-language question about the data in this Genie
        space. Phrase it from the user's perspective; the agent
        decomposes it internally.
      `),
    }),
    outputSchema: z.custom<GenieAgentResult>(),
    execute: async (input, ctxRaw) => {
      const ctx = ctxRaw as
        | {
            requestContext?: RequestContext;
            writer?: MinimalWriter;
            abortSignal?: AbortSignal;
          }
        | undefined;
      const requestContext = ctx?.requestContext;
      if (!requestContext) {
        throw new Error(
          "genie: missing requestContext (MastraServer must stamp MASTRA_USER_KEY)",
        );
      }
      const user = requestContext.get(MASTRA_USER_KEY) as User | undefined;
      if (!user) {
        throw new Error("genie: no user on requestContext (MASTRA_USER_KEY not set)");
      }
      const client = user.executionContext.client;
      const writer = ctx?.writer;
      const signal = ctx?.abortSignal;
      const threadId = requestContext.get(MASTRA_THREAD_ID_KEY) as string | undefined;

      // Fire the lifecycle `started` event before any LLM /
      // network round-trip so the host UI can pop a "Thinking..."
      // pill the instant the model decides to delegate. The wire
      // `conversation_id` / `message_id` aren't known yet (no
      // Genie call has been made) and ride as `undefined` -
      // subscribers that need them watch the later
      // `message` / `result` wire events for the real ids.
      const startedEvent: StartedEvent = {
        type: "started",
        spaceId,
        content: input.question,
      };
      await safeWrite(writer, startedEvent);

      const resultSets = new Map<string, StatementEntry>();

      // Seed the active Genie `conversation_id` onto
      // `RequestContext` from AppKit's `CacheManager` when a Mastra
      // `threadId` is present so multi-turn chats reuse the same
      // Genie conversation (and Genie's accumulated context) across
      // separate tool invocations. The same `RequestContext` flows
      // to the inner `ask_genie` tool via Mastra, which reads and
      // updates the same slot as Genie hands out / rotates ids.
      // Cache misses, threads without memory, and unhealthy cache
      // storage all leave the slot unset, which makes `ask_genie`
      // call `startConversation` and mint a fresh id (then cache
      // it).
      const cacheKey = await conversationCacheKey(spaceId, threadId);
      const cachedConversationId = await readCachedConversationId(cacheKey);
      if (cachedConversationId) {
        writeContextConversationId(requestContext, spaceId, cachedConversationId);
      }

      const innerDeps: InnerToolDeps = {
        spaceId,
        client,
        ...(writer ? { writer } : {}),
        ...(signal ? { signal } : {}),
        resultSets,
        ...(cacheKey ? { cacheKey } : {}),
      };
      const tools = {
        ask_genie: buildAskGenieTool(innerDeps),
        get_space_description: buildSpaceDescriptionTool({
          spaceId,
          client,
          ...(signal ? { signal } : {}),
        }),
        get_space_serialized: buildSpaceSerializedTool({
          spaceId,
          client,
          ...(signal ? { signal } : {}),
        }),
      };

      // Resolve the model config once for this request so we can
      // share it with the structuring pass below. The agent's
      // `model` field accepts a function form for per-request
      // resolution, but `structuredOutput.model` requires a
      // static `MastraModelConfig`, and we need both to be on
      // the same Databricks endpoint with the same OBO-scoped
      // headers. Calling `buildModel` here (inside `execute`)
      // keeps user scoping correct because `requestContext`
      // already reflects the active request's user.
      const resolvedModel = await buildModel(config, requestContext);

      const agent = new Agent({
        id: `genie__${spaceId}`,
        name: `Genie (${spaceId})`,
        description: stringUtils.toDescription`
          Inner orchestrator for the "${spaceId}" Genie space.
          Asks Genie one focused sub-question at a time and
          returns an interleaved [text|data] summary.
        `,
        instructions: AGENT_INSTRUCTIONS,
        model: resolvedModel,
        tools,
      });

      // Mastra's `structuredOutput` operates in one of two modes
      // based on whether `model` is set:
      //   - "direct"    (no model)     -> the schema is enforced
      //                                   in the SAME LLM call as
      //                                   the agent loop, by
      //                                   adding `response_format`
      //                                   alongside `tools`.
      //                                   Databricks Model Serving
      //                                   rejects that combination
      //                                   with `INVALID_PARAMETER_VALUE:
      //                                   Cannot specify both
      //                                   response_format and tools
      //                                   in the same request.`
      //   - "processor" (model passed) -> the main loop carries
      //                                   tools and NO
      //                                   `response_format`; a
      //                                   separate, tool-free
      //                                   structuring agent
      //                                   re-prompts the model
      //                                   with `response_format`
      //                                   to coerce the agent's
      //                                   final text into the
      //                                   schema.
      // We use "processor" mode but ALSO set
      // `jsonPromptInjection: true`. Mastra's structuring agent
      // calls `.stream(...)` under the hood, and Databricks Model
      // Serving rejects `response_format` together with streaming
      // (`INVALID_PARAMETER_VALUE: Structured output is not
      // currently supported with streaming.`). Prompt injection
      // sidesteps that by embedding the JSON Schema in the
      // structuring agent's system prompt instead of sending
      // `response_format`. `errorStrategy: "warn"` keeps a
      // structuring failure from escaping as an unhandled
      // promise rejection: it logs and leaves `result.object`
      // undefined, which we surface as a clean error in
      // {@link GenieAgentResult}.
      const agentResult = await agent.generate(input.question, {
        requestContext,
        maxSteps,
        structuredOutput: {
          schema: agentSummarySchema,
          model: resolvedModel,
          jsonPromptInjection: true,
          errorStrategy: "warn",
        },
        ...(signal ? { abortSignal: signal } : {}),
      });
      const submission = agentResult.object;
      if (!submission) {
        const message = "Genie agent returned no structured summary";
        log.warn("agent:no-summary", { spaceId });
        const finalConversationId = readContextConversationId(requestContext, spaceId);
        return {
          spaceId,
          summary: [],
          ...(finalConversationId ? { conversationId: finalConversationId } : {}),
          error: message,
        } satisfies GenieAgentResult;
      }

      // Lifecycle hook: the agent + structuring pass are done.
      // Emit one `summary` event with the structured-item counts
      // so the host UI can transition from "thinking" to
      // "charting" and seed N chart skeletons before the
      // per-chart `chart` events arrive. We can't fire this
      // EARLIER (i.e. when the structuring pass starts) because
      // Mastra runs the inner loop + structuring pass together
      // inside `agent.generate(...)` with no observable boundary
      // between them.
      const textItemCount = submission.summary.filter(
        (i: AgentSummaryItem) => i.type === "text",
      ).length;
      const dataItemCount = submission.summary.length - textItemCount;
      const summaryEvent: SummaryEvent = {
        type: "summary",
        spaceId,
        items: submission.summary.length,
        textItems: textItemCount,
        dataItems: dataItemCount,
      };
      await safeWrite(writer, summaryEvent);

      // Chart every `data` item in parallel; map `text` items to
      // the shared `string` summary variant verbatim. Missing
      // statement ids are dropped (the agent referenced something
      // that never came back from `ask_genie`), planner failures
      // leave `dataset.chart` unset so the host UI falls back to
      // a table render. Each successfully planned chart pushes a
      // `chart` writer event so the UI can fade in the rendered
      // chart slot the moment its planner returns rather than
      // waiting for the entire batch to finish.
      const hydrated = await Promise.all(
        submission.summary.map(async (item: AgentSummaryItem): Promise<GenieSummaryItem | undefined> => {
          if (item.type === "text") {
            return { type: "string", text: item.text };
          }
          const entry = resultSets.get(item.statementId);
          if (!entry) {
            log.warn("data:missing-statement", {
              statementId: item.statementId,
            });
            return undefined;
          }
          const { data, messageId } = entry;
          let dataset: GenieDataset = { data };
          try {
            const planned = await runChartPlanner({
              config,
              requestContext,
              title: item.title ?? "Genie result",
              ...(item.description ? { description: item.description } : {}),
              data: data.rows,
              ...(signal ? { signal } : {}),
            });
            const chartId = commonUtils.shortId();
            // Slim chart reference for the LLM-bound result: just
            // `chartId` + `chartType`. The full Echarts spec goes
            // to the UI via the writer event AND into the
            // request-scoped chart inventory below; the model
            // only needs the id to place `[[chart:<id>]]`.
            dataset = {
              data,
              chart: {
                chartId,
                chartType: planned.chartType,
              },
            };
            const chartEvent: ChartEvent = {
              type: "chart",
              chartId,
              statementId: item.statementId,
              messageId,
              ...(item.title ? { title: item.title } : {}),
              ...(item.description ? { description: item.description } : {}),
              data: data.rows,
              option: planned.option,
            };
            await safeWrite(writer, chartEvent);
            // Stash the resolved chart on the per-request
            // `RequestContext` so downstream code in the same
            // request (output processors, follow-up tool calls,
            // any post-run hook) can look up the full spec by
            // `chartId` without re-fetching or re-planning.
            recordChartInContext(requestContext, chartEvent);
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            log.warn("chart:error", {
              statementId: item.statementId,
              messageId,
              error: errorMessage,
            });
            // Surface the chart-planner failure as a writer event
            // stamped with the same `messageId` the rest of this
            // ask's wire events carry, so the host UI groups the
            // failure into the same pill bucket and can surface
            // a "couldn't render chart" note next to the table
            // fallback instead of silently dropping the chart.
            const errorEvent: MastraGenieErrorEvent = {
              type: "error",
              spaceId,
              messageId,
              error: `chart-planner: ${errorMessage}`,
            };
            await safeWrite(writer, errorEvent);
          }
          return {
            type: "visualize",
            statementId: item.statementId,
            ...(item.title ? { title: item.title } : {}),
            ...(item.description ? { description: item.description } : {}),
            dataset,
          };
        }),
      );
      const summary = hydrated.filter((x): x is GenieSummaryItem => x !== undefined);

      log.info("genie:done", {
        spaceId,
        items: summary.length,
        statementsCharted: summary.filter(
          (s) => s.type === "visualize" && s.dataset.chart,
        ).length,
      });

      const finalConversationId = readContextConversationId(requestContext, spaceId);
      return {
        spaceId,
        summary,
        ...(finalConversationId ? { conversationId: finalConversationId } : {}),
      } satisfies GenieAgentResult;
    },
  });
}

/* --------------------- multi-alias surface --------------------- */

/**
 * Default tool id for a wired Genie alias. The well-known
 * `default` alias collapses to `genie`; every other alias gets a
 * `genie_` prefix so multi-space registrations stay
 * disambiguated.
 */
export function defaultGenieToolName(alias: string): string {
  if (alias === DEFAULT_GENIE_ALIAS) return "genie";
  return stringUtils.toIdentifierWithOptions({ distinct: true }, "genie", alias);
}

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
 * Build one Mastra tool per configured Genie space. Each tool is
 * a thin {@link createGenieTool} wrapper with the alias-derived
 * id and a hint-flavored description so the calling LLM knows
 * which space covers what data.
 *
 * Returns a record keyed by tool id, ready to spread into an
 * `Agent`'s `tools` map (or surfaced via
 * `plugins.genie?.toolkit()`).
 */
export function buildGenieTools(opts: {
  spaces: GenieSpacesConfig | Record<string, GenieSpaceConfig>;
  config: MastraPluginConfig;
}): MastraTools {
  const normalized = normalizeGenieSpaces(opts.spaces);
  const tools: Record<string, ReturnType<typeof createTool>> = {};
  for (const [alias, space] of Object.entries(normalized)) {
    const id = defaultGenieToolName(alias);
    const toolDescription = stringUtils.toDescription`
      Delegate a natural-language data question to the
      Databricks Genie space "${alias}"${space.hint ? ` (${space.hint})` : ""}.
      Returns an ordered (text | dataset)[] summary the host UI
      renders inline; datasets carry the rows and a
      pre-rendered Echarts spec when the chart-planner
      succeeded. Progress events (status, SQL, row counts,
      charts) stream to the UI automatically.
    `;
    tools[id] = createGenieTool({
      spaceId: space.spaceId,
      config: opts.config,
      toolId: id,
      toolDescription,
    });
  }
  return tools;
}

/**
 * Plugin-toolkit adapter so the `plugins.genie?.toolkit()` lookup
 * inside an agent's `tools(plugins)` callback returns the
 * Genie agent-backed tools instead of throwing on missing plugin.
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

/**
 * Returns `true` when at least one Genie space is reachable
 * through {@link resolveGenieSpaces} - either via
 * {@link MastraPluginConfig.genieSpaces}, the AppKit `genie()`
 * plugin instance, or the `DATABRICKS_GENIE_SPACE_ID` env var.
 *
 * Cheap to call from `resolveProvider` to short-circuit `genie`
 * lookups when nothing is wired, so the `plugins.genie` lookup
 * still resolves to `undefined` (matching AppKit's
 * absent-plugin semantics) when neither source is configured.
 */
export function hasAnyGenieSpaces(
  config: MastraPluginConfig,
  context: appkitUtils.PluginContextLike | undefined,
): boolean {
  return Object.keys(resolveGenieSpaces(config, context)).length > 0;
}
