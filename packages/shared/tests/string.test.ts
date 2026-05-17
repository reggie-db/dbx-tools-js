import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";

import {
  toIdentifier,
  toIdentifierWithOptions,
  toSlug,
  toSlugWithOptions,
  tokenize,
  tokenizeWithOptions,
} from "../src/string.js";

function take(gen: Iterable<string>): string[] {
  return [...gen];
}

function sha1(parts: string[], length = 6): string {
  const hash = createHash("sha1");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, length);
}

describe("tokenize", () => {
  it("splits camelCase by default", () => {
    expect(take(tokenize("fooBarBaz"))).toEqual(["foo", "Bar", "Baz"]);
  });

  it("splits acronyms when followed by camelCase", () => {
    expect(take(tokenize("HTTPServer"))).toEqual(["HTTP", "Server"]);
  });

  it("splits across non-alphanumerics", () => {
    expect(take(tokenize("foo-bar_baz.qux"))).toEqual(["foo", "bar", "baz", "qux"]);
  });

  it("emits digits as their own token", () => {
    expect(take(tokenize("foo42Bar"))).toEqual(["foo", "42", "Bar"]);
  });

  it("flattens multiple values", () => {
    expect(take(tokenize("fooBar", "baz qux"))).toEqual(["foo", "Bar", "baz", "qux"]);
  });

  it("stringifies non-string inputs", () => {
    expect(take(tokenize(42, true))).toEqual(["42", "true"]);
  });

  it("skips null and undefined", () => {
    expect(take(tokenize(null, "foo", undefined, "bar"))).toEqual(["foo", "bar"]);
  });

  it("skips empty strings", () => {
    expect(take(tokenize("", "foo", ""))).toEqual(["foo"]);
  });
});

describe("tokenizeWithOptions", () => {
  it("camelCase: false splits only on non-alphanumerics", () => {
    expect(take(tokenizeWithOptions({ camelCase: false }, "fooBar-baz"))).toEqual([
      "fooBar",
      "baz",
    ]);
  });

  it("lowerCase lowers every token", () => {
    expect(take(tokenizeWithOptions({ lowerCase: true }, "FooBAR"))).toEqual([
      "foo",
      "bar",
    ]);
  });

  it("distinct removes duplicates and preserves first-seen order", () => {
    expect(
      take(tokenizeWithOptions({ distinct: true }, "foo bar foo baz bar")),
    ).toEqual(["foo", "bar", "baz"]);
  });

  it("distinct is case-sensitive", () => {
    expect(take(tokenizeWithOptions({ distinct: true }, "Foo foo FOO"))).toEqual([
      "Foo",
      "foo",
      "FOO",
    ]);
  });

  it("distinct + lowerCase dedupes regardless of case", () => {
    expect(
      take(tokenizeWithOptions({ distinct: true, lowerCase: true }, "Foo foo FOO")),
    ).toEqual(["foo"]);
  });

  it("omitUriScheme strips scheme + '//' before tokenizing URI inputs", () => {
    expect(
      take(tokenizeWithOptions({ omitUriScheme: true }, "https://example.com")),
    ).toEqual(["example", "com"]);
  });

  it("omitUriScheme leaves non-URI inputs untouched", () => {
    expect(take(tokenizeWithOptions({ omitUriScheme: true }, "plain text"))).toEqual([
      "plain",
      "text",
    ]);
  });

  it("omitEmailDomain keeps only the local-part of email inputs", () => {
    expect(
      take(tokenizeWithOptions({ omitEmailDomain: true }, "alice.smith@example.com")),
    ).toEqual(["alice", "smith"]);
  });

  it("omitEmailDomain leaves non-email inputs untouched", () => {
    expect(take(tokenizeWithOptions({ omitEmailDomain: true }, "plain text"))).toEqual([
      "plain",
      "text",
    ]);
  });
});

describe("toIdentifier", () => {
  it("lowercases and joins with '-'", () => {
    expect(toIdentifier("Foo", "BarBaz")).toBe("foo-bar-baz");
  });

  it("returns empty string when no tokens", () => {
    expect(toIdentifier()).toBe("");
    expect(toIdentifier("")).toBe("");
    expect(toIdentifier(null, undefined)).toBe("");
  });
});

