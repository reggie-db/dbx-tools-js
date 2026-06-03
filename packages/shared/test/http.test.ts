import { describe, expect, it } from "bun:test";

import {
  forEachHeaderValue,
  joinUrlSegments,
  parseCookies,
  toURL,
} from "../src/http.js";

function collect(
  input: Parameters<typeof forEachHeaderValue>[0],
  headerName: string,
): string[] {
  const out: string[] = [];
  forEachHeaderValue(input, headerName, (v) => out.push(v));
  return out;
}

// Minimal shims of the request shapes each library hands us. We assert against
// the structural type the helpers accept rather than pulling in the libraries
// themselves, so the tests stay lightweight and library-agnostic.
const expressLikeReq = {
  // Express / Node lower-case keys, repeated headers become arrays.
  headers: {
    cookie: "session=abc; theme=dark",
    "x-trace-id": "trace-42",
    "set-cookie": ["a=1; Path=/", "b=2; Path=/"],
    accept: "application/json",
  },
};

const expressLikeRes = {
  // Express `res.getHeaders()` returns this shape. Callers can pass it as
  // a plain record.
  cookie: undefined,
  "set-cookie": ["sid=xyz; HttpOnly", "lang=en"],
};

const honoLikeCtx = (() => {
  // Hono's `c.req.raw` is a WHATWG Request. The header bag is a Headers
  // instance, so we model that exactly.
  const headers = new Headers();
  headers.append("cookie", "session=abc; theme=dark");
  headers.append("x-trace-id", "trace-42");
  headers.append("set-cookie", "a=1; Path=/");
  headers.append("set-cookie", "b=2; Path=/");
  return { headers };
})();

describe("joinUrlSegments", () => {
  describe("empty / nullish input", () => {
    it("returns '' for no arguments", () => {
      expect(joinUrlSegments()).toBe("");
    });

    it("returns '' for a single null/undefined arg", () => {
      expect(joinUrlSegments(null)).toBe("");
      expect(joinUrlSegments(undefined)).toBe("");
    });

    it("returns '' for blank strings (after trim)", () => {
      expect(joinUrlSegments("")).toBe("");
      expect(joinUrlSegments("   ")).toBe("");
      expect(joinUrlSegments("", null, "  ", undefined)).toBe("");
    });

    it("returns '' for an empty array", () => {
      expect(joinUrlSegments([])).toBe("");
    });
  });

  describe("string segments", () => {
    it("path-absolute prefixes the join", () => {
      expect(joinUrlSegments("a", "b")).toBe("/a/b");
    });

    it("strips a single leading and trailing slash per segment", () => {
      expect(joinUrlSegments("/a/", "/b/", "c")).toBe("/a/b/c");
    });

    it("trims whitespace before stripping slashes", () => {
      expect(joinUrlSegments("  /api/  ", "  v2  ")).toBe("/api/v2");
    });

    it("drops nullish and blank segments mid-list", () => {
      expect(joinUrlSegments("", "a", null, "b", undefined)).toBe("/a/b");
    });

    it("preserves a `://` scheme on the first segment", () => {
      expect(joinUrlSegments("https://example.com", "/api/x")).toBe(
        "https://example.com/api/x",
      );
    });

    it("strips a trailing slash from a host segment", () => {
      expect(joinUrlSegments("https://example.com/", "x")).toBe(
        "https://example.com/x",
      );
    });
  });

  describe("array segments", () => {
    it("flattens a single array argument", () => {
      // Regression: previously returned "" because `else if (!!urlSegment)`
      // treated a truthy non-string single arg as empty.
      expect(joinUrlSegments(["a", "b"])).toBe("/a/b");
    });

    it("inlines an array between string segments without doubling slashes", () => {
      // Regression: previously returned "//a/b/c" because the inner result
      // kept its leading `/` and the outer prepend added another.
      expect(joinUrlSegments(["a", "b"], "c")).toBe("/a/b/c");
      expect(joinUrlSegments("a", ["b", "c"])).toBe("/a/b/c");
    });

    it("recurses into nested arrays", () => {
      expect(joinUrlSegments(["a", ["b", "c"]], "d")).toBe("/a/b/c/d");
    });

    it("drops empty arrays", () => {
      expect(joinUrlSegments("a", [], "b")).toBe("/a/b");
      expect(joinUrlSegments([null, "", undefined])).toBe("");
    });
  });
});

