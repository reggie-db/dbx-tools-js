import { describe, expect, it } from "bun:test";

import { pluginData, pluginInstance, requirePlugin } from "../src/plugin.js";

// Minimal stand-ins for AppKit's plugin classes / factories. These mirror the
// structural shape that `pluginUtils` expects (a factory returning
// `{ plugin, name }`) without pulling AppKit into the test runtime.

class FakeLakebase {
  readonly kind = "lakebase";
}

function fakeLakebaseFactory(): { plugin: typeof FakeLakebase; name: "lakebase" } {
  return { plugin: FakeLakebase, name: "lakebase" };
}

class FakeGenie {
  readonly kind = "genie";
}

function fakeGenieFactory(): { plugin: typeof FakeGenie; name: "genie" } {
  return { plugin: FakeGenie, name: "genie" };
}

function buildContext(entries: [string, unknown][]) {
  const map = new Map<string, unknown>(entries);
  return { getPlugins: () => map };
}

describe("pluginData", () => {
  it("returns the factory descriptor", () => {
    expect(pluginData(fakeLakebaseFactory)).toEqual({
      plugin: FakeLakebase,
      name: "lakebase",
    });
  });

  it("caches per factory (does not re-invoke on repeat calls)", () => {
    let calls = 0;
    function counted(): { plugin: typeof FakeLakebase; name: "lakebase" } {
      calls += 1;
      return { plugin: FakeLakebase, name: "lakebase" };
    }
    pluginData(counted);
    pluginData(counted);
    pluginData(counted);
    expect(calls).toBe(1);
  });
});

describe("pluginInstance", () => {
  it("returns the registered instance keyed by the factory's name", () => {
    const lake = new FakeLakebase();
    const ctx = buildContext([["lakebase", lake]]);
    expect(pluginInstance(ctx, fakeLakebaseFactory)).toBe(lake);
  });

  it("returns undefined when the plugin is not registered", () => {
    const ctx = buildContext([]);
    expect(pluginInstance(ctx, fakeLakebaseFactory)).toBeUndefined();
  });

  it("returns undefined when context is missing", () => {
    expect(pluginInstance(undefined, fakeLakebaseFactory)).toBeUndefined();
  });

  it("distinguishes between siblings with different names", () => {
    const lake = new FakeLakebase();
    const genie = new FakeGenie();
    const ctx = buildContext([
      ["lakebase", lake],
      ["genie", genie],
    ]);
    expect(pluginInstance(ctx, fakeLakebaseFactory)).toBe(lake);
    expect(pluginInstance(ctx, fakeGenieFactory)).toBe(genie);
  });
});

describe("requirePlugin", () => {
  it("returns the instance when registered", () => {
    const lake = new FakeLakebase();
    const ctx = buildContext([["lakebase", lake]]);
    expect(requirePlugin(ctx, fakeLakebaseFactory)).toBe(lake);
  });

  it("throws with the registered name when missing", () => {
    const ctx = buildContext([]);
    expect(() => requirePlugin(ctx, fakeLakebaseFactory)).toThrow(
      /required plugin not registered: lakebase/,
    );
  });

  it("throws with no prefix when no caller provided", () => {
    const ctx = buildContext([]);
    try {
      requirePlugin(ctx, fakeLakebaseFactory);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toBe("required plugin not registered: lakebase");
    }
  });

  it("prepends caller string to the error message", () => {
    const ctx = buildContext([]);
    expect(() => requirePlugin(ctx, fakeLakebaseFactory, "mastra")).toThrow(
      /^mastra: required plugin not registered: lakebase$/,
    );
  });

  it("prepends caller.name when caller is a NameLike object", () => {
    const ctx = buildContext([]);
    expect(() => requirePlugin(ctx, fakeLakebaseFactory, { name: "mastra" })).toThrow(
      /^mastra: required plugin not registered: lakebase$/,
    );
  });

  it("falls back to no prefix when caller object has no name", () => {
    const ctx = buildContext([]);
    expect(() => requirePlugin(ctx, fakeLakebaseFactory, {})).toThrow(
      /^required plugin not registered: lakebase$/,
    );
  });

  it("throws when context is missing", () => {
    expect(() => requirePlugin(undefined, fakeLakebaseFactory)).toThrow(
      /required plugin not registered: lakebase/,
    );
  });
});
