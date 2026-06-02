/**
 * Chart-render HTTP endpoint for the Mastra plugin.
 *
 * The `render_data` tool returns immediately with a `chartId` and
 * emits the dataset over `ctx.writer`; the client then POSTs that
 * dataset to this endpoint to actually run the chart-planner
 * agent and get back an Echarts `EChartsOption` JSON. Planning
 * happens out-of-band so the calling agent's response stream
 * doesn't sit idle waiting for it - the model can finish the
 * report while the client is still rendering charts.
 *
 * Auth flows through the standard Mastra middleware: the route
 * sits in the same dispatcher pipeline as `chatRoute` /
 * `historyRoute`, so by the time the handler runs the
 * `RequestContext` is populated with the workspace user and
 * the chart-planner's model resolver has the OBO token it
 * needs.
 */

import type {
  RenderChartRequest,
  RenderChartResponse,
} from "@dbx-tools/appkit-mastra-shared";
import { registerApiRoute } from "@mastra/core/server";

import { runChartPlanner } from "./chart.js";
import type { MastraPluginConfig } from "./config.js";

/** Hard cap so a misbehaving client can't hand us a million-row payload. */
const MAX_ROWS = 5_000;
/**
 * Hard cap on the JSON body the route accepts (in bytes). Mirrors
 * the same intent as {@link MAX_ROWS}: bound the chart-planner's
 * prompt size and protect against accidental denial-of-service
 * from a runaway tool that ships an enormous payload.
 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Options accepted by {@link renderChartRoute}. */
export interface RenderChartRouteOptions {
  path: string;
  config: MastraPluginConfig;
}

/**
 * Register a `POST <path>` Mastra custom API route that runs the
 * chart-planner agent against a dataset and returns an Echarts
 * `EChartsOption` JSON.
 *
 * Body shape: {@link RenderChartRequest}; response:
 * {@link RenderChartResponse}.
 */
export function renderChartRoute(options: RenderChartRouteOptions) {
  const { path, config } = options;
  return registerApiRoute(path, {
    method: "POST",
    handler: async (c) => {
      const requestContext = c.get("requestContext");

      // Hono parses the body as JSON; we still validate shape /
      // size since the tool's structured output is a contract,
      // not a guarantee, and the route is publicly mountable.
      const raw = (await c.req.json().catch(() => null)) as unknown;
      const validation = validateBody(raw);
      if ("error" in validation) {
        return c.json({ error: validation.error }, 400);
      }
      const { title, description, data } = validation.body;

      try {
        const result = await runChartPlanner({
          config,
          ...(requestContext ? { requestContext } : {}),
          title,
          ...(description ? { description } : {}),
          data,
        });
        const payload: RenderChartResponse = {
          option: result.option,
          chartType: result.chartType,
        };
        return c.json(payload);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: message }, 500);
      }
    },
  });
}

type ValidationResult =
  | { body: RenderChartRequest }
  | { error: string };

/**
 * Best-effort body validation. Surfaces a 400 for malformed input
 * instead of letting a downstream `.map` / `.length` blow up
 * inside the planner agent. Field-level shape mirrors
 * {@link RenderChartRequest}.
 */
function validateBody(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== "object") {
    return { error: "request body must be a JSON object" };
  }
  const r = raw as Record<string, unknown>;
  const title = r.title;
  if (typeof title !== "string" || title.length === 0) {
    return { error: "`title` must be a non-empty string" };
  }
  if (r.description !== undefined && typeof r.description !== "string") {
    return { error: "`description` must be a string when provided" };
  }
  if (!Array.isArray(r.data)) {
    return { error: "`data` must be an array of row objects" };
  }
  if (r.data.length === 0) {
    return { error: "`data` must contain at least one row" };
  }
  if (r.data.length > MAX_ROWS) {
    return { error: `\`data\` exceeds the per-request limit of ${MAX_ROWS} rows` };
  }
  for (const [i, row] of r.data.entries()) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return { error: `data[${i}] must be a plain object` };
    }
  }
  // Approximate body-size check; spares us pulling Buffer in.
  const approximateBytes = JSON.stringify(r.data).length;
  if (approximateBytes > MAX_BODY_BYTES) {
    return {
      error: `\`data\` exceeds the per-request size limit of ${MAX_BODY_BYTES} bytes`,
    };
  }
  return {
    body: {
      title,
      ...(typeof r.description === "string" ? { description: r.description } : {}),
      data: r.data as Array<Record<string, unknown>>,
    },
  };
}
