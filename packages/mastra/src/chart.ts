/**
 * Chart-rendering primitives.
 *
 * Two surfaces, one shared brain:
 *
 * - {@link buildRenderDataTool}: a Mastra tool the model calls
 *   ("here is a dataset, render it as a chart"). The tool is
 *   fire-and-forget by design - it generates a short `chartId`,
 *   pushes a single `kind: "chart"` event onto `ctx.writer` carrying
 *   the raw rows, and returns the id to the model immediately. No
 *   chart planning happens inside the agentic loop, so the model
 *   never blocks on a downstream LLM call to get its identifier.
 *
 * - {@link runChartPlanner}: the chart-planner Agent + ECOption
 *   expansion as a plain async function. Used internally by
 *   {@link emitChartWithPlanning} (which is what the
 *   `render_data` tool and Genie's `drainGenieStream` both call);
 *   producers shouldn't reach for it directly so chart events
 *   keep a single wire-format contract.
 *
 * The model wires the chart into its reply by emitting the marker
 * `[[chart:<chartId>]]` on its own line in markdown. The chat
 * client splits the assistant text on these markers and drops a
 * `<ChartSlot>` in at the position the model placed it; the slot
 * then fires the render-chart endpoint on mount and shows a
 * skeleton until the option lands.
 */

import { randomUUID } from "node:crypto";

import { logUtils, stringUtils } from "@dbx-tools/appkit-shared";
import { Agent } from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import type { MastraPluginConfig } from "./config.js";
import { ModelTier, modelForTier, buildModel } from "./model.js";

/**
 * Module-level logger tagged `[mastra/chart]`. Uses the shared
 * {@link logUtils.logger} so calls below `LOG_LEVEL` are
 * discarded for free. Default `LOG_LEVEL` is `info`; flip to
 * `debug` to see the per-chart timeline (`emit:start` →
 * `write:ok(data)` → `planner:done` → `write:ok(option)`).
 */
const log = logUtils.logger("mastra/chart");

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
  chartType: z
    .enum(["bar", "line", "area", "scatter", "pie"])
    .describe(stringUtils.toDescription`
      The chart shape that best matches the data and intent. Use
      \`bar\` for category-vs-value comparisons, \`line\` for
      trends over an ordered axis, \`area\` for stacked-trend
      emphasis, \`scatter\` for two-numeric-axis correlations,
      \`pie\` for parts-of-a-whole when categories are few.
    `),
  title: z.string().optional().describe(stringUtils.toDescription`
    Short title shown above the chart. Optional; defaults to the
    \`title\` argument the caller passed in.
  `),
  xAxisLabel: z.string().optional().describe(stringUtils.toDescription`
    Axis label below the chart. Used for bar / line / area /
    scatter; ignored for pie.
  `),
  yAxisLabel: z.string().optional().describe(stringUtils.toDescription`
    Axis label to the left of the chart. Used for bar / line /
    area / scatter; ignored for pie.
  `),
  categories: z
    .array(z.string())
    .optional()
    .describe(stringUtils.toDescription`
      X-axis category labels for \`bar\` / \`line\` / \`area\`
      charts (one per data point in each series). Omit for
      \`scatter\` (uses [x, y] tuples) and \`pie\` (each slice
      carries its own \`name\`).
    `),
  series: z
    .array(
      z.object({
        name: z.string().describe(stringUtils.toDescription`
          Legend name for this series.
        `),
        data: z
          .array(
            z.union([
              z.number(),
              z.tuple([z.number(), z.number()]),
              z.object({
                name: z.string(),
                value: z.number(),
              }),
            ]),
          )
          .describe(stringUtils.toDescription`
            Data points. For \`bar\` / \`line\` / \`area\`, an
            array of numbers aligned to \`categories\`. For
            \`scatter\`, an array of \`[x, y]\` numeric tuples.
            For \`pie\`, an array of \`{name, value}\` objects.
          `),
      }),
    )
    .min(1)
    .describe(stringUtils.toDescription`
      One or more series to plot. Pie charts use exactly one
      series; bar/line/area can stack multiple series sharing
      the same \`categories\` axis.
    `),
});

type ChartPlan = z.infer<typeof chartPlanSchema>;

/**
 * System prompt for the inner chart-planning agent. Tuned for a
 * fast-tier model (Haiku, GPT-5-mini, Gemini Flash Lite).
 */
