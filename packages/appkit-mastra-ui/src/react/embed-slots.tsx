import { Spinner } from "@databricks/appkit-ui/react";
import {
  isUuid,
  parseMarkers,
  stripIncompleteMarkerTail,
  type ParsedMarker,
} from "@dbx-tools/appkit-mastra-shared";
import ReactECharts from "echarts-for-react";
import { ClockIcon } from "lucide-react";
import { useMemo } from "react";
import { normalizeChartOption } from "../lib/chart-option.js";
import { useChartFetch, useStatementFetch } from "../lib/mastra-client.js";
import { DataGrid, humanizeLabel } from "./data-grid.js";
import { AssistantMarkdown } from "./markdown.js";

// Inline embed slots: chart / data tables resolved from `[chart:<id>]`
// and `[data:<id>]` markers in the assistant's prose, plus the splitter
// that interleaves those slots with the surrounding markdown.

/**
 * Frame shared by every chart-slot state so the layout stays
 * stable as a slot transitions from queueing → rendering →
 * rendered (or → render-failed). Width tracks the bubble; height
 * is fixed so Echarts has a deterministic canvas regardless of
 * the parent's flex layout. `not-prose` opts out of Tailwind
 * Typography.
 */
const CHART_FRAME_CLASSES =
  "not-prose my-3 max-w-full rounded border border-border/60 bg-background/40 p-2";
const CHART_HEIGHT_PX = 320;

/**
 * Compact inline notice rendered in place of an embed - a chart, data
 * table, or any future `[<type>:<id>]` marker - whose backing cache
 * entry 404'd, i.e. the embed id expired (TTL elapsed) or was never
 * minted. The displayed noun is the marker `type` run through
 * {@link humanizeLabel}, keeping this slot agnostic to which kinds
 * exist. Deliberately small so an expired artifact in a long
 * transcript reads as a quiet footnote rather than a broken,
 * full-height frame. Only the genuine "settled 404" case reaches here;
 * in-flight fetches and hard errors still render nothing (see
 * {@link ChartSlot} / {@link DataSlot}).
 */
const ExpiredSlot = ({ type }: { type: string }) => (
  <div className="not-prose my-3 inline-flex items-center gap-2 rounded-md border border-dashed border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
    <ClockIcon className="size-3.5 shrink-0" />
    <span>
      This {humanizeLabel(type, { capitalize: false })} has expired and is no longer
      available.
    </span>
  </div>
);

/**
 * Inline chart slot. Each `[chart:<chartId>]` marker in the
 * assistant's reply resolves to one of these. The Mastra plugin
 * caches the resolved Echarts
 * spec under the chartId; this slot fetches it via the generic
 * `embedPathTemplate` (`/embed/chart/:id`, long-poll until ready /
 * error / 404).
 *
 * Render contract:
 *
 *   - Cache entry settled with `result` -> render the full
 *     Echarts spec.
 *   - Fetch / long-poll in flight -> render the chart frame at its
 *     known fixed footprint (`CHART_HEIGHT_PX`) with a centered
 *     spinner, so the slot reserves the chart's eventual space and
 *     the prose below doesn't reflow when it lands.
 *   - 404 (unknown / TTL-expired id) -> render a small
 *     {@link ExpiredSlot} notice so the reader knows the chart
 *     used to be here but has aged out, instead of a silent gap.
 *   - Settled with `error`, or a non-terminal payload that has
 *     neither `result` nor `error` -> render NOTHING. Genuine
 *     planner failures are silently dropped rather than left as
 *     placeholder frames. The Echarts `option` already carries its
 *     own `title.text`, so no separate header is needed above the
 *     chart frame.
 */
const ChartSlot = ({ chartId }: { chartId: string }) => {
  const { data: chart, loading, error } = useChartFetch(chartId);
  // Patch presentation (compact ticks, axis-name placement, legible
  // category labels) into the JSON-safe planner spec before rendering,
  // matching the export path. Memoized on the resolved option identity.
  const option = useMemo(
    () => (chart?.result ? normalizeChartOption(chart.result.option) : undefined),
    [chart?.result],
  );
  if (option) {
    return (
      <div className={CHART_FRAME_CLASSES}>
        <ReactECharts
          option={option}
          style={{ height: CHART_HEIGHT_PX, width: "100%" }}
          notMerge
          lazyUpdate
        />
      </div>
    );
  }
  // In-flight fetch: the chart's footprint is known ahead of time, so
  // reserve the same frame + height with a spinner instead of
  // collapsing - the chart fades in without shifting the prose below.
  if (loading) {
    return (
      <div className={CHART_FRAME_CLASSES}>
        <div
          className="flex items-center justify-center"
          style={{ height: CHART_HEIGHT_PX, width: "100%" }}
        >
          <Spinner className="size-5 text-muted-foreground" />
        </div>
      </div>
    );
  }
  // Settled 404 (unknown / TTL-expired id) -> small "expired" notice.
  // Hard-error / non-terminal payloads render nothing.
  if (!error && chart === undefined) return <ExpiredSlot type="chart" />;
  return null;
};

