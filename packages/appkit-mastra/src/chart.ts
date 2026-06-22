/**
 * Chart planner + chart cache.
 *
 * Self-contained chart subsystem with two layers:
 *
 *   1. Inner planner agent (private). Pure dataset-in /
 *      `EChartsOption`-out brain. Driven by {@link prepareChart};
 *      callers never instantiate it directly.
 *   2. {@link prepareChart}: orchestration on top of the planner.
 *      Mints a `chartId`, caches an empty `{ chartId }` record
 *      synchronously, then resolves the dataset and runs the
 *      planner in the background. The terminal entry settles with
 *      either `result` (success) or `error` (failure). Both
 *      undefined means the entry is still processing.
 *
 * The cache surface ({@link fetchChart}) is the only state the
 * HTTP route and the chart-producing tools share. `prepareChart`
 * is dataset-agnostic - callers supply a `resolveData` callback
 * that fetches the rows however they like (Genie statement, inline
 * dataset, custom API). The module has no knowledge of Genie or
 * statement ids; those concerns live in the tools that wrap it.
 *
 * Wire-format schemas live in `@dbx-tools/appkit-mastra-shared` so
 * the demo client and any other UI consumer share the exact same
 * shape this module reads and writes.
 */

import { CacheManager } from "@databricks/appkit";
import {
  ChartSchema,
  ChartTypeSchema,
  type Chart,
  type ChartResult,
} from "@dbx-tools/appkit-mastra-shared";
import { commonUtils, logUtils, stringUtils } from "@dbx-tools/shared";
import { Agent } from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import type { MastraPluginConfig } from "./config.js";
import { buildModel, ModelTier } from "./model.js";

const log = logUtils.logger("mastra/chart");

/* ------------------------------ constants ------------------------------ */

/**
 * TTL for cached chart entries. One hour balances "long enough for
 * the host UI to fetch the chart well after the model finished
 * talking" against "short enough that abandoned chart ids don't
 * pin storage". Matches the typical Databricks OBO token lifetime
 * so any data re-resolution stays inside the original auth window.
 */
const CHART_CACHE_TTL_SEC = 60 * 60;

/** Cache namespace; keeps the chart keyspace tidy. */
const CHART_CACHE_NAMESPACE = "mastra:chart";

/**
 * `userKey` for `CacheManager.generateKey`. Chart ids are minted
 * via `commonUtils.id()` (v4 UUID) and are unguessable, so a
 * constant user key is fine. The HTTP route can re-scope to the
 * requesting user when policy demands it.
 */
const CHART_CACHE_USER_KEY = "mastra-chart";

/** Default server-side long-poll budget for {@link fetchChart}. */
const DEFAULT_FETCH_TIMEOUT_MS = 60_000;

/** Default inter-poll sleep for {@link fetchChart}. */
const DEFAULT_FETCH_INTERVAL_MS = 250;

/* ------------------------------- schemas ------------------------------- */

/**
 * One series data point. Wide variant set so the planner agent can
 * faithfully pass through whatever the SQL row set contained
 * (numbers, stringified numbers, nulls for missing measurements,
 * `[x, y]` tuples for scatter, `{name, value}` slices for pie)
 * without the structured-output guard rejecting the whole plan.
 *
 * Three layers of tolerance:
 *
 *   1. {@link z.preprocess} normalizes wire shapes BEFORE union
 *      dispatch: stringified numbers parse to numbers, finite
 *      checks reject `NaN` / `Infinity`, 2-element arrays coerce
 *      tuple components, and `{value}` objects with missing /
 *      stringified `value` get coerced or rejected uniformly.
 *      Anything not handleable becomes `null`.
 *   2. The union accepts `null` as a first-class variant. Echarts
 *      renders null as a gap on bar / line / area (which is the
 *      right visual signal for "missing reading"). Scatter and
 *      pie filter nulls in {@link planToEchartsOption} because
 *      Echarts crashes on null tuples / slices.
 *   3. {@link z.union#catch} backstops the whole thing: if
 *      preprocess somehow produces a shape that still doesn't
 *      match any variant, the bad item becomes `null` instead of
 *      taking down the entire chart with a
 *      `Structured output validation failed` error.
 */
