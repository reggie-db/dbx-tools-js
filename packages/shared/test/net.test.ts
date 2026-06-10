import { describe, expect, it } from "bun:test";

import { pathMatch, urlBuilder } from "../src/net.browser.js";

describe("urlBuilder", () => {
  describe("string input", () => {
    it("auto-prefixes https:// for bare hostnames", () => {
      expect(urlBuilder("example.com")?.toString()).toBe("https://example.com/");
    });

    it("keeps a host plus path", () => {
      expect(urlBuilder("example.com/foo")?.toString()).toBe("https://example.com/foo");
    });

    it("preserves an explicit scheme", () => {
      expect(urlBuilder("http://example.com/path")?.toString()).toBe(
        "http://example.com/path",
      );
    });

    it("preserves a full https URL", () => {
      expect(urlBuilder("https://host.example.com")?.toString()).toBe(
        "https://host.example.com/",
      );
    });

    it("trims surrounding whitespace", () => {
      expect(urlBuilder("  example.com  ")?.toString()).toBe("https://example.com/");
    });

    it("resolves an empty / blank string to the base origin", () => {
      expect(urlBuilder("")?.toString()).toBe("http://localhost/");
      expect(urlBuilder("   ")?.toString()).toBe("http://localhost/");
    });

    it("prefixes the default scheme onto a '://'-leading string", () => {
      expect(urlBuilder("://example.com")?.toString()).toBe("https://example.com/");
    });
  });

  describe("path / query / hash input", () => {
    it("resolves a bare '/' to the base origin root", () => {
      expect(urlBuilder("/")?.toString()).toBe("http://localhost/");
    });

    it("treats a leading-slash string as a path, not a host", () => {
      expect(urlBuilder("/api/v2/items")?.pathname).toBe("/api/v2/items");
      expect(urlBuilder("/api/v2/items")?.toString()).toBe(
        "http://localhost/api/v2/items",
      );
    });

    it("preserves query and hash on a leading-slash path", () => {
      const url = urlBuilder("/api/cool?q=1#frag");
      expect(url?.pathname).toBe("/api/cool");
      expect(url?.search).toBe("?q=1");
      expect(url?.hash).toBe("#frag");
    });

    it("resolves path-only input against window.location.origin in a browser", () => {
      const original = (globalThis as { window?: unknown }).window;
      (globalThis as { window?: unknown }).window = {
        location: { origin: "https://app.example.com" },
      };
      try {
        expect(urlBuilder("/api/v2/items")?.toString()).toBe(
          "https://app.example.com/api/v2/items",
        );
      } finally {
        if (original === undefined) delete (globalThis as { window?: unknown }).window;
        else (globalThis as { window?: unknown }).window = original;
      }
    });
  });

  describe("non-string input", () => {
    it("adopts a URL instance", () => {
      const u = new URL("https://example.com/x");
      expect(urlBuilder(u)?.toString()).toBe("https://example.com/x");
    });

    it("unwraps a `url` field", () => {
      expect(urlBuilder({ url: "http://y" })?.toString()).toBe("http://y/");
    });

    it("resolves the base origin when called with no argument", () => {
      expect(urlBuilder().toString()).toBe("http://localhost/");
    });
  });

  describe("scheme accessor", () => {
    it("reads the scheme without the trailing colon", () => {
      expect(urlBuilder("https://x")?.scheme).toBe("https");
    });

    it("rewrites the scheme via with('scheme', ...)", () => {
      expect(urlBuilder("https://host/p")?.with("scheme", "http").toString()).toBe(
        "http://host/p",
      );
    });
  });

  describe("withPathAppend / withPathReplace", () => {
    it("appends segments onto the existing pathname", () => {
      expect(urlBuilder("https://host/base")?.withPathAppend("a", "b").toString()).toBe(
        "https://host/base/a/b",
      );
    });

    it("replaces the pathname wholesale", () => {
      expect(
        urlBuilder("https://host/base")?.withPathReplace("a", "b").toString(),
      ).toBe("https://host/a/b");
    });

    it("flattens arrays and trims boundary slashes on each segment", () => {
      expect(
        urlBuilder("https://host")?.withPathReplace(["x", "/y/", "z"]).toString(),
      ).toBe("https://host/x/y/z");
    });

    it("drops blank segments", () => {
      expect(urlBuilder("https://host")?.withPathReplace("", "a", "").toString()).toBe(
        "https://host/a",
      );
    });

    it("leaves the source builder unchanged (copy-on-write)", () => {
      const base = urlBuilder("https://host/base")!;
      base.withPathAppend("extra");
      expect(base.pathname).toBe("/base");
    });
  });
});

describe("pathMatch", () => {
  it("matches an exact path", () => {
    expect(pathMatch("/api", "/api")).toBe(true);
  });

  it("matches a path nested beneath the prefix", () => {
    expect(pathMatch("/api/cool", "/api")).toBe(true);
    expect(pathMatch("/api/cool/deeper", "/api")).toBe(true);
  });

  it("does not match a sibling that only shares a string prefix", () => {
    expect(pathMatch("/apicool", "/api")).toBe(false);
  });

  it("ignores query and hash", () => {
    expect(pathMatch("/api/cool?q=1#frag", "/api")).toBe(true);
  });

  it("tolerates a missing leading slash on the target", () => {
    expect(pathMatch("/api/cool", "api")).toBe(true);
  });

  it("matches '/' only against the root", () => {
    expect(pathMatch("/", "/")).toBe(true);
    expect(pathMatch("/api/cool", "/")).toBe(false);
  });

  it("extracts the path from an absolute URL", () => {
    expect(pathMatch("https://host/api/cool", "/api")).toBe(true);
    expect(pathMatch("https://host/apicool", "/api")).toBe(false);
  });

  it("accepts a fetch Request (UrlLike via .url)", () => {
    const req = new Request("https://host/api/v2/items");
    expect(pathMatch(req, "/api/v2")).toBe(true);
    expect(pathMatch(req, "/api/v3")).toBe(false);
  });

  it("treats a blank string as the base origin root", () => {
    expect(pathMatch("", "/api")).toBe(false);
  });
});
