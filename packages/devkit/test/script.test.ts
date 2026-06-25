import { describe, expect, it } from "bun:test";

import { errorMessage, nonEmptyLines } from "../src/script.js";

describe("errorMessage", () => {
  it("returns the message of an Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies a non-Error value", () => {
    expect(errorMessage("plain string")).toBe("plain string");
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(42)).toBe("42");
  });
});

describe("nonEmptyLines", () => {
  it("trims each line and drops blank ones", () => {
    expect(nonEmptyLines("  a  \n\n  b\n   \nc")).toEqual(["a", "b", "c"]);
  });

  it("returns an empty array for empty or whitespace-only input", () => {
    expect(nonEmptyLines("")).toEqual([]);
    expect(nonEmptyLines("  \n \t \n")).toEqual([]);
  });
});
