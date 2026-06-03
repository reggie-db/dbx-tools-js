/**
 * Example agent-service ranker. Picks Foundation Model endpoints
 * out of a Databricks `/serving-endpoints` listing using three
 * optional filters:
 *
 *   - `classes`: single string or array of `model_class` values
 *     (`"claude"`, `"gpt-oss"`, `"gemini"`, ...). Case-insensitive.
 *   - `speed`: 0-1 threshold against the candidate pool's
 *     `ai_gateway_model_profile.speed`. Normalized as
 *     `(v - min) / (max - min)`; items >= threshold pass. If
 *     nothing passes, the single highest-speed item wins (so
 *     `0.9` against a pool whose top normalized speed is `0.8`
 *     still returns one result).
 *   - `quality`: same shape as `speed`, against
 *     `ai_gateway_model_profile.quality`.
 *
 * The API call is mocked: {@link loadEndpoints} reads the
 * `serving-endpoints.json` fixture sitting next to this file.
 *
 * Run as a script:
 *   ```
 *   bun run packages/mastra/tests/agents-service-test.ts
 *   ```
 *
 * Run as a test:
 *   ```
 *   bun test packages/mastra/tests/agents-service-test.ts
 *   ```
 */

import { describe, expect, it } from "bun:test";
import pMemoize from "p-memoize";

import {
  servingEndpoints,
  foundationModelProfile,
  type ServingEndpoint,
  foundationModelClass,
  foundationModelVersion,
} from "../src/models";

// ────────────────────────────────────────────────────────────────
// Mocked API call
// ────────────────────────────────────────────────────────────────

const getServingEndpoints = pMemoize(async (): Promise<ServingEndpoint[]> => {
  return await servingEndpoints();
});

// ────────────────────────────────────────────────────────────────
// Ranking helpers (DRY: speed and quality both go through
// `filterByDistribution`)
// ────────────────────────────────────────────────────────────────

/**
 * Filter `items` to those whose `getValue` reading is at or above
 * the given normalized `threshold` against the pool's own
 * `[min, max]` range. If nothing passes (every value is below the
 * cutoff or the pool is uniform), fall back to the single top
 * item so the caller always gets a non-empty result on a
 * non-empty input.
 *
 * Generic over the item type so the same function ranks by speed,
 * quality, or any other numeric attribute.
 */
