/**
 * Client-side chat export.
 *
 * Turns chat messages into a portable, self-contained document at either
 * the single-message or the whole-conversation level, in one of two
 * formats:
 *
 *   - `"pdf"`   - a print-ready HTML document opened in a new tab with
 *                 the browser's print dialog triggered, so the user saves
 *                 a real PDF ("Save as PDF"). Renders reliably offline.
 *   - `"markdown"` - a `.md` file download.
 *
 * Charts are included, not dropped: each `[chart:<id>]` marker is
 * resolved against the plugin's chart cache and rendered to an inline
 * SVG via Echarts' server-side renderer (no DOM needed), so a PDF/HTML
 * export carries the chart itself rather than a placeholder.
 * `[data:<id>]` markers resolve to a real table. Unresolved / expired
 * ids are skipped so the surrounding prose stays clean.
 */

import {
  isUuid,
  parseMarkers,
  type Chart,
  type StatementData,
} from "@dbx-tools/appkit-mastra-shared";
import type { UIMessage } from "ai";
import * as echarts from "echarts";
import { marked } from "marked";

/** Output formats {@link exportChat} can produce. */
export type ExportFormat = "pdf" | "markdown";

/**
 * Resolves the embeds referenced by `[chart:<id>]` / `[data:<id>]`
 * markers in message prose. Satisfied by `MastraPluginClient` (its
 * `chart` / `statement` methods) - the driver passes those straight
 * through.
 */
export interface EmbedResolver {
  chart(id: string): Promise<Chart | undefined>;
  statement(id: string): Promise<StatementData | undefined>;
}

/** Options accepted by {@link exportChat}. */
export interface ExportChatOptions {
  /** Messages to export, oldest first (one entry for a message-level export). */
  messages: UIMessage[];
  /** Target format. */
  format: ExportFormat;
  /** Embed resolver used to inline charts and data tables. */
  resolver: EmbedResolver;
  /** Document title / heading. Defaults to `"Conversation"`. */
  title?: string;
  /** Download filename stem (no extension). Defaults to a slug of the title. */
  filename?: string;
}

/** Fixed Echarts SSR canvas; the SVG scales to the print column via CSS. */
const CHART_WIDTH_PX = 760;
const CHART_HEIGHT_PX = 380;

/** Delay before firing `print()` so the new tab lays the document out first. */
const PRINT_SETTLE_MS = 300;

/**
 * Export `messages` as a PDF (via a print-ready tab) or a Markdown file.
 *
 * For `"pdf"` a new tab is opened **synchronously** (before any async
 * embed resolution) so browser popup blockers - which only allow
 * `window.open` inside a user gesture - don't swallow it; the resolved
 * document is written in once charts / tables are ready. If the popup is
 * blocked anyway, the HTML is downloaded as a file instead so the export
 * still succeeds.
 */
export async function exportChat(options: ExportChatOptions): Promise<void> {
  const { messages, format, resolver } = options;
  const title = options.title?.trim() || "Conversation";
  const stem = options.filename?.trim() || slugify(title);

  if (format === "markdown") {
    const md = await buildMarkdown(messages, resolver, title);
    downloadTextFile(`${stem}.md`, md, "text/markdown;charset=utf-8");
    return;
  }

  // Open the tab up-front (user-gesture safe), show a placeholder while
  // embeds resolve, then swap in the finished document and print.
  const win = window.open("", "_blank");
  win?.document.write(PREPARING_HTML);
  const html = await buildHtmlDocument(messages, resolver, title);
  if (!win) {
    // Popup blocked: fall back to an HTML file download so the export
    // (charts included) still lands.
    downloadTextFile(`${stem}.html`, html, "text/html;charset=utf-8");
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
  win.setTimeout(() => win.print(), PRINT_SETTLE_MS);
}

/* ------------------------------- segments -------------------------------- */

/** One slice of a message: prose, a chart embed, or a data embed. */
type Segment =
  | { kind: "text"; text: string }
  | { kind: "chart"; id: string }
  | { kind: "data"; id: string };

/**
 * Split message text into prose / chart / data segments at
 * `[chart:<uuid>]` / `[data:<uuid>]` marker positions. Mirrors the live
 * `MarkdownWithEmbeds` splitter so an export matches what's on screen:
 * non-UUID (fabricated) ids and unknown marker types collapse away so no
 * literal `[type:...]` leaks into the output.
 */
function splitSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  for (const marker of parseMarkers(text)) {
    if (marker.start > last) {
      segments.push({ kind: "text", text: text.slice(last, marker.start) });
    }
    if (isUuid(marker.id) && (marker.type === "chart" || marker.type === "data")) {
      segments.push({ kind: marker.type, id: marker.id });
    }
    last = marker.end;
  }
  if (last < text.length) segments.push({ kind: "text", text: text.slice(last) });
  return segments;
}