const chartDataPointSchema = z
  .preprocess(
    (v) => {
      if (v === null || v === undefined) return null;
      if (typeof v === "number") return Number.isFinite(v) ? v : null;
      if (typeof v === "string") {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      }
      if (Array.isArray(v) && v.length === 2) {
        const x = typeof v[0] === "number" ? v[0] : Number(v[0]);
        const y = typeof v[1] === "number" ? v[1] : Number(v[1]);
        return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
      }
      if (typeof v === "object" && v !== null && "value" in v) {
        const obj = v as { name?: unknown; value: unknown };
        const val = typeof obj.value === "number" ? obj.value : Number(obj.value);
        if (!Number.isFinite(val)) return null;
        // Coerce numeric / boolean / nullish names to strings so a
        // pie slice keyed on a year (`2024`) or category id is
        // accepted without round-tripping through the catch arm.
        const rawName = obj.name;
        const name =
          typeof rawName === "string"
            ? rawName
            : rawName == null
              ? ""
              : String(rawName);
        return { name, value: val };
      }
      return null;
    },
    z.union([
      z.number(),
      z.null(),
      z.tuple([z.number(), z.number()]),
      z.object({ name: z.string(), value: z.number() }),
    ]),
  )
  .catch(null);

/**
 * Compact, model-friendly representation of an Echarts spec. The
 * planner agent emits this; {@link planToEchartsOption} expands it
 * into a real `EChartsOption` JSON. Two layers because letting the
 * model fill in a fully-typed `EChartsOption` is brittle (hundreds
 * of optional fields, deep unions, version-dependent shapes). A
 * small "chart plan" schema is much more reliable for a fast model
 * and keeps animation / tooltip / styling defaults consistent
 * across charts.
 */
const chartPlanSchema = z.object({
  chartType: ChartTypeSchema,
  title: z
    .string()
    .optional()
    .describe(
      stringUtils.toDescription(`
        Short title shown above the chart. Optional; defaults to the
        \`title\` argument the caller passed in.
      `),
    ),
  xAxisLabel: z
    .string()
    .optional()
    .describe(
      stringUtils.toDescription(`
        Axis label below the chart. Used for bar / line / area / scatter;
        ignored for pie.
      `),
    ),
  yAxisLabel: z
    .string()
    .optional()
    .describe(
      stringUtils.toDescription(`
        Axis label to the left of the chart. Used for bar / line / area /
        scatter; ignored for pie.
      `),
    ),
  categories: z
    .array(z.string())
    .optional()
    .describe(
      stringUtils.toDescription(`
        X-axis category labels for \`bar\` / \`line\` / \`area\` charts
        (one per data point in each series). Omit for \`scatter\` (uses
        [x, y] tuples) and \`pie\` (each slice carries its own \`name\`).
      `),
    ),
  series: z
    .array(
      z.object({
        name: z.string().describe(
          stringUtils.toDescription(`
            Legend name for this series.
          `),
        ),
        data: z.array(chartDataPointSchema).describe(
          stringUtils.toDescription(`
            Data points. For \`bar\` / \`line\` / \`area\`, an array of
            numbers aligned to \`categories\`. For \`scatter\`, an array
            of \`[x, y]\` numeric tuples. For \`pie\`, an array of
            \`{name, value}\` objects.
          `),
        ),
      }),
    )
    .min(1)
    .describe(
      stringUtils.toDescription(`
        One or more series to plot. Pie charts use exactly one series;
        bar/line/area can stack multiple series sharing the same
        \`categories\` axis.
      `),
    ),
});

type ChartPlan = z.infer<typeof chartPlanSchema>;

/**
 * Canonical planner input shape. Tools that source rows from an
 * inline dataset (`render_data`) use it as their `inputSchema`
 * verbatim; tools that resolve rows from a remote (`prepare_chart`
 * over a Genie statement) `omit({ data })` and `extend` with their
 * own identifier field, so the field-level `.describe()` text
 * stays a single source of truth. Server-only - the UI never
 * sees a planner request, only the resolved {@link Chart}.
 */
