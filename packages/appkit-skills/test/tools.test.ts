import { describe, expect, test } from "bun:test";

import { resetSkillRuntime } from "../src/runtime.js";
import { skillTools } from "../src/tools.js";

describe("skillTools", () => {
  test("returns no tools when the runtime has not been primed", () => {
    resetSkillRuntime();
    expect(skillTools()).toEqual({});
  });
});