describe("toURL", () => {
  describe("string input", () => {
    it("auto-prefixes https:// for bare hostnames", () => {
      expect(toURL("example.com")?.toString()).toBe("https://example.com/");
    });

    it("preserves an explicit scheme", () => {
      expect(toURL("http://example.com/path")?.toString()).toBe(
        "http://example.com/path",
      );
    });

    it("trims surrounding whitespace", () => {
      expect(toURL("  example.com  ")?.toString()).toBe("https://example.com/");
    });

    it("returns null for empty / blank strings", () => {
      expect(toURL("")).toBeNull();
      expect(toURL("   ")).toBeNull();
    });

    it("returns null for malformed input with no path fallback", () => {
      // `://` alone has no host - URL constructor rejects.
      expect(toURL("://")).toBeNull();
    });

    it("treats a bare '/' as 'no host' and returns null when no path", () => {
      expect(toURL("/")).toBeNull();
    });

    it("treats a bare '/' as 'no host' and falls back to localhost when given a path", () => {
      expect(toURL("/", "/api/x")?.toString()).toBe("http://localhost/api/x");
    });
  });

  describe("nullish input", () => {
    it("returns null without a path", () => {
      expect(toURL(null)).toBeNull();
      expect(toURL(undefined)).toBeNull();
    });

    it("falls back to http://localhost when a path is supplied", () => {
      expect(toURL(null, "/api/x")?.toString()).toBe("http://localhost/api/x");
      expect(toURL(undefined, "api", "v2")?.toString()).toBe(
        "http://localhost/api/v2",
      );
    });
  });

  describe("URL instance input", () => {
    it("returns the same URL when no path is appended", () => {
      const u = new URL("https://example.com/x");
      expect(toURL(u)?.toString()).toBe("https://example.com/x");
    });

    it("appends a path to a URL instance", () => {
      const u = new URL("https://example.com/y");
      expect(toURL(u, "/x")?.toString()).toBe("https://example.com/y/x");
    });
  });

  describe("{ url } input", () => {
    it("unwraps a `url` field", () => {
      expect(toURL({ url: "http://y" })?.toString()).toBe("http://y/");
    });

    it("appends a path through a `url` field", () => {
      expect(toURL({ url: "https://api.example" }, "/v1/items")?.toString()).toBe(
        "https://api.example/v1/items",
      );
    });
  });

  describe("path varargs", () => {
    it("joins multiple string path args", () => {
      expect(toURL("example.com", "/api", "v2", "items")?.toString()).toBe(
        "https://example.com/api/v2/items",
      );
    });

    it("flattens an array path arg", () => {
      // Regression: previously dropped the array silently, returning just `https://example.com/`.
      expect(toURL("example.com", ["api", "v2"])?.toString()).toBe(
        "https://example.com/api/v2",
      );
    });

    it("flattens an array mixed with strings without doubling slashes", () => {
      expect(toURL("example.com", ["a", "b"], "c")?.toString()).toBe(
        "https://example.com/a/b/c",
      );
    });

    it("normalizes leading/trailing slashes on each segment", () => {
      expect(toURL("example.com", "/api", "/v2/", "/x/")?.toString()).toBe(
        "https://example.com/api/v2/x",
      );
    });

    it("strips a trailing slash on the host before joining the path", () => {
      // Regression: `cool/` + `/api` should produce one boundary slash,
      // not `https://cool//api`.
      expect(toURL("cool/", "/api")?.toString()).toBe("https://cool/api");
      expect(toURL("cool/", "api")?.toString()).toBe("https://cool/api");
      expect(toURL("example.com/", "/api/v2")?.toString()).toBe(
        "https://example.com/api/v2",
      );
      expect(toURL("https://x/", "/api")?.toString()).toBe("https://x/api");
    });

    it("ignores nullish path segments", () => {
      expect(toURL("example.com", null, "x", undefined)?.toString()).toBe(
        "https://example.com/x",
      );
    });
  });
});