export const chartPlannerRequestSchema = z.object({
  title: z.string().describe(
    stringUtils.toDescription(`
        Concise title shown above the chart (e.g. "Top 10 SKUs by Revenue").
      `),
  ),
  description: z
    .string()
    .optional()
    .describe(
      stringUtils.toDescription(`
        One-line intent the chart-planner uses when picking a chart type
        and axis encodings (e.g. "compare quarterly revenue across
        regions", "highlight the steep drop after position 5"). Not shown
        to the user.
      `),
    ),
  data: z
    .array(z.record(z.string(), z.unknown()))
    .nonempty("Data must contain at least one row")
    .readonly()
    .describe(
      stringUtils.toDescription(`
        Tabular dataset to chart. One object per row, keyed by column
        name. Values may be strings, numbers, booleans, or null. The
        chart-planner decides which columns are categories vs. numeric
        series. Cap at a few hundred rows for legibility; sample /
        aggregate larger datasets first.
      `),
    ),
});

export type ChartPlannerRequest = z.infer<typeof chartPlannerRequestSchema>;

/* --------------------------- planner instructions --------------------------- */

/**
 * Format {@link ChartTypeSchema}'s variants as a single
 * human-friendly string of `` `<value>` for <description> ``
 * clauses joined by semicolons, drawn from each variant's own
 * `.describe()` so the planner prompt stays in lock-step with
 * the schema by construction.
 */
function formatChartTypePicker(): string {
  return ChartTypeSchema.options
    .map((opt) => `\`${opt.value}\` for ${opt.description ?? ""}`)
    .join("; ");
}

/**
 * System prompt for the inner chart-planning agent. Tuned for a
 * fast-tier model (Haiku, GPT-5-mini, Gemini Flash Lite).
 */
const CHART_PLANNER_INSTRUCTIONS = stringUtils.toDescription(`
  You design Apache Echarts visualizations. The user gives you a
  tabular dataset (rows of objects) plus a title and an optional
  description of the intent. You produce a small chart plan (chart
  type, axis labels, categories, series) that best conveys the data.

  Decision guide. Pick the chart type whose data shape matches the
  dataset and the user's intent: ${formatChartTypePicker()}.

  When in doubt between bar and line, prefer bar for unordered
  categories and line for ordered ones (dates, time buckets, ranks).
  Never pick pie for more than 7 slices.

  For bar / line / area: pick one column as the category axis (usually
  the only string-valued column) and one or more numeric columns as
  series. Sort categories by the primary series value descending unless
  the data is naturally ordered (dates, ranks).

  For pie: pick the category column for slice names and one numeric
  column for slice values. Emit a single series.

  For scatter: pick two numeric columns and emit \`[x, y]\` tuples in a
  single series.

  Keep series names human-readable (use the column name; title case it
  lightly if needed). Keep titles concise; do not repeat the user's
  title in xAxisLabel / yAxisLabel.
`);

/* ----------------------------- planner agent ----------------------------- */

/**
 * One planner `Agent` per plugin config. Cached on config object
 * identity so callers can `prepareChart({ config, ... })` from a
 * hot path without paying the Agent-constructor cost every call.
 * `WeakMap` lets retired configs (e.g. test reconfigurations)
 * release their agent without manual eviction.
 */
const plannerAgents = new WeakMap<MastraPluginConfig, Agent>();

function getPlannerAgent(config: MastraPluginConfig): Agent {
  let agent = plannerAgents.get(config);
  if (!agent) {
    agent = new Agent({
      id: "chart_planner",
      name: "Chart Planner",
      description: "Picks chart type and axis encodings for a dataset.",
      instructions: CHART_PLANNER_INSTRUCTIONS,
      model: ({ requestContext }) =>
        buildModel(config, requestContext, { tier: ModelTier.Fast }),
    });
    plannerAgents.set(config, agent);
  }
  return agent;
}

/**
 * Run the planner against `request` and return the resolved
 * Echarts spec. Throws on planner failure - {@link prepareChart}
 * catches and stashes the error in the cache entry.
 */
