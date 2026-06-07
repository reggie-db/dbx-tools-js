/**
 * Chart-rendering primitives.
 *
 * Two surfaces, one shared brain:
 *
 * - {@link runChartPlanner}: the chart-planner Agent + ECOption
 *   expansion as a plain async function. Takes a dataset and
 *   returns a promise that resolves to a full `EChartsOption`
 *   JSON plus the chosen `chartType`. No background work, no
 *   writer side-effects, no id allocation - callers stitch the
 *   result into whatever shape their producer needs.
 *
 * - {@link buildRenderDataTool}: a Mastra tool the model calls
 *   ("here is a dataset, render it as a chart"). Mints a short
 *   `chartId`, `await`s {@link runChartPlanner} so the planner
 *   latency is attributed to this tool's trace span, emits one
 *   `type: "chart"` writer event carrying the dataset + resolved
 *   `option`, and returns `{ chartId }` to the model. The
 *   LLM-bound output stays flat regardless of dataset size.
 *
 * The model wires the chart into its reply by emitting the marker
 * `[[chart:<chartId>]]` on its own line in markdown. The chat
 * client splits the assistant text on these markers and drops a
 * `<ChartSlot>` in at the position the model placed it. The slot
 * resolves directly to the rendered Echarts visualisation - no
 * skeleton state, because the option is in the same event as the
 * dataset.
 */

import type { MinimalWriter } from "@dbx-tools/appkit-mastra-shared";
import { commonUtils, logUtils, stringUtils } from "@dbx-tools/shared";
import { Agent } from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import type { MastraPluginConfig } from "./config.js";
import { ModelTier, modelForTier, buildModel } from "./model.js";
import { safeWrite } from "./writer.js";

/**
 * Module-level logger tagged `[mastra/chart]`. Uses the shared
 * {@link logUtils.logger} so calls below `LOG_LEVEL` are
 * discarded for free. Default `LOG_LEVEL` is `info`; flip to
 * `debug` to see the per-chart timeline (`emit:start` →
 * `write:ok(data)` → `planner:done` → `write:ok(option)`).
 */
const log = logUtils.logger("mastra/chart");

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
 *
 * Net effect: a 200-row dataset with a few sparse/null/string
 * values still produces a chart; only a totally-malformed planner
 * response (no items at all) falls through to the table fallback.
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

type ChartDataPoint = z.infer<typeof chartDataPointSchema>;

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
  chartType: z.enum(["bar", "line", "area", "scatter", "pie"])
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
  categories: z.array(z.string()).optional().describe(stringUtils.toDescription`
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
        data: z.array(chartDataPointSchema).describe(stringUtils.toDescription`
            Data points. For \`bar\` / \`line\` / \`area\`, an
            array of numbers aligned to \`categories\`. For
            \`scatter\`, an array of \`[x, y]\` numeric tuples.
            For \`pie\`, an array of \`{name, value}\` objects.
          `),
      }),
    )
    .min(1).describe(stringUtils.toDescription`
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
  /**
   * Cooperative cancellation. Forwarded to the planner agent's
   * `generate({ abortSignal })` call so concurrent renders can be
   * aborted as a group when the parent Genie agent's signal fires.
   */
  signal?: AbortSignal;
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
 * full Echarts `EChartsOption` JSON. Pure async function: no
 * writer side-effects, no id minting, no background work.
 * Producers (the `render_data` tool, the Genie agent,
 * anything else that needs a chart) await this and stitch the
 * result into whatever shape their wire contract needs.
 */
export async function runChartPlanner(
  opts: RunChartPlannerOptions,
): Promise<RunChartPlannerResult> {
  const { config, requestContext, title, description, data, signal } = opts;
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
    ...(signal ? { abortSignal: signal } : {}),
  });
  const plan = result.object as ChartPlan;
  const option = planToEchartsOption(plan, title);
  return { option, chartType: plan.chartType };
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
  data: z.array(z.record(z.string(), z.unknown())).min(1)
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
 * The tool awaits {@link runChartPlanner} so the planner's
 * latency is attributed to this tool's trace span, then emits
 * one `type: "chart"` writer event carrying the dataset and the
 * resolved `EChartsOption`. The LLM-bound output is just
 * `{ chartId }` so the model's context stays flat regardless of
 * dataset size. Planner failures are caught and surfaced as a
 * `type: "error"` writer event so the slot can fall back to
 * "couldn't render chart" without taking the parent agent down.
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
      chart to appear in your reply. The chart is fully resolved
      by the time the tool returns, so it renders immediately at
      that spot. You can call \`render_data\` multiple times in
      the same turn (the tool is parallel-safe) and interleave
      the markers with prose so each chart sits next to its
      commentary. A chart whose marker is omitted falls through
      to the end of your reply as a fallback - safe but less
      polished.

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

      // Marker-friendly short id. The LLM types this verbatim
      // into `[[chart:<id>]]`; 8 hex chars is unique within a
      // single assistant turn and easy for the model to copy.
      const chartId = commonUtils.shortId();
      const startedAt = Date.now();
      log.debug("render:start", {
        chartId,
        title,
        rows: data.length,
        columns: data[0] ? Object.keys(data[0]) : [],
        hasWriter: writer !== undefined,
      });

      try {
        const { option, chartType } = await runChartPlanner({
          config,
          ...(requestContext ? { requestContext } : {}),
          title,
          ...(description ? { description } : {}),
          data,
        });
        log.debug("render:done", {
          chartId,
          chartType,
          elapsedMs: Date.now() - startedAt,
        });
        // Single chart event with everything resolved: dataset
        // for the table-like fallback / hover, option for the
        // actual render. Best-effort write so a closed
        // downstream stream can't take the tool down.
        await safeWrite(
          log,
          writer,
          {
            type: "chart",
            chartId,
            title,
            ...(description ? { description } : {}),
            data,
            option,
          },
          { chartId },
        );
      } catch (err) {
        log.warn("render:error", {
          chartId,
          elapsedMs: Date.now() - startedAt,
          error: commonUtils.errorMessage(err),
        });
        // Surface as a writer-level error so the slot can
        // transition to "couldn't render chart" without the
        // parent agent surfacing a stack trace.
        await safeWrite(
          log,
          writer,
          {
            type: "error",
            error: commonUtils.errorMessage(err),
          },
          { chartId },
        );
      }
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