describe("forEachHeaderValue", () => {
  describe("record input (Express / Node IncomingMessage)", () => {
    it("matches case-insensitively", () => {
      expect(collect(expressLikeReq, "X-Trace-Id")).toEqual(["trace-42"]);
      expect(collect(expressLikeReq, "x-trace-id")).toEqual(["trace-42"]);
    });

    it("emits one call per array entry for repeated headers", () => {
      expect(collect(expressLikeReq, "set-cookie")).toEqual([
        "a=1; Path=/",
        "b=2; Path=/",
      ]);
    });

    it("returns nothing for missing headers", () => {
      expect(collect(expressLikeReq, "authorization")).toEqual([]);
    });

    it("skips null / undefined values", () => {
      expect(collect({ headers: { foo: undefined } }, "foo")).toEqual([]);
    });

    it("accepts a flat header record directly", () => {
      expect(collect(expressLikeReq.headers, "cookie")).toEqual([
        "session=abc; theme=dark",
      ]);
    });

    it("accepts the result of `res.getHeaders()` directly", () => {
      expect(collect(expressLikeRes, "set-cookie")).toEqual([
        "sid=xyz; HttpOnly",
        "lang=en",
      ]);
    });
  });

  describe("WHATWG Headers (fetch / Hono / undici)", () => {
    it("reads non-cookie headers via `get` (single emit)", () => {
      expect(collect(honoLikeCtx, "x-trace-id")).toEqual(["trace-42"]);
    });

    it("uses `getSetCookie` so Set-Cookie callers get one value per cookie", () => {
      expect(collect(honoLikeCtx, "set-cookie")).toEqual([
        "a=1; Path=/",
        "b=2; Path=/",
      ]);
    });

    it("returns nothing for missing headers", () => {
      expect(collect(new Headers(), "authorization")).toEqual([]);
    });

    it("accepts a Headers instance directly", () => {
      const h = new Headers({ accept: "application/json" });
      expect(collect(h, "accept")).toEqual(["application/json"]);
    });

    it("accepts a fetch Request directly", () => {
      const req = new Request("https://example.com", {
        headers: { authorization: "Bearer token" },
      });
      expect(collect(req, "authorization")).toEqual(["Bearer token"]);
    });

    it("accepts a fetch Response directly", () => {
      const res = new Response(null, {
        headers: [
          ["set-cookie", "a=1"],
          ["set-cookie", "b=2"],
        ],
      });
      expect(collect(res, "set-cookie")).toEqual(["a=1", "b=2"]);
    });
  });

  describe("nullish input", () => {
    it("no-ops on undefined", () => {
      expect(collect(undefined, "cookie")).toEqual([]);
    });

    it("no-ops on null", () => {
      expect(collect(null, "cookie")).toEqual([]);
    });

    it("no-ops on { headers: undefined }", () => {
      expect(
        collect({ headers: undefined as unknown as Record<string, string> }, "cookie"),
      ).toEqual([]);
    });
  });
});

describe("parseCookies", () => {
  describe("string input", () => {
    it("parses a single Cookie header value", () => {
      expect(parseCookies("session=abc; theme=dark")).toEqual({
        session: "abc",
        theme: "dark",
      });
    });

    it("trims surrounding whitespace", () => {
      expect(parseCookies("  a = 1 ;  b = 2  ")).toEqual({ a: "1", b: "2" });
    });

    it("URI-decodes values", () => {
      expect(parseCookies("token=foo%20bar%2Bbaz")).toEqual({ token: "foo bar+baz" });
    });

    it("ignores malformed segments (no '=')", () => {
      expect(parseCookies("a=1; broken; b=2")).toEqual({ a: "1", b: "2" });
    });

    it("ignores empty names", () => {
      expect(parseCookies("=oops; a=1")).toEqual({ a: "1" });
    });

    it("first value wins on duplicates", () => {
      expect(parseCookies("a=first; a=second")).toEqual({ a: "first" });
    });

    it("returns {} on empty input", () => {
      expect(parseCookies("")).toEqual({});
    });
  });

  describe("array input (multiple Cookie headers)", () => {
    it("merges across array entries, first occurrence wins", () => {
      expect(parseCookies(["a=1; b=2", "a=overridden; c=3"])).toEqual({
        a: "1",
        b: "2",
        c: "3",
      });
    });

    it("tolerates non-string array entries", () => {
      const input = ["a=1", undefined] as Parameters<typeof parseCookies>[0];
      expect(parseCookies(input)).toEqual({ a: "1" });
    });
  });

  describe("Express / Node request", () => {
    it("reads from req.headers.cookie", () => {
      expect(parseCookies(expressLikeReq)).toEqual({
        session: "abc",
        theme: "dark",
      });
    });

    it("accepts the headers record directly", () => {
      expect(parseCookies(expressLikeReq.headers)).toEqual({
        session: "abc",
        theme: "dark",
      });
    });
  });

  describe("WHATWG Request / Headers / Hono", () => {
    it("reads from a Hono-style { headers: Headers } context", () => {
      expect(parseCookies(honoLikeCtx)).toEqual({
        session: "abc",
        theme: "dark",
      });
    });

    it("reads from a Headers instance directly", () => {
      const h = new Headers({ cookie: "a=1; b=2" });
      expect(parseCookies(h)).toEqual({ a: "1", b: "2" });
    });

    it("reads from a fetch Request directly", () => {
      const req = new Request("https://example.com", {
        headers: { cookie: "session=abc; theme=dark" },
      });
      expect(parseCookies(req)).toEqual({
        session: "abc",
        theme: "dark",
      });
    });
  });

  describe("nullish input", () => {
    it("returns {} on undefined", () => {
      expect(parseCookies(undefined)).toEqual({});
    });

    it("returns {} on null", () => {
      expect(parseCookies(null)).toEqual({});
    });

    it("returns {} when cookie header is absent", () => {
      expect(parseCookies({ headers: { accept: "application/json" } })).toEqual({});
    });
  });
});