describe("toIdentifierWithOptions", () => {
  it("respects custom delimiter", () => {
    expect(toIdentifierWithOptions({ delimiter: "_" }, "foo", "bar")).toBe("foo_bar");
  });

  it("ignores caller's lowerCase override (forced true at runtime)", () => {
    expect(
      toIdentifierWithOptions(
        { lowerCase: false } as Parameters<typeof toIdentifierWithOptions>[0],
        "FooBar",
      ),
    ).toBe("foo-bar");
  });

  describe("maxLength", () => {
    it("returns full result when under limit", () => {
      expect(toIdentifierWithOptions({ maxLength: 20 }, "alpha", "beta")).toBe(
        "alpha-beta",
      );
    });

    describe("trim", () => {
      it("stops adding tokens once limit is reached", () => {
        expect(
          toIdentifierWithOptions(
            { maxLength: 10, truncateStrategy: "trim" },
            "alpha",
            "beta",
            "gamma",
          ),
        ).toBe("alpha-beta");
      });

      it("returns first token when next overflows", () => {
        expect(
          toIdentifierWithOptions(
            { maxLength: 5, truncateStrategy: "trim" },
            "alpha",
            "beta",
          ),
        ).toBe("alpha");
      });

      it("returns '' when first token already overflows", () => {
        expect(
          toIdentifierWithOptions({ maxLength: 3, truncateStrategy: "trim" }, "alpha"),
        ).toBe("");
      });
    });

    describe("empty", () => {
      it("returns '' on overflow", () => {
        expect(
          toIdentifierWithOptions(
            { maxLength: 8, truncateStrategy: "empty" },
            "alpha",
            "beta",
          ),
        ).toBe("");
      });

      it("returns full result when under limit", () => {
        expect(
          toIdentifierWithOptions(
            { maxLength: 20, truncateStrategy: "empty" },
            "alpha",
            "beta",
          ),
        ).toBe("alpha-beta");
      });
    });

    describe("hash", () => {
      it("appends digest of accepted tokens + overflow token", () => {
        // alpha (5) + '-' (1) + beta (4) = 10 > 9, hash kicks in.
        // prefix='alpha' (5) + '-' (1) + hash(6) = 12 > 9, doesn't fit, return ''.
        expect(
          toIdentifierWithOptions(
            {
              maxLength: 9,
              truncateStrategy: "hash",
              truncateHashAlgorithm: "sha1",
              truncateHashLength: 6,
            },
            "alpha",
            "beta",
          ),
        ).toBe("");
      });

      it("fits prefix + delimiter + hash within maxLength", () => {
        // alpha(5) + '-' + longbeta(8) = 14 > 13 overflow.
        // prefix='alpha'(5) + '-' + hash(6) = 12 <= 13 fits.
        const hash = sha1(["alpha", "longbeta"], 6);
        expect(
          toIdentifierWithOptions(
            {
              maxLength: 13,
              truncateStrategy: "hash",
              truncateHashAlgorithm: "sha1",
              truncateHashLength: 6,
            },
            "alpha",
            "longbeta",
          ),
        ).toBe(`alpha-${hash}`);
      });

      it("returns hash alone when only the first token overflows", () => {
        const hash = sha1(["averylongtoken"], 6);
        expect(
          toIdentifierWithOptions(
            {
              maxLength: 8,
              truncateStrategy: "hash",
              truncateHashAlgorithm: "sha1",
              truncateHashLength: 6,
            },
            "averylongtoken",
          ),
        ).toBe(hash);
      });

      it("returns '' when even the hash alone does not fit", () => {
        expect(
          toIdentifierWithOptions(
            {
              maxLength: 4,
              truncateStrategy: "hash",
              truncateHashLength: 6,
            },
            "averylongtoken",
          ),
        ).toBe("");
      });

      it("uses non-default hash algorithm", () => {
        // alpha(5) + '-' + longbeta(8) = 14 > 13 overflow.
        // prefix='alpha'(5) + '-' + hash(7) = 13 <= 13 fits.
        const hash = createHash("sha256");
        for (const part of ["alpha", "longbeta"]) {
          hash.update(part);
          hash.update("\0");
        }
        const want = hash.digest("hex").slice(0, 7);
        expect(
          toIdentifierWithOptions(
            {
              maxLength: 13,
              truncateStrategy: "hash",
              truncateHashAlgorithm: "sha256",
              truncateHashLength: 7,
            },
            "alpha",
            "longbeta",
          ),
        ).toBe(`alpha-${want}`);
      });
    });
  });
});

describe("toSlug", () => {
  it("hyphen-joins lowercase tokens", () => {
    expect(toSlug("Hello World", "FooBar")).toBe("hello-world-foo-bar");
  });
});

describe("toSlugWithOptions", () => {
  it("ignores any delimiter and uses '-'", () => {
    // KeyOptions has no `delimiter`, but if a caller bypasses types we still
    // win because toSlugWithOptions spreads `delimiter: "-"` last.
    expect(
      toSlugWithOptions(
        { delimiter: "_" } as Parameters<typeof toSlugWithOptions>[0],
        "foo",
        "bar",
      ),
    ).toBe("foo-bar");
  });

  it("passes through maxLength + trim strategy", () => {
    expect(
      toSlugWithOptions(
        { maxLength: 10, truncateStrategy: "trim" },
        "alpha",
        "beta",
        "gamma",
      ),
    ).toBe("alpha-beta");
  });
});
