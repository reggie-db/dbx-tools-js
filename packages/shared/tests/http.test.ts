import { describe, expect, it } from "bun:test";

import { forEachHeaderValue, parseCookies } from "../src/http.js";

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
