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
 *   expansion as a plain async function. The HTTP route in
 *   {@link ./render-chart-route.ts} calls this when the client
 *   POSTs the dataset back; the result is an `EChartsOption` JSON
 *   the React `<ChartSlot>` renders inline. Decoupling the planner
 *   from the tool means the planning latency lives entirely
 *   client-side: the model can finish writing its report while
 *   the client is still rendering the charts.
 *
 * The model wires the chart into its reply by emitting the marker
 * `[[chart:<chartId>]]` on its own line in markdown. The chat
 * client splits the assistant text on these markers and drops a
 * `<ChartSlot>` in at the position the model placed it; the slot
 * then fires the render-chart endpoint on mount and shows a
 * skeleton until the option lands.
 */

import { randomUUID } from "node:crypto";

import { stringUtils } from "@dbx-tools/appkit-shared";
import { Agent } from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import type { MastraPluginConfig } from "./config.js";
import { ModelTier, modelForTier, buildModel } from "./model.js";

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
 * full Echarts `EChartsOption` JSON. Used by the HTTP route the
 * client hits when it sees a `[[chart:<chartId>]]` marker; the
 * tool itself does not call this so the model never blocks on
 * planning latency.
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
    Identifier of the queued chart. The tool returned
    immediately - actual chart planning happens client-side
    asynchronously. To position the chart in your reply, embed
    the marker \`[[chart:<chartId>]]\` on its own line (with
    blank lines above and below) where the chart should appear.
    The client renders a skeleton there until the chart is
    ready, then swaps in the visualization in place. You can
    keep writing prose around the marker; the agent does not
    need to wait for the chart to render.
  `),
});

/**
 * Build the `render_data` tool bound to the given plugin config.
 *
 * Fire-and-forget by design: the tool returns immediately with a
 * short `chartId` and emits a single `kind: "chart"` event over
 * `ctx.writer` carrying the raw dataset for the client. The
 * client's chart slot then POSTs the data to
 * `/route/render-chart` to get an `EChartsOption` back from the
 * planner agent. This keeps the calling LLM unblocked - it can
 * write the report referencing the chart by id while the client
 * is still rendering it.
 */
export function buildRenderDataTool(_config: MastraPluginConfig) {
  return createTool({
    id: "render_data",
    description: stringUtils.toDescription`
      Submit a tabular dataset for inline rendering as a chart in
      the user's view. Pass a title, the raw rows (array of
      objects keyed by column name), and an optional one-line
      description of the insight to highlight. Returns a short
      \`chartId\` immediately - chart planning happens
      asynchronously in the client, not in this turn, so the tool
      does not block your prose.

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

      // Short, marker-friendly id. The LLM has to type this
      // verbatim into the `[[chart:<id>]]` marker; an 8-hex-char
      // prefix is unique within a single assistant turn (collision
      // odds ~1 in 4 billion) and much less error-prone for the
      // model to reproduce.
      const chartId = randomUUID().replace(/-/g, "").slice(0, 8);

      const writer = (ctx as { writer?: { write: (e: unknown) => unknown } } | undefined)
        ?.writer;
      try {
        await writer?.write({
          kind: "chart",
          chartId,
          title,
          ...(description ? { description } : {}),
          data,
        });
      } catch {
        // Ignore: the parent stream may have closed downstream.
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