function filterByDistribution<T>(
  items: ReadonlyArray<T>,
  getValue: (item: T) => number,
  threshold: number,
): T[] {
  if (items.length === 0) return [];
  if (items.length === 1) return [...items];

  let min = Infinity;
  let max = -Infinity;
  for (const item of items) {
    const v = getValue(item);
    if (Number.isFinite(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }

  // Degenerate range: every item is the same (or only one finite
  // value). Threshold doesn't apply meaningfully; return the pool
  // unchanged so the caller's other filters can still narrow it.
  if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) {
    return [...items];
  }

  const range = max - min;
  const passing = items.filter((item) => (getValue(item) - min) / range >= threshold);
  if (passing.length > 0) return passing;

  // Nothing met the threshold (e.g. caller asked for `0.9` and
  // the top normalized score is `0.7`). Return the single highest
  // item so the contract holds: non-empty input => non-empty
  // output.
  return [topByValue(items, getValue)];
}

/** Item with the highest `getValue`. Tie-break by first occurrence. */
function topByValue<T>(items: ReadonlyArray<T>, getValue: (item: T) => number): T {
  let best = items[0]!;
  let bestScore = getValue(best);
  for (let i = 1; i < items.length; i++) {
    const candidate = items[i]!;
    const score = getValue(candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

// ────────────────────────────────────────────────────────────────
// Public function
// ────────────────────────────────────────────────────────────────

/** Options accepted by {@link selectEndpoints}. All fields optional. */
export interface SelectEndpointsOptions {
  /**
   * One or more `model_class` values to keep. Case-insensitive
   * (`"Claude"` matches `"claude"`). When omitted, no class
   * filtering happens.
   */
  classes?: string | ReadonlyArray<string>;
  /**
   * Speed threshold in `[0, 1]` against the candidate pool's
   * own min/max. `0.9` keeps items in the top ~10% of speeds
   * available; if nothing makes the cut, the single fastest
   * item wins.
   */
  speed?: number;
  /** Quality threshold; same semantics as {@link speed}. */
  quality?: number;
}

/**
 * Select serving endpoints by class / speed / quality. Filters
 * are applied in order:
 *
 *   1. Drop non-foundation-model endpoints (no AI Gateway
 *      profile to rank on).
 *   2. If `classes` is set, narrow to those `model_class`es.
 *   3. If `speed` is set, run {@link filterByDistribution} on
 *      the surviving pool.
 *   4. If `quality` is set, do the same.
 *
 * Each later step ranks against the already-filtered pool, so a
 * `quality: 1` call after `classes: "claude"` returns the highest-
 * quality Claude rather than the global highest-quality endpoint.
 */
export async function selectEndpoints(
  options: SelectEndpointsOptions = {},
): Promise<ServingEndpoint[]> {
  const all = await getServingEndpoints();

  // Step 1: only items with the gateway profile are rankable.
  let candidates = all.filter((e) => foundationModelProfile(e) !== undefined);

  // Step 2: class filter.
  if (options.classes !== undefined) {
    const list = Array.isArray(options.classes) ? options.classes : [options.classes];
    const lower = new Set(list.map((c) => c.toLowerCase()));
    if (lower.size > 0) {
      candidates = candidates.filter((e) => {
        const cls = foundationModelClass(e);
        return cls !== undefined && lower.has(cls.toLowerCase());
      });
    }
  }

  // Step 3: speed filter (uses the same `filterByDistribution`
  // helper as quality below). Step 1 already dropped endpoints
  // without a profile, so the `!` is safe here.
  if (options.speed !== undefined) {
    candidates = filterByDistribution(
      candidates,
      (e) => foundationModelProfile(e)!.speed,
      options.speed,
    );
  }

  // Step 4: quality filter.
  if (options.quality !== undefined) {
    candidates = filterByDistribution(
      candidates,
      (e) => foundationModelProfile(e)!.quality,
      options.quality,
    );
  }

  return candidates;
}

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

describe("selectEndpoints", () => {
  it("returns every foundation-model endpoint with no filters", async () => {
    const result = await selectEndpoints();
    expect(result.length).toBeGreaterThan(0);
    for (const e of result) expect(foundationModelProfile(e)).toBeDefined();
  });

  it("filters by a single class (case-insensitive)", async () => {
    const result = await selectEndpoints({ classes: "Claude" });
    expect(result.length).toBeGreaterThan(0);
    for (const e of result) {
      expect(foundationModelClass(e)?.toLowerCase()).toBe("claude");
    }
  });

  it("filters by multiple classes", async () => {
    const result = await selectEndpoints({ classes: ["claude", "gemini"] });
    expect(result.length).toBeGreaterThan(0);
    for (const e of result) {
      const cls = foundationModelClass(e)?.toLowerCase();
      expect(cls).toBeDefined();
      expect(["claude", "gemini"]).toContain(cls!);
    }
  });

  it("speed=1 returns just the fastest endpoint(s)", async () => {
    const result = await selectEndpoints({ speed: 1 });
    expect(result.length).toBeGreaterThanOrEqual(1);
    const all = await selectEndpoints();
    const fastest = topByValue(all, (e) => foundationModelProfile(e)!.speed);
    expect(foundationModelProfile(result[0]!)!.speed).toBe(
      foundationModelProfile(fastest)!.speed,
    );
  });

  it("speed=0 keeps the whole pool", async () => {
    const all = await selectEndpoints();
    const result = await selectEndpoints({ speed: 0 });
    expect(result.length).toBe(all.length);
  });

  it("quality=1 narrows to the highest-quality endpoint(s)", async () => {
    const all = await selectEndpoints();
    const result = await selectEndpoints({ quality: 1 });
    const best = topByValue(all, (e) => foundationModelProfile(e)!.quality);
    expect(foundationModelProfile(result[0]!)!.quality).toBe(
      foundationModelProfile(best)!.quality,
    );
  });

  it("class + speed + quality compose left-to-right", async () => {
    // "Best Claude for speed-then-quality" - typical use case.
    const result = await selectEndpoints({
      classes: "claude",
      speed: 0.5,
      quality: 0.8,
    });
    expect(result.length).toBeGreaterThan(0);
    for (const e of result) {
      expect(foundationModelClass(e)?.toLowerCase()).toBe("claude");
    }
  });

  it("falls back to the single top item when nothing meets a strict threshold", async () => {
    // Class with sparse offerings + a high speed cut: even if
    // nothing strictly clears 0.95 in the surviving pool, the
    // function returns one item (the fastest in that pool).
    const result = await selectEndpoints({
      classes: "claude",
      speed: 0.99,
    });
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects unknown classes by returning empty", async () => {
    const result = await selectEndpoints({ classes: "totally-fake-class" });
    expect(result).toEqual([]);
  });
});

describe("foundationModelVersion", () => {
  // Look up a fixture endpoint by exact `name`, asserting it exists.
  async function endpointByName(name: string): Promise<ServingEndpoint> {
    const all = await getServingEndpoints();
    const found = all.find((e) => e.name === name);
    expect(found, `fixture endpoint not found: ${name}`).toBeDefined();
    return found!;
  }

  it("returns undefined for endpoints whose served entities are not FOUNDATION_MODEL", async () => {
    // `lensiq-*` and `guest-promise-time-v2` are UC_MODEL entries
    // in the fixture, so `foundationModels()` yields nothing and
    // version derivation short-circuits to `undefined`.
    expect(
      foundationModelVersion(await endpointByName("lensiq-detector")),
    ).toBeUndefined();
    expect(
      foundationModelVersion(await endpointByName("guest-promise-time-v2")),
    ).toBeUndefined();
  });

  it("returns undefined for foundation models with no digits in the endpoint name", async () => {
    expect(
      foundationModelVersion(await endpointByName("databricks-gte-large-en")),
    ).toBeUndefined();
    expect(
      foundationModelVersion(await endpointByName("databricks-bge-large-en")),
    ).toBeUndefined();
  });

  it("expands two numeric chunks to MAJOR.MINOR.0", async () => {
    expect(
      foundationModelVersion(await endpointByName("databricks-claude-opus-4-7")),
    ).toBe("4.7.0");
    expect(
      foundationModelVersion(await endpointByName("databricks-claude-sonnet-4-5")),
    ).toBe("4.5.0");
    expect(
      foundationModelVersion(await endpointByName("databricks-claude-opus-4-1")),
    ).toBe("4.1.0");
  });

  it("expands a single numeric chunk to MAJOR.0.0", async () => {
    expect(
      foundationModelVersion(await endpointByName("databricks-claude-sonnet-4")),
    ).toBe("4.0.0");
    expect(
      foundationModelVersion(await endpointByName("databricks-llama-4-maverick")),
    ).toBe("4.0.0");
  });

  it("splits numeric+letter chunks: numeric goes into versionParts, full chunk into suffix", async () => {
    // `120b` -> versionParts ["120"] padded to ["120","0","0"], suffix ["120b"].
    expect(
      foundationModelVersion(await endpointByName("databricks-gpt-oss-120b")),
    ).toBe("120.0.0.120b");
    expect(foundationModelVersion(await endpointByName("databricks-gpt-oss-20b"))).toBe(
      "20.0.0.20b",
    );
    // `3` is pure-numeric (no suffix contribution); `12b` contributes "12"
    // to versionParts and "12b" to the suffix.
    expect(foundationModelVersion(await endpointByName("databricks-gemma-3-12b"))).toBe(
      "3.12.0.12b",
    );
  });

  it("captures multiple numeric+letter chunks in order, joining suffixes", async () => {
    expect(
      foundationModelVersion(
        await endpointByName("databricks-qwen3-next-80b-a3b-instruct"),
      ),
    ).toBe("3.80.3.80ba3b");
    expect(
      foundationModelVersion(await endpointByName("databricks-qwen35-122b-a10b")),
    ).toBe("35.122.10.122ba10b");
    expect(
      foundationModelVersion(
        await endpointByName("databricks-meta-llama-3-1-8b-instruct"),
      ),
    ).toBe("3.1.8.8b");
    expect(
      foundationModelVersion(
        await endpointByName("databricks-meta-llama-3-3-70b-instruct"),
      ),
    ).toBe("3.3.70.70b");
  });
});

describe("filterByDistribution", () => {
  it("keeps items at or above the normalized threshold", () => {
    const items = [{ v: 10 }, { v: 20 }, { v: 30 }, { v: 40 }, { v: 50 }];
    // threshold 0.5 -> normalized cutoff is 30; 30/40/50 pass.
    const result = filterByDistribution(items, (i) => i.v, 0.5);
    expect(result.map((i) => i.v)).toEqual([30, 40, 50]);
  });

  it("returns the highest item when nothing meets the threshold", () => {
    // Build a synthetic case: threshold > 1 (impossible) forces
    // the fallback path.
    const items = [{ v: 10 }, { v: 20 }, { v: 30 }];
    const result = filterByDistribution(items, (i) => i.v, 1.5);
    expect(result.map((i) => i.v)).toEqual([30]);
  });

  it("returns the pool unchanged when min == max", () => {
    const items = [{ v: 5 }, { v: 5 }, { v: 5 }];
    const result = filterByDistribution(items, (i) => i.v, 0.7);
    expect(result.length).toBe(3);
  });

  it("handles a single-item pool", () => {
    const items = [{ v: 42 }];
    const result = filterByDistribution(items, (i) => i.v, 0.99);
    expect(result).toEqual(items);
  });
});

// ────────────────────────────────────────────────────────────────
// Examples (printed inline during `bun test`)
//
// These aren't assertions; they exist to give a feel for what
// each filter combo actually selects against the fixture. Bun's
// test runner shows `console.log` output by default, so running
// `bun test packages/mastra/tests/agents-service.test.ts` prints
// a small table per scenario right under the `(pass)` line.
//
// To make the output even louder (full per-test logs even on
// pass), pass `--verbose`:
//   bun test --verbose packages/mastra/tests/agents-service.test.ts
//
// To silence the examples without losing the assertions, set the
// env var: `EXAMPLES=0 bun test ...` (the suite below skips when
// it's set to a falsy value).
// ────────────────────────────────────────────────────────────────

const EXAMPLES_ENABLED = (() => {
  const raw = process.env.EXAMPLES?.toLowerCase().trim();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
})();

const exampleSuite = EXAMPLES_ENABLED ? describe : describe.skip;

/**
 * Compact one-line summary of a single endpoint - just enough to
 * eyeball whether the right ones got picked.
 */
function summarize(e: ServingEndpoint): string {
  const profile = foundationModelProfile(e);
  const cls = (foundationModelClass(e) ?? "?").padEnd(12);
  const ver = (foundationModelVersion(e) ?? "?").padEnd(18);
  const s = String(profile?.speed ?? "?").padStart(6);
  const q = String(profile?.quality ?? "?").padStart(5);
  return `  ${e.name.padEnd(48)}  class=${cls}  version=${ver}  speed=${s}  quality=${q}`;
}

/**
 * Print a labeled block of selected endpoints. Flushed via
 * console.log so Bun's test output captures it (works under both
 * default and `--verbose`).
 */
function show(label: string, items: ReadonlyArray<ServingEndpoint>): void {
  // eslint-disable-next-line no-console
  console.log(`\n${label} (${items.length} match):`);
  if (items.length === 0) {
    // eslint-disable-next-line no-console
    console.log("  <none>");
    return;
  }
  for (const e of items) {
    // eslint-disable-next-line no-console
    console.log(summarize(e));
  }
}

exampleSuite("selectEndpoints (examples)", () => {
  it("everything", async () => {
    show("no filters", await selectEndpoints());
  });

  it("classes=claude", async () => {
    show("classes=claude", await selectEndpoints({ classes: "claude" }));
  });

  it("classes=[claude,gemini]", async () => {
    show(
      "classes=[claude, gemini]",
      await selectEndpoints({ classes: ["claude", "gemini"] }),
    );
  });

  it("speed=0.9 (top ~10% of speed)", async () => {
    show("speed=0.9", await selectEndpoints({ speed: 0.9 }));
  });

  it("quality=0.9 (top ~10% of quality)", async () => {
    show("quality=0.9", await selectEndpoints({ quality: 0.9 }));
  });

  it("classes=claude, speed=0.5, quality=0.8", async () => {
    show(
      "classes=claude, speed=0.5, quality=0.8",
      await selectEndpoints({
        classes: "claude",
        speed: 0.5,
        quality: 0.8,
      }),
    );
  });

  it("classes=claude, speed=0.99 (fallback to fastest claude)", async () => {
    show(
      "classes=claude, speed=0.99 (forces fallback)",
      await selectEndpoints({ classes: "claude", speed: 0.99 }),
    );
  });
});

exampleSuite("foundationModelVersion (examples)", () => {
  it("derives a version from every fixture endpoint", async () => {
    const all = await getServingEndpoints();
    // eslint-disable-next-line no-console
    console.log(`\nname -> foundationModelVersion (${all.length} endpoints):`);
    for (const e of all) {
      const v = foundationModelVersion(e) ?? "<undefined>";
      // eslint-disable-next-line no-console
      console.log(`  ${e.name.padEnd(48)}  ${v}`);
    }
  });
});
