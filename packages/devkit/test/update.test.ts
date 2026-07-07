import { describe, expect, it } from "bun:test";

import {
  forwardedUpdateArgs,
  isStableVersion,
  latestStableInRange,
  stableCaretRange,
} from "../src/update.js";

const MASTRA_CORE_STABLE_TAIL = [
  "1.45.0",
  "1.46.0",
  "1.47.0",
  "1.48.0-alpha.3",
];

describe("isStableVersion", () => {
  it("accepts release versions", () => {
    expect(isStableVersion("1.47.0")).toBe(true);
  });

  it("rejects prerelease versions", () => {
    expect(isStableVersion("1.48.0-alpha.3")).toBe(false);
    expect(isStableVersion("1.1.0-beta.2")).toBe(false);
  });
});

describe("latestStableInRange", () => {
  it("picks the highest stable match and skips alphas", () => {
    expect(latestStableInRange(MASTRA_CORE_STABLE_TAIL, "^1")).toBe("1.47.0");
  });

  it("respects 0.x caret minor pinning", () => {
    const versions = ["0.42.9", "0.43.0", "0.43.2", "0.44.0"];
    expect(latestStableInRange(versions, "^0.43")).toBe("0.43.2");
  });
});

describe("stableCaretRange", () => {
  it("rewrites a loose major caret to the latest stable pin", () => {
    expect(stableCaretRange(MASTRA_CORE_STABLE_TAIL, "^1")).toBe("^1.47.0");
  });

  it("leaves latest untouched", () => {
    expect(stableCaretRange(["1.0.0"], "latest")).toBe("latest");
  });

  it("resolves each side of a compound range", () => {
    const versions = ["18.3.1", "19.2.4", "19.3.0-alpha.1"];
    expect(stableCaretRange(versions, "^18.0.0 || ^19.0.0")).toBe("^18.3.1 || ^19.2.4");
  });
});

describe("forwardedUpdateArgs", () => {
  it("returns argv tokens after update", () => {
    expect(
      forwardedUpdateArgs(["node", "devkit", "update", "--force", "@mastra/core"]),
    ).toEqual(["--force", "@mastra/core"]);
  });
});