const CHART_PLANNER_INSTRUCTIONS = stringUtils.toDescription`
  You design Apache Echarts visualizations. The user gives you a
  tabular dataset (rows of objects) plus a title and an optional
  description of the intent. You produce a small chart plan
  (chart type, axis labels, categories, series) that best
  conveys the data.

  Decision guide:

  - bar: comparing a numeric value across a small/medium set of
    discrete categories (top-N, ranking, group-by).
  - line: ordered-axis trend (time series, sequence).
  - area: same as line but emphasises magnitude or stacked
    composition.
  - scatter: two numeric axes, correlation between fields.
  - pie: parts of a whole when 2-7 categories sum to a
    meaningful total.

  When in doubt between bar and line, prefer bar for unordered
  categories and line for ordered ones (dates, time buckets,
  ranks). Never pick pie for more than 7 slices.

  For bar / line / area: pick one column as the category axis
  (usually the only string-valued column) and one or more
  numeric columns as series. Sort categories by the primary
  series value descending unless the data is naturally ordered
  (dates, ranks).

  For pie: pick the category column for slice names and one
  numeric column for slice values. Emit a single series.

  For scatter: pick two numeric columns and emit \`[x, y]\`
  tuples in a single series.

  Keep series names human-readable (use the column name; title
  case it lightly if needed). Keep titles concise; do not
  repeat the user's title in xAxisLabel / yAxisLabel.
`;

/**
 * Lazily-constructed inner agent shared across all calls in this
 * process. The agent is stateless (no memory, no tools) so a
 * single instance per plugin config is safe; model resolution
 * still happens per-call against the live `requestContext`, so
 * OBO auth stays user-scoped.
 */
function createChartPlannerAgent(config: MastraPluginConfig): Agent {
  return new Agent({
    id: "render_chart_planner",
    name: "Chart Planner",
    description: "Picks chart type and axis encodings for a dataset.",
    instructions: CHART_PLANNER_INSTRUCTIONS,
    model: ({ requestContext }) =>
      buildModel(config, requestContext, {
        modelId: modelForTier(ModelTier.Fast),
      }),
  });
}

/** Inputs to {@link runChartPlanner}. */
export interface RunChartPlannerOptions {
  config: MastraPluginConfig;
  requestContext?: RequestContext;
  title: string;
  description?: string;
  data: ReadonlyArray<Record<string, unknown>>;
}

/** Output of {@link runChartPlanner}: a fully-formed Echarts spec. */
export interface RunChartPlannerResult {
  option: Record<string, unknown>;
  chartType: ChartPlan["chartType"];
}

/**
 * Module-level cache: one chart-planner agent per plugin config
 * instance. Keyed on the config object identity since each plugin
 * mount provides its own resolver / fallbacks. Re-used across
 * tool invocations and the render-chart HTTP route.
 */
const _plannerByConfig = new WeakMap<MastraPluginConfig, Agent>();
function getPlannerAgent(config: MastraPluginConfig): Agent {
  let agent = _plannerByConfig.get(config);
  if (!agent) {
    agent = createChartPlannerAgent(config);
    _plannerByConfig.set(config, agent);
  }
  return agent;
}

/**
 * Run the chart planner against the given dataset and return a
 * full Echarts `EChartsOption` JSON. Used by
 * {@link emitChartWithPlanning}; tools and producers shouldn't
 * call this directly (use the helper instead so chart events
 * follow the same wire-format contract everywhere).
 */
