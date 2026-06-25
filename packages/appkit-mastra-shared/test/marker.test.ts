import { describe, expect, it } from "bun:test";

import { isUuid, parseMarkers, stripIncompleteMarkerTail } from "../src/marker.js";

// A real v4 chart id and a v7-style (time-ordered) statement id: the two
// id shapes the grammar's docstring calls out as genuine embeds.
const V4 = "01f163b6-1eac-4c2a-9b3e-2f7d8a1c4e5f";
const V7 = "018f1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5b";

describe("isUuid", () => {
  it("accepts an 8-4-4-4-12 hex id regardless of version", () => {
    expect(isUuid(V4)).toBe(true);
    expect(isUuid(V7)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isUuid(V4.toUpperCase())).toBe(true);
  });

  it("rejects fabricated labels the model glued into a marker", () => {
    expect(isUuid("placeholder")).toBe(false);
    expect(isUuid("01f163b6-1eac-region-fill-oos")).toBe(false);
  });

  it("rejects partial or empty ids", () => {
    expect(isUuid("01f163b6-1eac")).toBe(false);
    expect(isUuid("")).toBe(false);
  });
});

describe("parseMarkers", () => {
  it("returns an empty list when there are no markers", () => {
    expect(parseMarkers("just some prose with no embeds")).toEqual([]);
  });

  it("captures the type and id with a span that splices the literal", () => {
    const text = `before [chart:${V4}] after`;
    const [marker, ...rest] = parseMarkers(text);
    expect(rest).toHaveLength(0);
    expect(marker).toMatchObject({ type: "chart", id: V4 });
    expect(text.slice(marker!.start, marker!.end)).toBe(`[chart:${V4}]`);
  });

  it("returns every marker in source order", () => {
    const text = `a [chart:${V4}] b [data:${V7}] c`;
    expect(parseMarkers(text).map((m) => [m.type, m.id])).toEqual([
      ["chart", V4],
      ["data", V7],
    ]);
  });

  it("matches fabricated (non-UUID) ids so the host can obscure them", () => {
    // The grammar deliberately matches any non-bracket id token; isUuid is
    // the separate guard that tells a real embed from a bogus label.
    const [marker] = parseMarkers("[chart:placeholder]");
    expect(marker).toMatchObject({ type: "chart", id: "placeholder" });
    expect(isUuid(marker!.id)).toBe(false);
  });

  it("requires the type token to start with a letter", () => {
    expect(parseMarkers("[1chart:abc]")).toEqual([]);
  });

  it("does not match an id run broken by whitespace", () => {
    expect(parseMarkers("[chart:ab cd]")).toEqual([]);
  });

  it("does not let an id swallow a closing bracket", () => {
    expect(parseMarkers("[chart:a]b]").map((m) => m.id)).toEqual(["a"]);
  });
});

describe("stripIncompleteMarkerTail", () => {
  it("drops a trailing bracket with no type yet", () => {
    expect(stripIncompleteMarkerTail("rendering chart [")).toBe("rendering chart ");
  });

  it("drops a partial marker that hasn't received its closing bracket", () => {
    expect(stripIncompleteMarkerTail("see [data:018f1a2b")).toBe("see ");
  });

  it("leaves a completed marker untouched", () => {
    const text = `see [chart:${V4}] and more`;
    expect(stripIncompleteMarkerTail(text)).toBe(text);
  });

  it("only strips the trailing partial, keeping earlier complete markers", () => {
    expect(stripIncompleteMarkerTail(`[chart:${V4}] then [da`)).toBe(
      `[chart:${V4}] then `,
    );
  });

  it("is a no-op when a space follows the bracket (definitely not a marker)", () => {
    expect(stripIncompleteMarkerTail("a [ b")).toBe("a [ b");
  });

  it("is a no-op on text with no bracket", () => {
    expect(stripIncompleteMarkerTail("plain prose")).toBe("plain prose");
  });
});
