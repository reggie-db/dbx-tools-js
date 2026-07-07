import { describe, expect, it } from "bun:test";

import { type VerifyOptions } from "../src/verify.js";

describe("VerifyOptions", () => {
  it("defaults workspaceDeps to off when omitted", () => {
    const options: VerifyOptions = {};
    expect(options.workspaceDeps).toBeUndefined();
  });
});
