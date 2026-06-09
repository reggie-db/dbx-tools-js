/**
 * Agent-prose embed marker grammar.
 *
 * The Mastra agent is instructed to defer visualizations to the host
 * UI by embedding markers in its markdown reply; the UI parses them
 * out and swaps in the matching slot. This module is the single
 * source of truth for that grammar so every consumer parses markers
 * the same way and can't drift from the shapes documented on
 * {@link ChartSchema} / {@link StatementDataSchema} in `protocol.ts`
 * and the instructions the server hands the model.
 *
 * One grammar, open-ended type. A marker is `[<type>:<id>]`. The
 * `<type>` is an opaque token that names the embed kind; the host
 * resolves it against the generic `/embed/<type>/<id>` route, which
 * 404s any type the server doesn't register. The grammar does NOT
 * hard-code the known types - new embed kinds work end to end
 * without touching this regex. Today the server registers:
 *
 *   - `[chart:<chartId>]` - the `<chartId>` is a v4 UUID minted by
 *     the chart subsystem (`prepare_chart` / `render_data`) and
 *     resolves to a cached Echarts spec.
 *   - `[data:<statementId>]` - the `<statementId>` is a Databricks
 *     statement id (a time-ordered UUID) and resolves to the
 *     statement's rows.
 *
 * The `<id>` MUST be UUID-shaped (`8-4-4-4-12` hex): both id kinds
 * above are UUIDs, just different versions (chart = v4, statement =
 * v7-style). Baking that shape into the grammar means a fabricated
 * marker the model glued together from a label
 * (e.g. `[chart:01f163b6-1eac-region-fill-oos]`) simply doesn't
 * parse - it's left as prose instead of firing a doomed request -
 * so no separate id-shape guard is needed downstream.
 *
 * Parse everything through {@link parseMarkers} and branch on the
 * returned {@link ParsedMarker.type}.
 */

/**
 * The embed kind named by a marker's `<type>` segment. Left as an
 * open `string` (not a closed union) so the grammar stays generic:
 * the authoritative set of supported types lives in the server's
 * `/embed/:type/:id` resolver registry, and an unknown type simply
 * 404s. The two types the server ships today are `"chart"` and
 * `"data"`.
 */
export type MarkerType = string;

/**
 * Single matcher for ANY embed marker, regardless of type. Matches
 * `[<type>:<id>]`. Capture group 1 is the marker type token (e.g.
 * `chart`, `data`); group 2 is the id, constrained to a UUID shape
 * (`8-4-4-4-12` hex, any version - covers v4 chart ids and
 * time-ordered statement ids alike).
 *
 * The type is intentionally NOT enumerated here - the server's
 * resolver registry decides which types are real and 404s the rest,
 * so a new embed kind needs no grammar change. Pinning only the id
 * SHAPE (not the type) is what lets the grammar self-reject
 * fabricated, non-UUID ids without a separate guard.
 *
 * Safe to share as a `/g` constant: it's only ever consumed via
 * {@link String.prototype.matchAll}, which clones the regex and
 * never advances this object's `lastIndex`. (A `.exec()`/`.test()`
 * loop would need a fresh regex each time, but we don't do that.)
 */
const MARKER_RE =
  /\[([A-Za-z][A-Za-z0-9_-]*):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/gi;

/** One marker found in agent prose, with its source span. */
export interface ParsedMarker {
  /** Marker kind token (e.g. `chart`, `data`); see {@link MarkerType}. */
  type: MarkerType;
  /** Raw id captured from the marker (chart id or statement id). */
  id: string;
  /** Index of the marker's first character in the source text. */
  start: number;
  /** Index one past the marker's last character. */
  end: number;
}

/**
 * Parse every embed marker out of `text`, in source order. A single
 * regex pass means matches never overlap, so callers can splice the
 * spans directly without a sort/dedupe step. This is the one entry
 * point for marker parsing: type branching runs on the returned
 * markers, and every returned id is already UUID-shaped because the
 * grammar ({@link MARKER_RE}) requires it - no separate id-shape
 * check is needed.
 */
export function parseMarkers(text: string): ParsedMarker[] {
  const out: ParsedMarker[] = [];
  for (const match of text.matchAll(MARKER_RE)) {
    const start = match.index ?? 0;
    out.push({
      // Group 1 is the `<type>` token; the server's embed registry
      // (not this parser) decides whether it's supported.
      type: match[1] ?? "",
      id: match[2] ?? "",
      start,
      end: start + match[0].length,
    });
  }
  return out;
}

/**
 * Strip a trailing partial marker (`[chart`, `[data:01f1`, ...) that
 * hasn't received its closing `]` yet. While the model streams
 * text-deltas a marker arrives across several chunks, and rendering
 * each interim state would briefly flash the literal `[chart:abc-`
 * prefix before the closing bracket swaps it for a slot. Hiding any
 * trailing `[<non-whitespace-non-bracket>...` suffix keeps the prose
 * stable until either a `]` (full marker) or whitespace (definitely
 * not a marker) lands. Persisted transcripts never end mid-marker,
 * so this is a no-op on reload.
 */
export function stripIncompleteMarkerTail(text: string): string {
  return text.replace(/\[[^\s[\]]*$/, "");
}
