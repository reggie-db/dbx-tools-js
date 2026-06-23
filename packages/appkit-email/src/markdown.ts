/**
 * Server-side markdown -> HTML rendering for email bodies. The model
 * drafts bodies in markdown; this turns them into real HTML (GFM tables,
 * lists, code, links). {@link normalizeMarkdown} first repairs the two
 * structures LLMs most often emit as plain text instead of markdown -
 * `=====` divider rules and pipe tables missing their `| --- |`
 * separator row - so they render as a `<hr>` / `<table>` rather than
 * literal text. The prompt steers the model away from ASCII art; this is
 * the belt-and-suspenders fallback.
 */

import { marked } from "marked";

/** A line of only `=` or `_` (length >= 3): an ASCII divider rule. */
function isAsciiRule(line: string): boolean {
  return /^[ \t]*[=_]{3,}[ \t]*$/.test(line);
}

/** A line that participates in a markdown pipe table (has a `|`). */
function isPipeRow(line: string): boolean {
  return line.includes("|") && line.trim().length > 0;
}

/** A markdown table separator row, e.g. `| --- | :--: |`. */
function isSeparatorRow(line: string): boolean {
  return /^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)+\|?[ \t]*$/.test(line);
}

/** Column count of a pipe row (outer pipes optional). */
function pipeColumns(line: string): number {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|").length;
}

/** A GFM separator row with `columns` cells. */
function separatorRow(columns: number): string {
  return `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`;
}

/**
 * Repair common LLM "looks-like-markdown-but-isn't" output: convert
 * standalone `=====` / `_____` rules to a `---` thematic break (leaving
 * genuine setext-heading underlines intact), and insert a `| --- |`
 * separator after the first row of a pipe block that lacks one so GFM
 * renders it as a table.
 */
export function normalizeMarkdown(src: string): string {
  const lines = src.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const prev = i > 0 ? lines[i - 1]! : "";
    const next = i + 1 < lines.length ? lines[i + 1]! : "";

    if (isAsciiRule(line)) {
      // A run of `=` directly under a non-blank text line is a setext H1
      // underline - keep it. Anything else is a decorative divider.
      const isSetextUnderline =
        /^[ \t]*={3,}[ \t]*$/.test(line) && prev.trim() !== "" && !isPipeRow(prev);
      out.push(isSetextUnderline ? line : "---");
      continue;
    }

    // First row of a pipe block (prev is not itself a pipe row) followed
    // by another aligned pipe row, with no separator and no `###` bar-
    // chart fill: treat as a table header and inject the separator.
    const startsPipeBlock = isPipeRow(line) && !isPipeRow(prev);
    if (
      startsPipeBlock &&
      isPipeRow(next) &&
      !isSeparatorRow(next) &&
      !/#{3,}/.test(line) &&
      pipeColumns(line) >= 2 &&
      pipeColumns(line) === pipeColumns(next)
    ) {
      out.push(line);
      out.push(separatorRow(pipeColumns(line)));
      continue;
    }

    out.push(line);
  }
  return out.join("\n");
}

/** Render a markdown body to an HTML fragment (GFM tables enabled). */
export function markdownToHtml(body: string): string {
  return marked.parse(normalizeMarkdown(body), { async: false, gfm: true, breaks: true });
}
