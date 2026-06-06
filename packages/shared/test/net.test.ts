import { describe, expect, it } from "bun:test";

import { joinUrl, parseUrl } from "../src/net.browser.js";

describe("joinUrl", () => {
  describe("empty / nullish input", () => {
    it("returns '' for no arguments", () => {
      expect(joinUrl()).toBe("");
    });

    it("returns '' for a single null/undefined arg", () => {
      expect(joinUrl(null)).toBe("");
      expect(joinUrl(undefined)).toBe("");
    });

    it("returns '' for blank strings (after trim)", () => {
      expect(joinUrl("")).toBe("");
      expect(joinUrl("   ")).toBe("");
      expect(joinUrl("", null, "  ", undefined)).toBe("");
    });

    it("returns '' for an empty array", () => {
      expect(joinUrl([])).toBe("");
    });
  });

  describe("string segments", () => {
    it("path-absolute prefixes the join", () => {
      expect(joinUrl("a", "b")).toBe("/a/b");
    });

    it("strips a single leading and trailing slash per segment", () => {
      expect(joinUrl("/a/", "/b/", "c")).toBe("/a/b/c");
    });

    it("trims whitespace before stripping slashes", () => {
      expect(joinUrl("  /api/  ", "  v2  ")).toBe("/api/v2");
    });

    it("drops nullish and blank segments mid-list", () => {
      expect(joinUrl("", "a", null, "b", undefined)).toBe("/a/b");
    });

    it("preserves a `://` scheme on the first segment", () => {
      expect(joinUrl("https://example.com", "/api/x")).toBe(
        "https://example.com/api/x",
      );
    });

    it("strips a trailing slash from a host segment", () => {
      expect(joinUrl("https://example.com/", "x")).toBe("https://example.com/x");
    });
  });

  describe("array segments", () => {
    it("flattens a single array argument", () => {
      // Regression: previously returned "" because `else if (!!urlSegment)`
      // treated a truthy non-string single arg as empty.
      expect(joinUrl(["a", "b"])).toBe("/a/b");
    });

    it("inlines an array between string segments without doubling slashes", () => {
      // Regression: previously returned "//a/b/c" because the inner result
      // kept its leading `/` and the outer prepend added another.
      expect(joinUrl(["a", "b"], "c")).toBe("/a/b/c");
      expect(joinUrl("a", ["b", "c"])).toBe("/a/b/c");
    });

    it("recurses into nested arrays", () => {
      expect(joinUrl(["a", ["b", "c"]], "d")).toBe("/a/b/c/d");
    });

    it("drops empty arrays", () => {
      expect(joinUrl("a", [], "b")).toBe("/a/b");
      expect(joinUrl([null, "", undefined])).toBe("");
    });
  });
});

describe("parseUrl", () => {
  describe("string input", () => {
    it("auto-prefixes https:// for bare hostnames", () => {
      expect(parseUrl("example.com")?.toString()).toBe("https://example.com/");
    });

    it("preserves an explicit scheme", () => {
      expect(parseUrl("http://example.com/path")?.toString()).toBe(
        "http://example.com/path",
      );
    });

    it("trims surrounding whitespace", () => {
      expect(parseUrl("  example.com  ")?.toString()).toBe("https://example.com/");
    });

    it("returns null for empty / blank strings", () => {
      expect(parseUrl("")).toBeNull();
      expect(parseUrl("   ")).toBeNull();
    });

    it("returns null for malformed input with no path fallback", () => {
      // `://` alone has no host - URL constructor rejects.
      expect(parseUrl("://")).toBeNull();
    });

    it("treats a bare '/' as 'no host' and returns null when no path", () => {
      expect(parseUrl("/")).toBeNull();
    });

    it("treats a bare '/' as 'no host' and falls back to localhost when given a path", () => {
      expect(parseUrl("/", "/api/x")?.toString()).toBe("http://localhost/api/x");
    });
  });

  describe("nullish input", () => {
    it("returns null without a path", () => {
      expect(parseUrl(null)).toBeNull();
      expect(parseUrl(undefined)).toBeNull();
    });

    it("falls back to http://localhost when a path is supplied", () => {
      expect(parseUrl(null, "/api/x")?.toString()).toBe("http://localhost/api/x");
      expect(parseUrl(undefined, "api", "v2")?.toString()).toBe(
        "http://localhost/api/v2",
      );
    });
  });

  describe("URL instance input", () => {
    it("returns the same URL when no path is appended", () => {
      const u = new URL("https://example.com/x");
      expect(parseUrl(u)?.toString()).toBe("https://example.com/x");
    });

    it("appends a path to a URL instance", () => {
      const u = new URL("https://example.com/y");
      expect(parseUrl(u, "/x")?.toString()).toBe("https://example.com/y/x");
    });
  });

  describe("{ url } input", () => {
    it("unwraps a `url` field", () => {
      expect(parseUrl({ url: "http://y" })?.toString()).toBe("http://y/");
    });

    it("appends a path through a `url` field", () => {
      expect(parseUrl({ url: "https://api.example" }, "/v1/items")?.toString()).toBe(
        "https://api.example/v1/items",
      );
    });
  });

  describe("path varargs", () => {
    it("joins multiple string path args", () => {
      expect(parseUrl("example.com", "/api", "v2", "items")?.toString()).toBe(
        "https://example.com/api/v2/items",
      );
    });

    it("flattens an array path arg", () => {
      // Regression: previously dropped the array silently, returning just `https://example.com/`.
      expect(parseUrl("example.com", ["api", "v2"])?.toString()).toBe(
        "https://example.com/api/v2",
      );
    });

    it("flattens an array mixed with strings without doubling slashes", () => {
      expect(parseUrl("example.com", ["a", "b"], "c")?.toString()).toBe(
        "https://example.com/a/b/c",
      );
    });

    it("normalizes leading/trailing slashes on each segment", () => {
      expect(parseUrl("example.com", "/api", "/v2/", "/x/")?.toString()).toBe(
        "https://example.com/api/v2/x",
      );
    });

    it("strips a trailing slash on the host before joining the path", () => {
      // Regression: `cool/` + `/api` should produce one boundary slash,
      // not `https://cool//api`.
      expect(parseUrl("cool/", "/api")?.toString()).toBe("https://cool/api");
      expect(parseUrl("cool/", "api")?.toString()).toBe("https://cool/api");
      expect(parseUrl("example.com/", "/api/v2")?.toString()).toBe(
        "https://example.com/api/v2",
      );
      expect(parseUrl("https://x/", "/api")?.toString()).toBe("https://x/api");
    });

    it("ignores nullish path segments", () => {
      expect(parseUrl("example.com", null, "x", undefined)?.toString()).toBe(
        "https://example.com/x",
      );
    });
  });
});
