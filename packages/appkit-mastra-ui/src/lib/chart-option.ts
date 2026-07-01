/**
 * Presentation normalizer for planner-produced Echarts specs.
 *
 * The chart planner (`@dbx-tools/appkit-mastra`) emits a JSON-safe
 * `EChartsOption` that travels through the cache and over the wire, so
 * it can't carry function-valued formatters or make width-dependent
 * layout choices. This module patches those presentation concerns back
 * in at render time - identically for the live inline chart
 * (`embed-slots`) and the print/PDF export (`export.ts`) - so both read
 * the same way:
 *
 *   - large value-axis ticks render compact (`800M`, not `800,000,000`);
 *   - value/category axis names sit in conventional positions (rotated
 *     on the left for `y`, centered below for `x`) instead of floating at
 *     the axis ends where they collide with the centered title;
 *   - category labels stay legible (shown, rotated, de-overlapped) rather
 *     than silently decimated when many bars share a narrow canvas;
 *   - the title and grid leave room for one another.
 *
 * It only fills gaps: any field the spec already sets (an explicit
 * `axisLabel.formatter`, `nameLocation`, etc.) is preserved.
 */

/** Compact SI formatter shared across every value-axis tick. */
const COMPACT_NUMBER = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/**
 * Format a value-axis tick compactly: `1200 -> "1.2K"`,
 * `800000000 -> "800M"`. Values below 1000 (and non-finite ones) render
 * verbatim so small-scale axes and category-like values are untouched.
 */
function compactAxisLabel(value: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value);
  return Math.abs(value) < 1000 ? String(value) : COMPACT_NUMBER.format(value);
}

/** A permissive record view of an option node we patch field-by-field. */
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** True when `title` (object or array) carries any non-empty `text`. */
function hasTitleText(title: unknown): boolean {
  const entries = Array.isArray(title) ? title : [title];
  return entries.some(
    (t) => isObj(t) && typeof t.text === "string" && t.text.trim().length > 0,
  );
}

/** Pin a title to the top-center so it clears the plot / axis names. */
function normalizeTitle(title: unknown): unknown {
  if (Array.isArray(title)) return title.map(normalizeTitle);
  if (!isObj(title)) return title;
  return { left: "center", top: 8, ...title };
}

/**
 * Ensure the grid leaves room for a top title and for rotated category
 * labels + a centered x-axis name below. `containLabel` keeps the tick
 * labels themselves inside the box; the explicit margins reserve space
 * for the title (top) and the axis name (bottom) which `containLabel`
 * does not account for.
 */
function normalizeGrid(grid: unknown, opts: { hasTitle: boolean }): unknown {
  const base = isObj(grid) ? grid : {};
  return {
    left: 12,
    right: 24,
    bottom: 24,
    ...base,
    top: base.top ?? (opts.hasTitle ? 64 : 32),
    containLabel: base.containLabel ?? true,
  };
}

/** Patch a single axis node in place-safe fashion (`x` or `y`). */
function normalizeAxis(axis: Obj, pos: "x" | "y"): Obj {
  const next: Obj = { ...axis };
  const existingLabel = isObj(next.axisLabel) ? next.axisLabel : {};

  if (next.type === "value") {
    // Compact big-number ticks unless the spec pinned its own formatter.
    next.axisLabel = { formatter: compactAxisLabel, ...existingLabel };
  } else if (next.type === "category") {
    // Show every category, rotated and de-overlapped, rather than
    // letting Echarts drop labels on a crowded axis.
    next.axisLabel = { interval: 0, rotate: 30, hideOverlap: true, ...existingLabel };
  }

  // Move a set axis name to a conventional spot so it never collides
  // with the centered title (y) or floats past the last tick (x).
  if (typeof next.name === "string" && next.name.trim().length > 0) {
    next.nameLocation = next.nameLocation ?? "middle";
    if (pos === "y") {
      next.nameRotate = next.nameRotate ?? 90;
      next.nameGap = next.nameGap ?? 56;
    } else {
      next.nameGap = next.nameGap ?? 56;
    }
  }
  return next;
}

/** Apply {@link normalizeAxis} across an axis field (object or array). */
function normalizeAxisField(axis: unknown, pos: "x" | "y"): unknown {
  if (Array.isArray(axis)) return axis.map((a) => (isObj(a) ? normalizeAxis(a, pos) : a));
  return isObj(axis) ? normalizeAxis(axis, pos) : axis;
}

/**
 * Return a render-ready copy of a planner `EChartsOption`: compact
 * value ticks, conventionally-placed axis names, legible category
 * labels, and title/grid spacing. Pure and shallow-cloning - the input
 * (which may be a shared/cached object) is never mutated. Non-object
 * input is returned untouched.
 */
export function normalizeChartOption<T>(option: T): T {
  if (!isObj(option)) return option;
  const next: Obj = { ...option };
  next.title = normalizeTitle(next.title);
  next.grid = normalizeGrid(next.grid, { hasTitle: hasTitleText(next.title) });
  next.xAxis = normalizeAxisField(next.xAxis, "x");
  next.yAxis = normalizeAxisField(next.yAxis, "y");
  return next as T;
}