/** Concatenate a message's `text` parts (matches the on-screen bubbles). */
function messageText(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/** Human label for a message role. */
function roleLabel(role: UIMessage["role"]): string {
  if (role === "user") return "You";
  if (role === "assistant") return "Assistant";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/* --------------------------------- HTML ---------------------------------- */

/** Build the full standalone HTML document string. */
async function buildHtmlDocument(
  messages: UIMessage[],
  resolver: EmbedResolver,
  title: string,
): Promise<string> {
  const articles: string[] = [];
  for (const message of messages) {
    const body = await messageBodyHtml(message, resolver);
    if (!body) continue;
    articles.push(
      `<article class="msg msg-${escapeHtml(message.role)}">` +
        `<div class="role">${escapeHtml(roleLabel(message.role))}</div>` +
        `<div class="content">${body}</div></article>`,
    );
  }
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(title)}</title><style>${PRINT_CSS}</style></head>` +
    `<body><header class="doc-header"><h1>${escapeHtml(title)}</h1>` +
    `<div class="doc-meta">Exported ${escapeHtml(new Date().toLocaleString())}</div>` +
    `</header><main>${articles.join("")}</main></body></html>`
  );
}

/** Render one message's body (prose + inlined charts / tables) to HTML. */
async function messageBodyHtml(
  message: UIMessage,
  resolver: EmbedResolver,
): Promise<string> {
  const isAssistant = message.role === "assistant";
  const parts: string[] = [];
  for (const seg of splitSegments(messageText(message))) {
    if (seg.kind === "text") {
      if (!seg.text.trim()) continue;
      parts.push(
        isAssistant
          ? markdownToHtml(seg.text)
          : `<p class="plain">${escapeHtml(seg.text)}</p>`,
      );
      continue;
    }
    if (seg.kind === "chart") {
      const svg = await chartSvg(resolver, seg.id);
      if (svg) parts.push(`<div class="embed embed-chart">${svg}</div>`);
      continue;
    }
    const table = await dataTableHtml(resolver, seg.id);
    if (table) parts.push(table);
  }
  return parts.join("\n");
}

/** Render a markdown fragment to an HTML string (GFM tables, line breaks). */
function markdownToHtml(md: string): string {
  return marked.parse(md, { async: false, gfm: true, breaks: true }) as string;
}

/**
 * Resolve a chart id and render its Echarts spec to an inline SVG string
 * via server-side rendering (no DOM). Returns `null` when the id is
 * unknown / expired / still processing, or if rendering throws.
 */
async function chartSvg(resolver: EmbedResolver, id: string): Promise<string | null> {
  try {
    const chart = await resolver.chart(id);
    if (!chart?.result) return null;
    const instance = echarts.init(null, undefined, {
      renderer: "svg",
      ssr: true,
      width: CHART_WIDTH_PX,
      height: CHART_HEIGHT_PX,
    });
    try {
      instance.setOption(chart.result.option as echarts.EChartsCoreOption);
      return instance.renderToSVGString();
    } finally {
      instance.dispose();
    }
  } catch {
    return null;
  }
}

/** Resolve a data id and render its rows to an HTML table. `null` on miss. */
async function dataTableHtml(
  resolver: EmbedResolver,
  id: string,
): Promise<string | null> {
  const data = await safeStatement(resolver, id);
  if (!data || data.rows.length === 0) return null;
  const head = data.columns
    .map((c) => `<th>${escapeHtml(humanizeHeader(c))}</th>`)
    .join("");
  const body = data.rows
    .map(
      (row) =>
        `<tr>${data.columns
          .map((c) => `<td>${escapeHtml(cellText(row[c]))}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  const note = data.truncated
    ? `<div class="embed-note">Showing ${data.rows.length} of ${data.rowCount} rows.</div>`
    : "";
  return (
    `<div class="embed embed-table"><table><thead><tr>${head}</tr></thead>` +
    `<tbody>${body}</tbody></table>${note}</div>`
  );
}

/* ------------------------------- Markdown -------------------------------- */

/** Build the whole document as a Markdown string. */
async function buildMarkdown(
  messages: UIMessage[],
  resolver: EmbedResolver,
  title: string,
): Promise<string> {
  const blocks: string[] = [`# ${title}`, `_Exported ${new Date().toLocaleString()}_`];
  for (const message of messages) {
    const body = await messageBodyMarkdown(message, resolver);
    if (!body.trim()) continue;
    blocks.push(`## ${roleLabel(message.role)}`);
    blocks.push(body);
  }
  return `${blocks.join("\n\n")}\n`;
}

/** Render one message's body to Markdown (charts noted, tables as GFM). */
async function messageBodyMarkdown(
  message: UIMessage,
  resolver: EmbedResolver,
): Promise<string> {
  const parts: string[] = [];
  for (const seg of splitSegments(messageText(message))) {
    if (seg.kind === "text") {
      if (seg.text.trim()) parts.push(seg.text.trim());
      continue;
    }
    if (seg.kind === "chart") {
      const chart = await safeChart(resolver, seg.id);
      if (chart?.result) parts.push(`> **Chart:** ${chartTitle(chart)}`);
      continue;
    }
    const table = await dataTableMarkdown(resolver, seg.id);
    if (table) parts.push(table);
  }
  return parts.join("\n\n");
}

/** Best-effort chart title from the Echarts spec, for the Markdown note. */
function chartTitle(chart: Chart): string {
  const option = chart.result?.option as { title?: unknown } | undefined;
  const title = option?.title;
  const text =
    (Array.isArray(title) ? title[0]?.text : (title as { text?: unknown })?.text) ??
    undefined;
  const label = typeof text === "string" ? text.trim() : "";
  return label || `${chart.result?.chartType ?? "chart"} chart`;
}

/** Render statement rows to a GFM table. `null` on miss / empty. */
async function dataTableMarkdown(
  resolver: EmbedResolver,
  id: string,
): Promise<string | null> {
  const data = await safeStatement(resolver, id);
  if (!data || data.rows.length === 0) return null;
  const header = `| ${data.columns.map((c) => mdCell(humanizeHeader(c))).join(" | ")} |`;
  const sep = `| ${data.columns.map(() => "---").join(" | ")} |`;
  const rows = data.rows.map(
    (row) => `| ${data.columns.map((c) => mdCell(cellText(row[c]))).join(" | ")} |`,
  );
  const note = data.truncated
    ? `\n\n_Showing ${data.rows.length} of ${data.rowCount} rows._`
    : "";
  return `${[header, sep, ...rows].join("\n")}${note}`;
}

/* -------------------------------- helpers -------------------------------- */

/** Resolve a chart id, swallowing errors (best-effort export). */
async function safeChart(
  resolver: EmbedResolver,
  id: string,
): Promise<Chart | undefined> {
  try {
    return await resolver.chart(id);
  } catch {
    return undefined;
  }
}

/** Resolve a statement id, swallowing errors (best-effort export). */
async function safeStatement(
  resolver: EmbedResolver,
  id: string,
): Promise<StatementData | undefined> {
  try {
    return await resolver.statement(id);
  } catch {
    return undefined;
  }
}

/** Stringify a table cell value for display. */
function cellText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Escape a Markdown table cell (pipes / newlines would break the row). */
function mdCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Title-case a snake/kebab/camel column name for a header label. */
function humanizeHeader(name: string): string {
  return name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Escape the five HTML-significant characters. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Turn a title into a safe, lowercase filename stem. */
function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "conversation";
}

/** Trigger a browser download of an in-memory text file. */
function downloadTextFile(filename: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Placeholder shown in the print tab while embeds resolve. */
const PREPARING_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>Preparing export...</title>' +
  '<style>body{font:14px system-ui,sans-serif;color:#475569;display:flex;' +
  "height:100vh;margin:0;align-items:center;justify-content:center}</style></head>" +
  "<body>Preparing export...</body></html>";

/**
 * Inline stylesheet for the exported document. Tuned for print: a
 * readable measure, role-labelled message blocks, framed charts / tables
 * that don't split across pages, and a hidden print-button chrome.
 */
const PRINT_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    font: 15px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #0f172a; margin: 0; padding: 32px; background: #fff;
  }
  main { max-width: 820px; margin: 0 auto; }
  .doc-header { max-width: 820px; margin: 0 auto 24px; border-bottom: 1px solid #e2e8f0; padding-bottom: 12px; }
  .doc-header h1 { font-size: 22px; margin: 0 0 4px; }
  .doc-meta { font-size: 12px; color: #64748b; }
  .msg { margin: 0 0 20px; break-inside: avoid; }
  .msg .role { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: #64748b; margin-bottom: 4px; }
  .msg-user .content { background: #f1f5f9; border-radius: 8px; padding: 10px 14px; }
  .msg .content > *:first-child { margin-top: 0; }
  .msg .content > *:last-child { margin-bottom: 0; }
  .plain { white-space: pre-wrap; margin: 0; }
  p { margin: 0 0 10px; }
  h1, h2, h3, h4 { line-height: 1.3; margin: 18px 0 8px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; background: #f1f5f9; padding: .1em .3em; border-radius: 4px; }
  pre { background: #0f172a; color: #e2e8f0; padding: 12px 14px; border-radius: 8px; overflow-x: auto; break-inside: avoid; }
  pre code { background: none; padding: 0; color: inherit; }
  a { color: #2563eb; }
  .embed { margin: 12px 0; break-inside: avoid; }
  .embed-chart { border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px; }
  .embed-chart svg { max-width: 100%; height: auto; display: block; margin: 0 auto; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border: 1px solid #e2e8f0; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: #f8fafc; font-weight: 600; }
  .embed-note { font-size: 12px; color: #64748b; margin-top: 6px; }
  @media print { body { padding: 0; } a { color: inherit; text-decoration: none; } }
`;