async function runChartPlanner(
  config: MastraPluginConfig,
  request: ChartPlannerRequest,
  options: { requestContext?: RequestContext; abortSignal?: AbortSignal } = {},
): Promise<ChartResult> {
  const { title, description, data } = request;
  const { requestContext, abortSignal } = options;
  const prompt = stringUtils.toDescription({
    Title: title,
    ...(description ? { Description: description } : {}),
    "Dataset (JSON, one row per object)": JSON.stringify(data, null, 2),
  });
  const result = await getPlannerAgent(config).generate(prompt, {
    structuredOutput: { schema: chartPlanSchema },
    ...(requestContext ? { requestContext } : {}),
    ...(abortSignal ? { abortSignal } : {}),
  });
  const plan = chartPlanSchema.parse(result.object);
  const option = planToEchartsOption(plan, title);
  return { chartType: plan.chartType, option };
}

/* ------------------------------ cache helpers ------------------------------ */

/** Build the canonical cache key for a `chartId`. */
async function chartCacheKey(chartId: string): Promise<string> {
  return (await CacheManager.getInstance()).generateKey(
    [CHART_CACHE_NAMESPACE, chartId],
    CHART_CACHE_USER_KEY,
  );
}

/**
 * Persist a {@link Chart} entry under its `chartId`. Refreshes
 * the TTL on every write. Cache-layer failures are logged and
 * swallowed so background runners never throw into the
 * unhandled-rejection stream.
 */
async function writeChart(entry: Chart): Promise<void> {
  try {
    const key = await chartCacheKey(entry.chartId);
    await CacheManager.getInstanceSync().set(key, entry, {
      ttl: CHART_CACHE_TTL_SEC,
    });
  } catch (err) {
    log.warn("write-error", {
      chartId: entry.chartId,
      error: commonUtils.errorMessage(err),
    });
  }
}

/**
 * Look up a chart by id. Returns `undefined` on miss, on
 * expiry, or when the cache layer is unhealthy - never throws.
 */
async function readChart(chartId: string): Promise<Chart | undefined> {
  try {
    const key = await chartCacheKey(chartId);
    const v = await CacheManager.getInstanceSync().get<Chart>(key);
    return v ?? undefined;
  } catch (err) {
    log.warn("read-error", {
      chartId,
      error: commonUtils.errorMessage(err),
    });
    return undefined;
  }
}

/* --------------------------- prepareChart orchestrator --------------------------- */

/** Inputs to {@link prepareChart}. */
export interface PrepareChartOptions {
  /** Plugin config; resolves the planner agent's model. */
  config: MastraPluginConfig;
  /** Display title forwarded to the planner agent. */
  title?: string;
  /** Optional intent hint forwarded to the planner agent. */
  description?: string;
  /**
   * Resolves the rows to chart. Called once, in the background.
   * Any thrown error lands in the cache as the entry's `error`
   * field (never propagated to the caller of {@link prepareChart}).
   * An empty `rows` array is rejected as `"dataset has no rows;
   * nothing to chart"`.
   */
  resolveData: (
    signal?: AbortSignal,
  ) => Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;
  /**
   * Per-request `RequestContext`. Forwarded to the planner agent so
   * user-scoped model resolution (OBO) stays in effect.
   */
  requestContext?: RequestContext;
  /**
   * Cooperative cancellation. Forwarded to `resolveData` and the
   * planner agent. Note: the chart task continues running in the
   * background after the parent request ends, so external abort
   * signals are best-effort; typical use is to leave this unset
   * and let the 1h TTL cap stale entries.
   */
  signal?: AbortSignal;
}

/**
 * Mint a `chartId`, cache an empty `{ chartId }` placeholder
 * synchronously, and kick off a background task that resolves the
 * dataset and runs the planner. Returns the `chartId` once the
 * placeholder lands so the first {@link fetchChart} call always
 * sees an entry (no spurious 404 race).
 *
 * The background task swallows its own failures and writes them
 * as `error` entries, so callers never see a rejected promise.
 * Cache state machine:
 *
 *   - just after this call returns: `{ chartId }` (processing)
 *   - on planner success:           `{ chartId, result }`
 *   - on data / planner failure:    `{ chartId, error }`
 */