export async function runChartPlanner(
  opts: RunChartPlannerOptions,
): Promise<RunChartPlannerResult> {
  const { config, requestContext, title, description, data } = opts;
  const planner = getPlannerAgent(config);

  const prompt = [
    `Title: ${title}`,
    description ? `Intent: ${description}` : null,
    "",
    "Dataset (JSON, one row per object):",
    "```json",
    JSON.stringify(data, null, 2),
    "```",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const result = await planner.generate(prompt, {
    structuredOutput: { schema: chartPlanSchema },
    ...(requestContext ? { requestContext } : {}),
  });
  const plan = result.object;
  const option = planToEchartsOption(plan, title);
  return { option, chartType: plan.chartType };
}

/**
 * Minimal `ToolStream`-shaped writer surface. Defined locally so
 * helpers can take any object with a `.write` method without
 * importing Mastra's full `ToolStream` (which would also drag in
 * agent / tool types this module doesn't otherwise need).
 */
interface MinimalWriter {
  write: (chunk: unknown) => unknown;
}

/** Inputs to {@link emitChartWithPlanning}. */
export interface EmitChartWithPlanningOptions {
  /** Mastra `ctx.writer`; missing or closed writers are tolerated. */
  writer?: MinimalWriter;
  /** Plugin config; used to resolve the planner's model. */
  config: MastraPluginConfig;
  /** Per-request context (OBO auth). */
  requestContext?: RequestContext;
  /** Title shown above the rendered chart. Required. */
  title: string;
  /** Optional one-line intent biasing the planner. */
  description?: string;
  /** Tabular dataset to chart (one object per row). */
  data: ReadonlyArray<Record<string, unknown>>;
}

/** Output of {@link emitChartWithPlanning}. */
export interface EmitChartWithPlanningResult {
  /** Short id matching the marker `[[chart:<chartId>]]`. */
  chartId: string;
  /**
   * Promise that resolves once the planner has finished and the
   * `kind: "chart"` event with the option has been emitted (or
   * once the planner has failed silently). Callers that want
   * trace observability should `await` this before returning
   * from their tool's `execute`; callers that want pure
   * fire-and-forget can ignore it.
   */
  plannerPromise: Promise<void>;
}

/**
 * Shared chart-emission primitive used by both the `render_data`
 * tool and Genie's `drainGenieStream`. Keeps both producers on
 * one wire-format contract so the chat client only ever has to
 * understand a single chart event shape.
 *
 * Behaviour:
 *
 * 1. Generates a short `chartId` (8 hex chars).
 * 2. Immediately emits `{ kind: "chart", chartId, title,
 *    description?, data }` via the writer so the chat client can
 *    mount its `<ChartSlot>` with the rows in hand.
 * 3. Kicks off the chart-planner agent in the background. On
 *    success, emits a second `{ kind: "chart", chartId, option }`
 *    event - same `chartId`, just the spec - so the client merges
 *    the two into one rendered chart. On failure, no follow-up
 *    event fires; the client falls back to whatever it can do
 *    with the dataset alone (typically a "render failed" frame
 *    after the parent tool finishes).
 *
 * Returns `chartId` synchronously so the caller can include it in
 * the tool result (model uses it in `[[chart:<chartId>]]`
 * markers), and `plannerPromise` so the caller can choose
 * trace-spanning vs. snappy-return semantics.
 */
export async function emitChartWithPlanning(
  opts: EmitChartWithPlanningOptions,
): Promise<EmitChartWithPlanningResult> {
  const { writer, config, requestContext, title, description, data } = opts;

  // Short, marker-friendly id. The LLM types this verbatim into
  // `[[chart:<id>]]`; an 8-hex-char prefix is unique within a
  // single assistant turn (collision odds ~1 in 4 billion) and
  // much less error-prone for the model to reproduce.
  const chartId = randomUUID().replace(/-/g, "").slice(0, 8);

  log.debug("emit:start", {
    chartId,
    title,
    rows: data.length,
    columns: data[0] ? Object.keys(data[0]) : [],
    hasWriter: writer !== undefined,
  });

  // Initial event: rows + metadata, no option yet. The client
  // mounts a chart slot that shows a skeleton until the option
  // event arrives (or until the parent tool finishes without
  // one, in which case it falls back).
  await safeWrite(writer, chartId, "data", {
    kind: "chart",
    chartId,
    title,
    ...(description ? { description } : {}),
    data,
  });

  // Background planner. Awaitable for trace observability via the
  // returned `plannerPromise`; safe to ignore for pure
  // fire-and-forget. Failures are intentionally swallowed (only
  // logged): the dataset event already landed, so the client has
  // enough to surface a fallback.
  const plannerPromise = (async () => {
    const startedAt = Date.now();
    try {
      const { option, chartType } = await runChartPlanner({
        config,
        ...(requestContext ? { requestContext } : {}),
        title,
        ...(description ? { description } : {}),
        data,
      });
      log.debug("planner:done", {
        chartId,
        chartType,
        elapsedMs: Date.now() - startedAt,
      });
      await safeWrite(writer, chartId, "option", { kind: "chart", chartId, option });
    } catch (err) {
      // No follow-up event on failure. The client treats a
      // dataset-only chart slot as "render failed" once the
      // parent tool's status flips to done. Surface as a `warn`
      // so the failure is visible at the default log level
      // without being mistaken for a fatal error.
      log.warn("planner:error", {
        chartId,
        elapsedMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  return { chartId, plannerPromise };
}

/**
 * Best-effort writer.write. Failures are logged at `warn` (a
 * persistently-closed writer is the most likely culprit when
 * chart events go missing client-side) but swallowed so a closed
 * downstream stream (cancelled request, client navigated away)
 * can't take a tool down.
 */
async function safeWrite(
  writer: MinimalWriter | undefined,
  chartId: string,
  phase: "data" | "option",
  chunk: unknown,
): Promise<void> {
  if (!writer) {
    log.debug("write:no-writer", { chartId, phase });
    return;
  }
  try {
    await writer.write(chunk);
    log.debug("write:ok", { chartId, phase });
  } catch (err) {
    log.warn("write:error", {
      chartId,
      phase,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const renderDataInputSchema = z.object({
  title: z.string().describe(stringUtils.toDescription`
    Title shown above the rendered chart. Use a concise
    sentence-case label (e.g. "Top 10 SKUs by On-Hand Units").
  `),
  description: z.string().optional().describe(stringUtils.toDescription`
    Optional one-line intent describing what insight the chart
    should convey (e.g. "highlight the steep drop-off after
    position 5", "compare quarterly revenue across regions").
    The chart-planner reads this when picking the chart type and
    axis encodings; the user does not see it directly.
  `),
  data: z
    .array(z.record(z.string(), z.unknown()))
    .min(1)
    .describe(stringUtils.toDescription`
      Tabular dataset to chart. One object per row, keyed by
      column name. Values may be strings, numbers, booleans, or
      null. The chart-planner decides which columns are
      categories vs. numeric series. Cap at a few hundred rows
      for legibility; sample / aggregate larger datasets first.
    `),
});

const renderDataOutputSchema = z.object({
  chartId: z.string().describe(stringUtils.toDescription`
    Identifier of the queued chart. To position the chart in
    your reply, embed the marker \`[[chart:<chartId>]]\` on its
    own line where the chart should appear; the client renders
    it inline.
  `),
});

/**
 * Build the `render_data` tool bound to the given plugin config.
 *
 * The tool is a thin wrapper around {@link emitChartWithPlanning}:
 * a single `kind: "chart"` writer event ships the raw rows to
 * the client immediately, the chart-planner agent runs alongside
 * (so the calling LLM stays unblocked while the planner thinks),
 * and a follow-up `kind: "chart"` event with the resolved
 * `EChartsOption` lands when it's ready. The tool's `execute`
 * awaits the planner promise so the planner work shows up under
 * the tool's trace span; the LLM still gets back just
 * `{ chartId }`, so its context stays small regardless of dataset
 * size.
 */
export function buildRenderDataTool(config: MastraPluginConfig) {
  return createTool({
    id: "render_data",
    description: stringUtils.toDescription`
      Submit a tabular dataset for inline rendering as a chart in
      the user's view. Pass a title, the raw rows (array of
      objects keyed by column name), and an optional one-line
      description of the insight to highlight. Returns a short
      \`chartId\`; the chart renders inline at the position you
      embed the matching \`[[chart:<chartId>]]\` marker.

      Placement contract: embed \`[[chart:<chartId>]]\` on its own
      line (blank lines above and below) wherever you want the
      chart to appear in your reply. The client shows a skeleton
      at that spot until the chart is ready, then swaps in the
      rendered Echarts visualization. You can call
      \`render_data\` multiple times in the same turn (the tool
      is parallel-safe) and interleave the markers with prose so
      each chart sits next to its commentary. A chart whose
      marker is omitted falls through to the end of your reply
      as a fallback - safe but less polished.

      Use whenever a SQL row set, API response, or hand-built
      dataset would land better as a picture than as a list or
      table. Cap input at a few hundred rows; sample or
      aggregate larger datasets first.
    `,
    inputSchema: renderDataInputSchema,
    outputSchema: renderDataOutputSchema,
    execute: async (input, ctx) => {
      const { title, description, data } = input as z.infer<
        typeof renderDataInputSchema
      >;
      const writer = (ctx as { writer?: MinimalWriter } | undefined)?.writer;
      const requestContext = (ctx as { requestContext?: RequestContext } | undefined)
        ?.requestContext;
      const { chartId, plannerPromise } = await emitChartWithPlanning({
        ...(writer ? { writer } : {}),
        config,
        ...(requestContext ? { requestContext } : {}),
        title,
        ...(description ? { description } : {}),
        data,
      });
      // Await the planner so its latency is attributed to this
      // tool's trace span. The promise itself swallows planner
      // failures, so this never throws.
      await plannerPromise;
      return { chartId };
    },
  });
}

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
    return {
      title: { text: baseTitle, left: "center" },
      tooltip: { trigger: "item" },
      legend: { bottom: 0 },
      series: [
        {
          name: plan.series[0]?.name ?? baseTitle,
          type: "pie",
          radius: ["35%", "65%"],
          data: plan.series[0]?.data ?? [],
        },
      ],
    };
  }

  if (plan.chartType === "scatter") {
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
        data: s.data,
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
