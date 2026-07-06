import { describe, expect, it } from "bun:test";

import {
  findContainingCidr,
  ipInCidr,
  isEmail,
  parseCidr,
  parseEmails,
  parseIp,
  pathMatch,
  urlBuilder,
} from "../src/net.browser.js";

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

describe("parseIp", () => {
  it("parses a dotted-quad IPv4 into its integer value", () => {
    expect(parseIp("10.0.0.1")).toEqual({ version: 4, value: 167772161n });
    expect(parseIp("0.0.0.0")).toEqual({ version: 4, value: 0n });
    expect(parseIp("255.255.255.255")).toEqual({ version: 4, value: 4294967295n });
  });

  it("trims whitespace", () => {
    expect(parseIp("  1.2.3.4 ")?.value).toBe(16909060n);
  });

  it("rejects malformed IPv4", () => {
    expect(parseIp("256.0.0.1")).toBeNull();
    expect(parseIp("1.2.3")).toBeNull();
    expect(parseIp("1.2.3.4.5")).toBeNull();
    expect(parseIp("not-an-ip")).toBeNull();
    expect(parseIp("")).toBeNull();
  });

  it("parses IPv6, including :: compression and brackets", () => {
    expect(parseIp("::1")).toEqual({ version: 6, value: 1n });
    expect(parseIp("::")).toEqual({ version: 6, value: 0n });
    expect(parseIp("[2001:db8::1]")?.version).toBe(6);
    // A fully-expanded address equals its compressed form.
    expect(parseIp("2001:db8::1")?.value).toBe(
      parseIp("2001:0db8:0000:0000:0000:0000:0000:0001")?.value,
    );
  });

  it("parses an IPv6 address with an embedded IPv4 tail", () => {
    // ::ffff:1.2.3.4 -> low 32 bits are the v4 value, prefixed by ffff.
    expect(parseIp("::ffff:1.2.3.4")?.value).toBe((0xffffn << 32n) | 16909060n);
  });

  it("strips an IPv6 zone id", () => {
    expect(parseIp("fe80::1%eth0")?.value).toBe(parseIp("fe80::1")?.value);
  });

  it("rejects malformed IPv6", () => {
    expect(parseIp("1::2::3")).toBeNull();
    expect(parseIp("gggg::1")).toBeNull();
    expect(parseIp("1:2:3:4:5:6:7:8:9")).toBeNull();
  });
});

describe("parseCidr", () => {
  it("clears host bits from the base address", () => {
    expect(parseCidr("10.1.2.3/8")?.base).toBe(parseIp("10.0.0.0")?.value);
    expect(parseCidr("192.168.1.1/16")?.base).toBe(parseIp("192.168.0.0")?.value);
  });

  it("handles /32 (single host) and /0 (everything)", () => {
    expect(parseCidr("1.2.3.4/32")?.base).toBe(16909060n);
    expect(parseCidr("1.2.3.4/0")?.base).toBe(0n);
  });

  it("parses IPv6 CIDRs", () => {
    const cidr = parseCidr("2001:db8::/32");
    expect(cidr?.version).toBe(6);
    expect(cidr?.prefix).toBe(32);
  });

  it("rejects out-of-range prefixes and missing slash", () => {
    expect(parseCidr("10.0.0.0/33")).toBeNull();
    expect(parseCidr("2001:db8::/129")).toBeNull();
    expect(parseCidr("10.0.0.0")).toBeNull();
    expect(parseCidr("bad/8")).toBeNull();
  });
});

describe("ipInCidr", () => {
  it("matches addresses inside an IPv4 block", () => {
    expect(ipInCidr("10.1.2.3", "10.0.0.0/8")).toBe(true);
    expect(ipInCidr("10.255.255.255", "10.0.0.0/8")).toBe(true);
    expect(ipInCidr("11.0.0.1", "10.0.0.0/8")).toBe(false);
  });

  it("matches addresses inside an IPv6 block", () => {
    expect(ipInCidr("2001:db8::dead", "2001:db8::/32")).toBe(true);
    expect(ipInCidr("2001:db9::1", "2001:db8::/32")).toBe(false);
  });

  it("never matches across address families", () => {
    expect(ipInCidr("10.0.0.1", "2001:db8::/32")).toBe(false);
    expect(ipInCidr("::1", "10.0.0.0/8")).toBe(false);
  });

  it("accepts pre-parsed arguments", () => {
    const ip = parseIp("10.1.2.3")!;
    const cidr = parseCidr("10.0.0.0/8")!;
    expect(ipInCidr(ip, cidr)).toBe(true);
  });

  it("returns false for unparseable input", () => {
    expect(ipInCidr("nope", "10.0.0.0/8")).toBe(false);
    expect(ipInCidr("10.0.0.1", "nope")).toBe(false);
  });
});

