import { describe, expect, it } from "bun:test";

import { markdownToHtml, normalizeMarkdown } from "../src/markdown.js";

describe("normalizeMarkdown", () => {
  it("converts a decorative ===== rule to a --- thematic break", () => {
    expect(normalizeMarkdown("intro\n\n=====\n\nbody")).toContain("\n---\n");
  });

  it("converts an _____ underscore rule too", () => {
    expect(normalizeMarkdown("a\n\n_____\n\nb")).toContain("\n---\n");
  });

  it("leaves a genuine setext H1 underline intact", () => {
    // A run of `=` directly under non-blank text is a heading underline,
    // not a divider, so it must survive untouched.
    expect(normalizeMarkdown("Title\n=====\n\nbody")).toContain("Title\n=====");
  });

  it("injects a separator row into a pipe table that lacks one", () => {
    const out = normalizeMarkdown("| Name | Age |\n| Alice | 30 |");
    expect(out).toBe("| Name | Age |\n| --- | --- |\n| Alice | 30 |");
  });

  it("does not double-insert when the separator is already present", () => {
    const src = "| Name | Age |\n| --- | --- |\n| Alice | 30 |";
    expect(normalizeMarkdown(src)).toBe(src);
  });

  it("leaves a single non-table pipe line alone", () => {
    expect(normalizeMarkdown("a | b")).toBe("a | b");
  });
});

describe("markdownToHtml", () => {
  it("renders a repaired pipe block as a real HTML table", () => {
    const html = markdownToHtml("| Name | Age |\n| Alice | 30 |");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>Name</th>");
    expect(html).toContain("<td>Alice</td>");
  });

  it("renders a decorative divider as an <hr>", () => {
    expect(markdownToHtml("a\n\n=====\n\nb")).toContain("<hr>");
  });

  it("renders standard GFM (headings, bold, links)", () => {
    const html = markdownToHtml("# Title\n\n**bold** and [link](https://x.com)");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain('href="https://x.com"');
  });
});
