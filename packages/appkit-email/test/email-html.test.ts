import { describe, expect, it } from "bun:test";

import { escapeHtml, renderEmailHtml } from "../src/email-html.js";

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x" data='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; data=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });

  it("leaves plain text unchanged", () => {
    expect(escapeHtml("just text")).toBe("just text");
  });
});

describe("renderEmailHtml", () => {
  it("produces a complete style-inlined HTML document", () => {
    const html = renderEmailHtml({ subject: "Report", body: "Hello **world**" });
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>Report</title>");
    expect(html).toContain("<strong>world</strong>");
  });

  it('defaults the title to "Message" when subject is empty', () => {
    expect(renderEmailHtml({ subject: "   ", body: "hi" })).toContain(
      "<title>Message</title>",
    );
  });

  it("escapes the subject so markup in it cannot break the layout", () => {
    const html = renderEmailHtml({ subject: "<script>alert(1)</script>", body: "x" });
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("renders the optional envelope-header rows", () => {
    const html = renderEmailHtml({
      subject: "s",
      body: "b",
      headers: [["To", "alice@example.com"]],
    });
    expect(html).toContain("To");
    expect(html).toContain("alice@example.com");
  });

  it("omits the footer when none is given and includes it when set", () => {
    expect(renderEmailHtml({ subject: "s", body: "b" })).not.toContain(
      "sent by the robot",
    );
    expect(
      renderEmailHtml({ subject: "s", body: "b", footer: "sent by the robot" }),
    ).toContain("sent by the robot");
  });
});