describe("findContainingCidr", () => {
  it("returns the first matching range and preserves side metadata", () => {
    const ranges = [
      { ...parseCidr("192.168.0.0/16")!, region: "a" },
      { ...parseCidr("10.0.0.0/8")!, region: "b" },
    ];
    expect(findContainingCidr("10.1.2.3", ranges)?.region).toBe("b");
    expect(findContainingCidr("192.168.5.5", ranges)?.region).toBe("a");
    expect(findContainingCidr("8.8.8.8", ranges)).toBeNull();
  });

  it("parses a string ip once and skips version mismatches", () => {
    const ranges = [
      { ...parseCidr("2001:db8::/32")!, region: "v6" },
      { ...parseCidr("10.0.0.0/8")!, region: "v4" },
    ];
    expect(findContainingCidr("10.9.9.9", ranges)?.region).toBe("v4");
    expect(findContainingCidr("2001:db8::1", ranges)?.region).toBe("v6");
  });
});

describe("parseEmails", () => {
  it("returns an empty list for null / undefined / blank input", () => {
    expect(parseEmails(undefined)).toEqual([]);
    expect(parseEmails(null)).toEqual([]);
    expect(parseEmails("")).toEqual([]);
    expect(parseEmails("   ")).toEqual([]);
    expect(parseEmails([])).toEqual([]);
  });

  it("splits a CSV / semicolon / whitespace string into addresses", () => {
    expect(parseEmails("a@x.com, b@y.com; c@z.com")).toEqual([
      "a@x.com",
      "b@y.com",
      "c@z.com",
    ]);
    expect(parseEmails("a@x.com   b@y.com")).toEqual(["a@x.com", "b@y.com"]);
  });

  it("flattens arrays and splits each entry, trimming blanks", () => {
    expect(parseEmails(["a@x.com", "  b@y.com , c@z.com ", ""])).toEqual([
      "a@x.com",
      "b@y.com",
      "c@z.com",
    ]);
  });

  it("de-duplicates case-insensitively, keeping first-seen casing", () => {
    expect(parseEmails("A@x.com, a@x.com, A@X.com")).toEqual(["A@x.com"]);
  });

  it("preserves casing by default and lower-cases on request", () => {
    expect(parseEmails("Alice@Example.com")).toEqual(["Alice@Example.com"]);
    expect(parseEmails("Alice@Example.com", { lowercase: true })).toEqual([
      "alice@example.com",
    ]);
  });

  it("keeps duplicates when dedupe is disabled", () => {
    expect(parseEmails("a@x.com, a@x.com", { dedupe: false })).toEqual([
      "a@x.com",
      "a@x.com",
    ]);
  });

  it("does not validate - passes wildcard patterns through", () => {
    expect(parseEmails("*@corp.com, user@other.com", { lowercase: true })).toEqual([
      "*@corp.com",
      "user@other.com",
    ]);
  });
});

describe("isEmail", () => {
  it("accepts well-formed addresses (trimming first)", () => {
    expect(isEmail("alice@example.com")).toBe(true);
    expect(isEmail("  bob.smith+tag@sub.example.co.uk  ")).toBe(true);
  });

  it("rejects malformed addresses", () => {
    expect(isEmail("nope")).toBe(false);
    expect(isEmail("no@domain")).toBe(false);
    expect(isEmail("@example.com")).toBe(false);
    expect(isEmail("a b@example.com")).toBe(false);
  });

  it("is purely syntactic - a wildcard pattern passes the shape check", () => {
    expect(isEmail("*@example.com")).toBe(true);
  });
});
