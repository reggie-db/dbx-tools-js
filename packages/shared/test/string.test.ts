import { describe, expect, it } from "bun:test";

import { fnvHashWithOptions } from "../src/common.js";
import {
  firstNonEmpty,
  toDescription,
  toIdentifier,
  toIdentifierWithOptions,
  tokenize,
  tokenizeWithOptions,
  toSlug,
  toSlugWithOptions,
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

describe("toDescription", () => {
  it("emits a plain string verbatim", () => {
    expect(toDescription("hello world")).toBe("hello world");
  });

  it("stacks a top-level sequence with no list markers", () => {
    expect(toDescription(["alpha", "beta"])).toBe("alpha\n\nbeta");
  });

  it("flushes plain text into a following list (no blank line)", () => {
    expect(toDescription(["lead-in line", { bullets: ["one", "two"] }])).toBe(
      "lead-in line\n- one\n- two",
    );
  });

  it("flushes plain text after a list (trailing summary, no blank line)", () => {
    expect(toDescription([{ bullets: ["one", "two"] }, "trailing text"])).toBe(
      "- one\n- two\ntrailing text",
    );
  });

  it("still inserts a blank line before a map after any block", () => {
    expect(toDescription([{ bullets: ["one", "two"] }, { Header: "value" }])).toBe(
      "- one\n- two\n\nHeader:\n\nvalue",
    );
  });

  it("still inserts a blank line between two adjacent lists", () => {
    expect(toDescription([{ bullets: ["a", "b"] }, { numbered: ["x", "y"] }])).toBe(
      "- a\n- b\n\n1. x\n2. y",
    );
  });

  describe("bullets", () => {
    it("numbers multiple items with `- `", () => {
      expect(toDescription({ bullets: ["one", "two", "three"] })).toBe(
        "- one\n- two\n- three",
      );
    });

    it("drops the marker for a single bare-string item", () => {
      expect(toDescription({ bullets: ["only one"] })).toBe("only one");
    });

    it("keeps the marker for a single item that has nested children", () => {
      expect(
        toDescription({
          bullets: [["its important", { numbered: ["item", "item"] }]],
        }),
      ).toBe("- its important\n  1. item\n  2. item");
    });

    it("returns empty for an empty list", () => {
      expect(toDescription({ bullets: [] })).toBe("");
    });
  });

  describe("numbered", () => {
    it("numbers multiple items starting at 1", () => {
      expect(toDescription({ numbered: ["a", "b", "c"] })).toBe("1. a\n2. b\n3. c");
    });

    it("drops the number for a single bare-string item", () => {
      expect(toDescription({ numbered: ["only"] })).toBe("only");
    });

    it("indents nested content under the numbered marker width", () => {
      expect(
        toDescription({
          numbered: ["first", ["second", { bullets: ["a", "b"] }]],
        }),
      ).toBe("1. first\n2. second\n   - a\n   - b");
    });
  });

  describe("maps", () => {
    it("renders each key as a `Header:` block separated by blank lines", () => {
      expect(
        toDescription({
          Instructions: "do the thing",
          Output: "return the result",
        }),
      ).toBe("Instructions:\n\ndo the thing\n\nOutput:\n\nreturn the result");
    });

    it("supports structured values under a header", () => {
      expect(
        toDescription({
          Steps: { numbered: ["first", "second"] },
        }),
      ).toBe("Steps:\n\n1. first\n2. second");
    });

    it("does not treat `bullets` / `numbered` as headers when they are sole keys + array values", () => {
      // Sanity: the discriminator does its job and we don't end up with a
      // "bullets:" header in the output.
      expect(toDescription({ bullets: ["x", "y"] })).toBe("- x\n- y");
    });

    it("treats multi-key objects as a headers map even if one key is `bullets`", () => {
      expect(toDescription({ bullets: "first", numbered: "second" })).toBe(
        "bullets:\n\nfirst\n\nnumbered:\n\nsecond",
      );
    });
  });

  describe("dedent / rstrip", () => {
    it("strips common leading indentation from multi-line strings", () => {
      const out = toDescription(`
        first line
        second line
      `);
      expect(out).toBe("first line\nsecond line");
    });

    it("right-strips trailing whitespace on every line", () => {
      const out = toDescription("alpha   \nbeta\t\n");
      expect(out).toBe("alpha\nbeta");
    });

    it("preserves internal blank lines but trims leading / trailing ones", () => {
      const out = toDescription(`
        para 1

        para 2
      `);
      expect(out).toBe("para 1\n\npara 2");
    });

    it("dedents inside list items and map values independently", () => {
      const out = toDescription({
        Instructions: `
          do step A
          then step B
        `,
        Notes: {
          bullets: [
            `
              note one
              note two
            `,
            `
              note three
              note four
            `,
          ],
        },
      });
      expect(out).toBe(
        [
          "Instructions:",
          "",
          "do step A",
          "then step B",
          "",
          "Notes:",
          "",
          "- note one",
          "  note two",
          "- note three",
          "  note four",
        ].join("\n"),
      );
    });

    it("never has trailing whitespace on any line of the final output", () => {
      const out = toDescription([
        "intro line  ",
        { bullets: ["item one  ", "item two"] },
        { Header: "value  " },
      ]);
      for (const line of out.split("\n")) {
        expect(line).toBe(line.replace(/[ \t]+$/, ""));
      }
    });
  });

  it("matches the docstring example end-to-end", () => {
    const out = toDescription([
      "this is a description",
      { bullets: [["its important", { numbered: ["item", "item"] }]] },
      { Instructions: "adfasdfasdf" },
    ]);
    expect(out).toBe(
      [
        "this is a description",
        "- its important",
        "  1. item",
        "  2. item",
        "",
        "Instructions:",
        "",
        "adfasdfasdf",
      ].join("\n"),
    );
  });
});