/**
 * Inline data-table slot. Each `[data:<statement_id>]` marker in
 * the assistant's reply resolves to one of these. A single
 * OBO-scoped fetch against `embedPathTemplate` (`/embed/data/:id`)
 * returns the columns + rows; the slot hands them to {@link DataGrid}
 * for an interactive (sortable, column-toggle, CSV-export) table.
 *
 * Render contract (matches {@link ChartSlot}):
 *
 *   - 404 (unknown / TTL-expired id) -> render a small
 *     {@link ExpiredSlot} notice so the reader knows a table aged
 *     out rather than seeing a silent gap.
 *   - Fetch in flight, hard error, or empty rows -> render
 *     NOTHING. Stale markers in persisted transcripts stay quiet
 *     so a reload doesn't leave dead frames.
 *   - Data settled with rows -> render the {@link DataGrid}, whose
 *     toolbar surfaces the "showing N of M rows" affordance when the
 *     server-side cap truncated the result set.
 */
const DataSlot = ({ statementId }: { statementId: string }) => {
  const { data, loading, error } = useStatementFetch(statementId);
  // Settled 404 (unknown / TTL-expired id) -> small "expired" notice.
  // In-flight fetches, hard errors, and empty result sets render
  // nothing so stale markers in reloaded transcripts stay quiet.
  if (!loading && !error && data === undefined) return <ExpiredSlot type="data" />;
  if (!data || data.rows.length === 0) return null;
  return (
    <DataGrid
      columns={data.columns}
      rows={data.rows}
      truncated={data.truncated}
      rowCount={data.rowCount}
      humanizeHeaders
    />
  );
};

/** One slice of an assistant message: prose, a chart slot, or a data slot. */
type RenderSegment =
  | { kind: "text"; text: string }
  | { kind: "chart"; chartId: string }
  | { kind: "data"; statementId: string };

/**
 * Map one parsed marker onto its render segment. The marker grammar
 * matches ANY `[<type>:<id>]`, including fabricated ids the model
 * glued together from a label (e.g. `[chart:placeholder]`), so the id
 * is validated with {@link isUuid} before it's treated as a real
 * embed. A non-UUID id - or a UUID with a type this UI can't render -
 * collapses to an empty text segment: the marker is consumed so no
 * literal `[<type>:...]` leaks into the prose, but no slot renders and
 * no `/embed/<type>/:id` request fires. Only a UUID-shaped id with a
 * known, renderable type (charts need ECharts, data needs a Table)
 * resolves to a slot.
 */
const markerSegment = (marker: ParsedMarker): RenderSegment => {
  if (!isUuid(marker.id)) return { kind: "text", text: "" };
  switch (marker.type) {
    case "chart":
      return { kind: "chart", chartId: marker.id };
    case "data":
      return { kind: "data", statementId: marker.id };
    default:
      return { kind: "text", text: "" };
  }
};

const splitTextWithEmbeds = (text: string): RenderSegment[] => {
  const segments: RenderSegment[] = [];
  let lastIdx = 0;
  // `parseMarkers` yields hits in source order with no overlaps (one
  // regex pass), so the spans splice in directly - no sort or
  // overlap guard needed.
  for (const marker of parseMarkers(text)) {
    if (marker.start > lastIdx) {
      segments.push({ kind: "text", text: text.slice(lastIdx, marker.start) });
    }
    segments.push(markerSegment(marker));
    lastIdx = marker.end;
  }
  if (lastIdx < text.length) {
    segments.push({ kind: "text", text: text.slice(lastIdx) });
  }
  return segments;
};

/**
 * Render the assistant's markdown with chart and data tables
 * placed at their inline marker positions. Each prose segment
 * is its own {@link AssistantMarkdown} so streaming chunks still
 * incrementally parse correctly; embed slots break the markdown
 * flow with full-width block elements.
 *
 * Each marker resolves through its own slot:
 *
 *   - `[chart:<id>]` -> {@link ChartSlot} long-polls the
 *     server-side chart cache and renders the Echarts spec
 *     inline once ready (or nothing on miss / TTL-expired).
 *   - `[data:<statement_id>]` -> {@link DataSlot} fetches the
 *     statement rows OBO-scoped and renders an inline Table
 *     (or nothing on 404 / empty result).
 *
 * Stale markers in persisted transcript text are silently
 * dropped on reload so the prose around them stays clean.
 *
 * `streaming` flags the bubble as still receiving tokens; it opts the
 * prose segments into Streamdown's word-by-word fade-in so the reply
 * eases in rather than snapping in whole chunks. Settled bubbles pass
 * `false` and render plain markdown.
 */
export const MarkdownWithEmbeds = ({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) => {
  const segments = splitTextWithEmbeds(stripIncompleteMarkerTail(text));
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === "text") {
          if (seg.text.trim().length === 0) return null;
          return (
            <AssistantMarkdown key={`t-${i}`} animate={streaming}>
              {seg.text}
            </AssistantMarkdown>
          );
        }
        if (seg.kind === "chart") {
          return <ChartSlot key={`c-${i}-${seg.chartId}`} chartId={seg.chartId} />;
        }
        return (
          <DataSlot key={`d-${i}-${seg.statementId}`} statementId={seg.statementId} />
        );
      })}
    </>
  );
};