export async function prepareChart(
  opts: PrepareChartOptions,
): Promise<{ chartId: string }> {
  const chartId = commonUtils.id();
  await writeChart({ chartId });
  log.debug("queued", { chartId });
  // Fire-and-forget. Failures land in the cache as `error` entries;
  // never escape into an unhandled rejection.
  void runPrepareChart(chartId, opts);
  return { chartId };
}

async function runPrepareChart(
  chartId: string,
  opts: PrepareChartOptions,
): Promise<void> {
  const startedAt = Date.now();
  try {
    const data = await opts.resolveData(opts.signal);
    if (data.rows.length === 0) {
      throw new Error("dataset has no rows; nothing to chart");
    }
    const result = await runChartPlanner(
      opts.config,
      {
        title: opts.title ?? "Chart",
        ...(opts.description ? { description: opts.description } : {}),
        data: data.rows as ChartPlannerRequest["data"],
      },
      {
        ...(opts.requestContext ? { requestContext: opts.requestContext } : {}),
        ...(opts.signal ? { abortSignal: opts.signal } : {}),
      },
    );
    await writeChart({ chartId, result });
    log.info("done", {
      chartId,
      chartType: result.chartType,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (err) {
    const error = commonUtils.errorMessage(err);
    log.warn("error", { chartId, error });
    await writeChart({ chartId, error });
  }
}

/* ------------------------------- long-poll fetch ------------------------------- */

/** Inputs to {@link fetchChart}. */
export interface FetchChartOptions {
  /**
   * Server-side polling budget in ms. When the entry stays in
   * the processing state past this window, the helper returns the
   * last seen value (still processing) so the client can re-poll.
   * Defaults to {@link DEFAULT_FETCH_TIMEOUT_MS} (60s).
   */
  timeoutMs?: number;
  /**
   * Poll interval in ms. Defaults to
   * {@link DEFAULT_FETCH_INTERVAL_MS} (250ms).
   */
  intervalMs?: number;
  /** External cancellation handle (e.g. request `req.signal`). */
  signal?: AbortSignal;
}

/**
 * Long-poll the chart cache until the entry settles (`result` or
 * `error` set), the entry is missing, or the server-side timeout
 * elapses.
 *
 * Returns:
 *   - the resolved {@link Chart} when it settled, errored, or
 *     stayed in processing past `timeoutMs` (so the client can
 *     re-poll);
 *   - `undefined` when the entry is missing or expired (the
 *     consumer should treat as 404).
 *
 * `signal` lets the caller cancel ahead of timeout (e.g. the HTTP
 * request closed). Cancellation propagates to the inter-poll sleep
 * so the helper returns immediately.
 */
export async function fetchChart(
  chartId: string,
  options: FetchChartOptions = {},
): Promise<Chart | undefined> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_FETCH_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  let last: Chart | undefined;
  while (true) {
    options.signal?.throwIfAborted();
    last = await readChart(chartId);
    if (!last) return undefined;
    if (last.result !== undefined || last.error !== undefined) return last;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return last;
    await commonUtils.sleep(Math.min(intervalMs, remaining), options.signal);
  }
}

/* ----------------------------- echarts expansion ----------------------------- */

/**
 * Expand a {@link ChartPlan} into a full Echarts `EChartsOption`
 * JSON. Centralized here so the planner agent only fills in the
 * compact plan shape; tooltip / animation / color / grid defaults
 * stay consistent across charts and are easy to tune without
 * retraining model behaviour.
 */
function planToEchartsOption(
  plan: ChartPlan,
  fallbackTitle: string,
): Record<string, unknown> {
  const baseTitle = plan.title ?? fallbackTitle;
  const grid = { left: 48, right: 24, top: 56, bottom: 48, containLabel: true };

  if (plan.chartType === "pie") {
    // Echarts crashes on null pie slices - filter them out.
    // `{name, value}` slices are the only valid pie data shape,
    // so drop bare numbers / tuples / nulls the planner may
    // have leaked into a pie series.
    const slices = (plan.series[0]?.data ?? []).filter(
      (d): d is { name: string; value: number } =>
        d !== null && typeof d === "object" && !Array.isArray(d),
    );
    return {
      title: { text: baseTitle, left: "center" },
      tooltip: { trigger: "item" },
      legend: { bottom: 0 },
      series: [
        {
          name: plan.series[0]?.name ?? baseTitle,
          type: "pie",
          radius: ["35%", "65%"],
          data: slices,
        },
      ],
    };
  }

  if (plan.chartType === "scatter") {
    // Echarts crashes on null scatter points - keep only valid
    // `[x, y]` tuples. Bare numbers / objects / nulls from a
    // mismatched plan get dropped silently.
    return {
      title: { text: baseTitle, left: "center" },
      tooltip: { trigger: "item" },
      legend: { bottom: 0 },
      grid,
      xAxis: { type: "value", name: plan.xAxisLabel },
      yAxis: { type: "value", name: plan.yAxisLabel },
      series: plan.series.map((s) => ({
        name: s.name,
        type: "scatter",
        data: s.data.filter(
          (d): d is [number, number] => Array.isArray(d) && d.length === 2,
        ),
      })),
    };
  }

  // bar / line / area share the same axis layout.
  const isArea = plan.chartType === "area";
  const seriesType = plan.chartType === "bar" ? "bar" : "line";
  return {
    title: { text: baseTitle, left: "center" },
    tooltip: { trigger: "axis" },
    legend: { bottom: 0 },
    grid,
    xAxis: {
      type: "category",
      data: plan.categories ?? [],
      name: plan.xAxisLabel,
    },
    yAxis: { type: "value", name: plan.yAxisLabel },
    series: plan.series.map((s) => ({
      name: s.name,
      type: seriesType,
      data: s.data,
      smooth: seriesType === "line",
      ...(isArea ? { areaStyle: {} } : {}),
    })),
  };
}

/* ----------------------------- render_data tool ----------------------------- */

/**
 * Build the `render_data` Mastra tool bound to the given plugin
 * config. Auto-wired as a system tool on every agent (see
 * `agents.ts`); per-agent tools can shadow it by registering a
 * same-named entry.
 *
 * Thin wrapper over {@link prepareChart} for callers that already
 * have a dataset in hand. Mints a `chartId` synchronously, caches
 * an empty placeholder, and kicks off the chart-planner in the
 * background. Returns just the `chartId`; the host UI resolves
 * `[chart:<chartId>]` markers by hitting the plugin's
 * `/embed/chart/:id` route.
 *
 * For Genie statement results, prefer the Genie agent's
 * `prepare_chart` tool, which accepts a `statement_id` and
 * resolves the rows lazily.
 */
export function buildRenderDataTool(config: MastraPluginConfig) {
  return createTool({
    id: "render_data",
    description: stringUtils.toDescription([
      `
        Submit a tabular dataset for inline rendering as a chart in
        the user's view. Pass a title, the raw rows (array of objects
        keyed by column name), and an optional one-line description
        of the insight to highlight. Returns a short \`chartId\`;
        the chart renders inline at the position you embed the
        matching \`[chart:<chartId>]\` marker.
      `,
      `
        Placement contract: embed \`[chart:<chartId>]\` on its own
        line (blank lines above and below) wherever you want the
        chart to appear in your reply. The chart resolves
        asynchronously - the tool returns the id immediately and the
        host UI fetches the chart from the cache once the planner
        lands. You can call \`render_data\` multiple times in the
        same turn (the tool is parallel-safe) and interleave the
        markers with prose so each chart sits next to its
        commentary.
      `,
      `
        Use whenever a SQL row set, API response, or hand-built
        dataset would land better as a picture than as a list or
        table. Cap input at a few hundred rows; sample or aggregate
        larger datasets first.
      `,
    ]),
    inputSchema: chartPlannerRequestSchema,
    outputSchema: ChartSchema.pick({ chartId: true }),
    execute: async (input, ctxRaw) => {
      const { title, description, data } = input as ChartPlannerRequest;
      const ctx = ctxRaw as { requestContext?: RequestContext } | undefined;
      return prepareChart({
        config,
        title,
        ...(description ? { description } : {}),
        resolveData: () => Promise.resolve({ rows: data }),
        ...(ctx?.requestContext ? { requestContext: ctx.requestContext } : {}),
      });
    },
  });
}
