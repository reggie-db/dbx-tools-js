import { describe, expect, it } from "bun:test";

import { fnvHashWithOptions } from "../src/common.js";
import {
  firstNonEmpty,
  toIdentifier,
  toIdentifierWithOptions,
  toSlug,
  toSlugWithOptions,
  tokenize,
  tokenizeWithOptions,
  toUniqueSlug,
  trimToNull,
} from "../src/string.js";

function take(gen: Iterable<string>): string[] {
  return [...gen];
}

// Mirror of the private `digestTokens` helper in string.ts: concat
// each token with a `\0` separator, append the optional overflow
// `extra` token (also `\0`-suffixed), then run the result through
// `fnvHashWithOptions`. Used by the `truncateStrategy: "hash"`
// branch of toIdentifierWithOptions to derive the deterministic
// suffix appended on overflow.
function digestTokens(length: number, tokens: string[], extra?: string): string {
  let combined = "";
  for (const part of tokens) combined += part + "\0";
  if (extra !== undefined) combined += extra + "\0";
  return fnvHashWithOptions({ length }, combined);
}

// commonUtils' fnvHash emits Crockford-style base32: digits +
// lowercase alphabet minus the visually-confusing `i`, `l`, `o`,
// `u`. Used by the toUniqueSlug suite below to assert the suffix
// shape without enumerating every test alphabet inline.
const HASH_CHAR = "[0-9a-hjkmnp-tv-z]";

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
        const expected = digestTokens(6, ["alpha"], "longbeta");
        expect(
          toIdentifierWithOptions(
            {
              maxLength: 13,
              truncateStrategy: "hash",
              truncateHashLength: 6,
            },
            "alpha",
            "longbeta",
          ),
        ).toBe(`alpha-${expected}`);
      });

      it("returns hash alone when only the first token overflows", () => {
        // No tokens accepted yet; the first token "averylongtoken" is
        // the overflow `extra` argument.
        const expected = digestTokens(6, [], "averylongtoken");
        expect(
          toIdentifierWithOptions(
            {
              maxLength: 8,
              truncateStrategy: "hash",
              truncateHashLength: 6,
            },
            "averylongtoken",
          ),
        ).toBe(expected);
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

describe("trimToNull", () => {
  it("returns null for non-strings", () => {
    expect(trimToNull(undefined)).toBeNull();
    expect(trimToNull(null)).toBeNull();
    expect(trimToNull(42)).toBeNull();
    expect(trimToNull(["abc"])).toBeNull();
  });

  it("returns null for blank strings", () => {
    expect(trimToNull("")).toBeNull();
    expect(trimToNull("   ")).toBeNull();
    expect(trimToNull("\t\n")).toBeNull();
  });

  it("trims and returns non-empty strings", () => {
    expect(trimToNull("  hello  ")).toBe("hello");
    expect(trimToNull("x")).toBe("x");
  });
});

describe("firstNonEmpty", () => {
  it("delegates to trimToNull for scalars", () => {
    expect(firstNonEmpty("  abc  ")).toBe("abc");
    expect(firstNonEmpty(undefined)).toBeNull();
    expect(firstNonEmpty(42)).toBeNull();
  });

  it("walks arrays until the first usable string", () => {
    expect(firstNonEmpty(["", " ", "x", "y"])).toBe("x");
    expect(firstNonEmpty([null, undefined, "  z  "])).toBe("z");
    expect(firstNonEmpty([" ", "  "])).toBeNull();
    expect(firstNonEmpty([])).toBeNull();
  });
});

describe("toUniqueSlug", () => {
  it("appends a hash suffix to a slugified description", () => {
    const slug = toUniqueSlug("Read uploaded file");
    expect(slug).toMatch(new RegExp(`^read_uploaded_file_${HASH_CHAR}{6}$`));
  });

  it("is deterministic across calls", () => {
    expect(toUniqueSlug("Same description")).toBe(toUniqueSlug("Same description"));
  });

  it("uses fallback prefix when the slug ends up empty", () => {
    const slug = toUniqueSlug("!!!");
    expect(slug).toMatch(new RegExp(`^id_${HASH_CHAR}{6}$`));
  });

  it("honors custom delimiter, slug cap, and hash length", () => {
    // slugMaxLength caps the *slug* portion only; the hash is added on
    // top of it. With cap 8 + delimiter "-", "very-long" (9 chars)
    // overflows so the trim strategy stops at "very".
    const slug = toUniqueSlug("VeryLongDescriptionStringExceedingTheCap", {
      delimiter: "-",
      slugMaxLength: 8,
      hashLength: 4,
    });
    expect(slug).toMatch(new RegExp(`^very-${HASH_CHAR}{4}$`));
  });

  it("hashes the raw source so same-slug inputs still differ", () => {
    // Tokenisation drops punctuation, so "foo bar" and "foo  bar!" slugify
    // identically. The hash is keyed off the raw value, so the suffixes
    // must differ.
    const a = toUniqueSlug("foo bar");
    const b = toUniqueSlug("foo  bar!");
    expect(a.split("_").slice(0, -1).join("_")).toBe(
      b.split("_").slice(0, -1).join("_"),
    );
    expect(a).not.toBe(b);
  });
});
