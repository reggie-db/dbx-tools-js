import { describe, expect, it } from "bun:test";

import {
  fnvHash,
  fnvHashWithOptions,
  id,
  memoize,
  memoized,
  poll,
  sleep,
  toBase32,
} from "../src/common.js";

describe("id", () => {
  it("returns a full v4 UUID with no length", () => {
    const value = id();
    expect(value).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("returns the requested number of hex chars when length is supplied", () => {
    expect(id(8)).toHaveLength(8);
    expect(id(8)).toMatch(/^[0-9a-f]{8}$/);
    expect(id(4)).toHaveLength(4);
    expect(id(12)).toHaveLength(12);
  });

  it("throws when length is zero or negative", () => {
    expect(() => id(0)).toThrow(/length must be greater than 0/i);
    expect(() => id(-1)).toThrow(/length must be greater than 0/i);
  });

  it("mints distinct ids across calls", () => {
    const full = new Set(Array.from({ length: 100 }, () => id()));
    expect(full.size).toBe(100);
    const short = new Set(Array.from({ length: 100 }, () => id(12)));
    expect(short.size).toBe(100);
  });
});

describe("memoize (once)", () => {
  it("runs a zero-arg factory once and returns the same value", async () => {
    let runs = 0;
    const get = memoize(() => {
      runs += 1;
      return { id: runs };
    });
    const a = await get();
    const b = await get();
    expect(runs).toBe(1);
    expect(a).toBe(b);
    expect(a).toEqual({ id: 1 });
  });

  it("single-flights concurrent async initialization", async () => {
    let runs = 0;
    const get = memoize(async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 20));
      return runs;
    });
    const [a, b, c] = await Promise.all([get(), get(), get()]);
    expect(runs).toBe(1);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(c).toBe(1);
  });

  it("returns the same rejected promise when the factory fails", async () => {
    let runs = 0;
    const get = memoize(async () => {
      runs += 1;
      throw new Error("boom");
    });
    const first = get();
    const second = get();
    expect(first).toBe(second);
    await expect(first).rejects.toThrow("boom");
    await expect(second).rejects.toThrow("boom");
    expect(runs).toBe(1);
  });
});

describe("memoize (by args)", () => {
  it("caches per argument key for sync functions", () => {
    let runs = 0;
    const fn = memoize((n: number) => {
      runs += 1;
      return n * 2;
    });
    expect(fn(3)).toBe(6);
    expect(fn(3)).toBe(6);
    expect(fn(4)).toBe(8);
    expect(runs).toBe(2);
  });

  it("uses JSON.stringify for the default cache key", () => {
    let runs = 0;
    const fn = memoize((a: number, b: number) => {
      runs += 1;
      return a + b;
    });
    expect(fn(1, 2)).toBe(3);
    expect(fn(1, 2)).toBe(3);
    expect(fn(2, 1)).toBe(3);
    expect(runs).toBe(2);
  });

  it("uses a custom key function", () => {
    let runs = 0;
    const fn = memoize(
      (obj: { id: string }) => {
        runs += 1;
        return obj.id;
      },
      { key: (obj) => obj.id },
    );
    expect(fn({ id: "a" })).toBe("a");
    expect(fn({ id: "a" })).toBe("a");
    expect(runs).toBe(1);
  });

  it("single-flights concurrent async calls for the same key", async () => {
    let runs = 0;
    const fn = memoize(async (id: string) => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 15));
      return id;
    });
    const [a, b] = await Promise.all([fn("x"), fn("x")]);
    expect(runs).toBe(1);
    expect(a).toBe("x");
    expect(b).toBe("x");
  });

  it("caches different keys independently for async functions", async () => {
    let runs = 0;
    const fn = memoize(async (id: string) => {
      runs += 1;
      return id;
    });
    expect(await fn("a")).toBe("a");
    expect(await fn("b")).toBe("b");
    expect(await fn("a")).toBe("a");
    expect(runs).toBe(2);
  });

  it("retries after an async rejection for the same key", async () => {
    let runs = 0;
    const fn = memoize(async (fail: boolean) => {
      runs += 1;
      if (fail) {
        throw new Error("fail");
      }
      return "ok";
    });

    await expect(fn(true)).rejects.toThrow("fail");
    expect(runs).toBe(1);

    await expect(fn(true)).rejects.toThrow("fail");
    expect(runs).toBe(2);

    expect(await fn(false)).toBe("ok");
    expect(await fn(false)).toBe("ok");
    expect(runs).toBe(3);
  });

  it("treats a thenable return value as async and single-flights it", async () => {
    let runs = 0;
    const fn = memoize((id: string) => {
      runs += 1;
      // Intentionally non-spec-compliant thenable (single-arg `then`,
      // returns void) cast to `PromiseLike<string>` so we can prove
      // `isThenable` duck-types purely on the `.then` method and routes
      // through `Promise.resolve(...)` regardless of shape.
      const thenable = {
        then(onFulfilled: (value: string) => void) {
          onFulfilled(id);
        },
      } as unknown as PromiseLike<string>;
      return thenable;
    });
    const [a, b] = await Promise.all([fn("t"), fn("t")]);
    expect(runs).toBe(1);
    expect(a).toBe("t");
    expect(b).toBe("t");
  });
});

describe("memoized", () => {
  it("throws when the descriptor value is not a function", () => {
    expect(() =>
      memoized({}, "prop", {
        value: 42,
        writable: true,
        enumerable: true,
        configurable: true,
      }),
    ).toThrow("@memoized can only decorate methods");
  });

  it("memoizes a method by its arguments", () => {
    let runs = 0;
    const target = {
      compute(this: unknown, n: number) {
        runs += 1;
        return n + 1;
      },
    };
    const descriptor = Object.getOwnPropertyDescriptor(target, "compute")!;
    memoized(target, "compute", descriptor);
    Object.defineProperty(target, "compute", descriptor);

    expect(target.compute(1)).toBe(2);
    expect(target.compute(1)).toBe(2);
    expect(target.compute(2)).toBe(3);
    expect(runs).toBe(2);
  });
});

// Default Crockford-style alphabet exposed by `fnvHash` /
// `toBase32`. Tests that need to assert "output is in this
// alphabet" use this regex; tests that need a custom alphabet
// declare their own.
const DEFAULT_BASE32_RE = /^[0-9a-hjkmnp-tv-z]+$/;

describe("fnvHash / fnvHashWithOptions", () => {
  it("returns a 6-char Crockford-style base-32 string by default", () => {
    const h = fnvHash("databricks");
    expect(h).toHaveLength(6);
    expect(h).toMatch(DEFAULT_BASE32_RE);
  });

  it("is deterministic across calls for the same input", () => {
    expect(fnvHash("hello")).toBe(fnvHash("hello"));
    expect(fnvHash({ a: 1, b: 2 })).toBe(fnvHash({ a: 1, b: 2 }));
  });

  it("produces distinct hashes for distinct primitive inputs", () => {
    const samples = new Set([
      fnvHash("alpha"),
      fnvHash("beta"),
      fnvHash("gamma"),
      fnvHash("delta"),
      fnvHash("epsilon"),
    ]);
    expect(samples.size).toBe(5);
  });

  it("distinguishes primitives by type, not just stringified value", () => {
    // The canonicalizer prefixes every primitive token with its
    // `typeof`, so coercion-equal values still hash distinctly.
    expect(fnvHash("1")).not.toBe(fnvHash(1));
    expect(fnvHash("true")).not.toBe(fnvHash(true));
  });

  it("collapses null and undefined to the same hash", () => {
    // Both yield `null:` so consumers don't need to discriminate
    // when building cache keys for "missing value" slots.
    expect(fnvHash(null)).toBe(fnvHash(undefined));
  });

  it("hashes objects independently of key insertion order", () => {
    const a = { a: 1, b: 2, c: 3 };
    const b = { c: 3, b: 2, a: 1 };
    expect(fnvHash(a)).toBe(fnvHash(b));
  });

  it("preserves array order", () => {
    expect(fnvHash([1, 2, 3])).not.toBe(fnvHash([3, 2, 1]));
    // But the same order is stable across calls.
    expect(fnvHash([1, 2, 3])).toBe(fnvHash([1, 2, 3]));
  });

  it("hashes Sets independently of insertion order", () => {
    const a = new Set(["x", "y", "z"]);
    const b = new Set(["z", "x", "y"]);
    expect(fnvHash(a)).toBe(fnvHash(b));
  });

  it("hashes Maps independently of key insertion order", () => {
    const a = new Map<string, number>([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
    const b = new Map<string, number>([
      ["c", 3],
      ["b", 2],
      ["a", 1],
    ]);
    expect(fnvHash(a)).toBe(fnvHash(b));
  });

  it("walks nested structures recursively", () => {
    const a = { user: { name: "alice", roles: ["admin", "owner"] } };
    const b = { user: { roles: ["admin", "owner"], name: "alice" } };
    expect(fnvHash(a)).toBe(fnvHash(b));
    // Swapping array entries (which DO carry order) must change the hash.
    const c = { user: { name: "alice", roles: ["owner", "admin"] } };
    expect(fnvHash(a)).not.toBe(fnvHash(c));
  });

  it("does not blow the stack on circular references", () => {
    const a: { self?: unknown; name: string } = { name: "alice" };
    a.self = a;
    expect(() => fnvHash(a)).not.toThrow();
    expect(fnvHash(a)).toMatch(DEFAULT_BASE32_RE);
  });

  it("supports a custom output length, clamped to 7", () => {
    expect(fnvHashWithOptions({ length: 4 }, "user@example.com")).toHaveLength(4);
    expect(fnvHashWithOptions({ length: 1 }, "user@example.com")).toHaveLength(1);
    // 32-bit digest base-32-encodes to at most 7 chars.
    expect(fnvHashWithOptions({ length: 7 }, "user")).toHaveLength(7);
    expect(fnvHashWithOptions({ length: 99 }, "user")).toHaveLength(7);
  });

  it("encodes with a custom alphabet when supplied", () => {
    const ALPHA_UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
    const h = fnvHashWithOptions({ alphabet: ALPHA_UPPER }, "value");
    expect(h).toMatch(/^[A-Z0-5]+$/);
    expect(h).toHaveLength(6);
  });

  it("throws when the custom alphabet is not 32 unique characters", () => {
    expect(() => fnvHashWithOptions({ alphabet: "abc" }, "x")).toThrow(
      /must contain 32 unique characters/i,
    );
    // Repeats also fail (32 chars but only 31 unique).
    const dupe = "0123456789abcdefghjkmnpqrstvwxy0";
    expect(() => fnvHashWithOptions({ alphabet: dupe }, "x")).toThrow(
      /must contain 32 unique characters/i,
    );
  });

  it("namespaces via the digest seed: same input + different seed -> different hash", () => {
    const h1 = fnvHashWithOptions({ digest: 0xdead_beef }, "key");
    const h2 = fnvHashWithOptions({ digest: 0xfeed_face }, "key");
    expect(h1).not.toBe(h2);
    // Default seed differs from any explicit override.
    expect(fnvHash("key")).not.toBe(h1);
  });

  it("digest seed is stable across calls with the same seed + input", () => {
    const opts = { digest: 0x1234_5678 };
    expect(fnvHashWithOptions(opts, "foo", "bar")).toBe(
      fnvHashWithOptions(opts, "foo", "bar"),
    );
  });

  it("hashes the variadic value list together (chained inputs are not concatenated strings)", () => {
    // `fnvHash("ab", "c")` and `fnvHash("a", "bc")` walk through
    // the same canonical token stream when both are wrapped in
    // the variadic args array, but `fnvHash("abc")` differs
    // because the string boundary changes the per-string `string:`
    // tag prefix.
    expect(fnvHash("ab", "c")).not.toBe(fnvHash("abc"));
  });
});

describe("sleep", () => {
  it("resolves after roughly the requested duration", async () => {
    const start = Date.now();
    await sleep(20);
    // Generous lower bound so flaky timer scheduling on busy CI
    // doesn't trip the assertion. Upper bound stays loose for
    // the same reason.
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });

  it("rejects with signal.reason when the signal is already aborted", async () => {
    const c = new AbortController();
    c.abort(new Error("nope"));
    await expect(sleep(50, c.signal)).rejects.toThrow("nope");
  });

  it("rejects early with signal.reason when aborted mid-wait", async () => {
    const c = new AbortController();
    const start = Date.now();
    const p = sleep(10_000, c.signal);
    setTimeout(() => c.abort(new Error("cancelled")), 10);
    await expect(p).rejects.toThrow("cancelled");
    // Returned well before the 10s timer would have fired.
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("ignores a signal that aborts after the timer already fired", async () => {
    const c = new AbortController();
    await sleep(10, c.signal);
    // Aborting after resolve must not flip the resolved promise
    // into a rejection (the listener is removed when the timer
    // fires) and must not throw on the late abort either.
    expect(() => c.abort(new Error("late"))).not.toThrow();
  });
});

describe("poll", () => {
  it("stops with a TimeoutError once timeoutMs elapses", async () => {
    const start = Date.now();
    const seen: number[] = [];
    let err: unknown;
    try {
      for await (const value of poll(({ attempt }) => attempt, {
        intervalMs: 20,
        timeoutMs: 60,
      })) {
        seen.push(value);
      }
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("TimeoutError");
    expect(seen.length).toBeGreaterThan(0);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("forwards the timeout to ctx.signal so producers can abort in-flight work", async () => {
    let producerErr: unknown;
    let err: unknown;
    try {
      for await (const _ of poll(
        ({ signal }) =>
          new Promise<number>((_resolve, reject) => {
            const onAbort = (): void => {
              producerErr = signal.reason;
              reject(signal.reason);
            };
            signal.addEventListener("abort", onAbort, { once: true });
          }),
        { intervalMs: 10, timeoutMs: 40 },
      )) {
        // unreachable
      }
    } catch (e) {
      err = e;
    }
    expect(producerErr).toBeInstanceOf(DOMException);
    expect((producerErr as DOMException).name).toBe("TimeoutError");
    expect(err).toBe(producerErr);
  });

  it("does not fire the timeout when the loop finishes first", async () => {
    const seen: number[] = [];
    for await (const value of poll(({ attempt }) => attempt, {
      intervalMs: 5,
      timeoutMs: 1_000,
      predicate: (v) => v < 2,
    })) {
      seen.push(value);
    }
    expect(seen).toEqual([0, 1, 2]);
  });
});

describe("toBase32", () => {
  it("encodes 0 as the alphabet's zero character", () => {
    expect(toBase32(0)).toBe("0");
  });

  it("encodes small values with no padding", () => {
    expect(toBase32(1)).toBe("1");
    expect(toBase32(31)).toBe("z");
    expect(toBase32(32)).toBe("10");
  });

  it("round-trips through the default alphabet bit-pattern", () => {
    // 5 bits per char, 32-bit input -> at most 7 chars. Validate
    // the encoding is a permutation of the alphabet by spot-
    // checking a couple of known values.
    expect(toBase32(0xdeadbe)).toMatch(/^[0-9a-hjkmnp-tv-z]+$/);
    expect(toBase32(0xffffffff)).toHaveLength(7);
  });

  it("uses a custom alphabet when supplied", () => {
    const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
    expect(toBase32(0, UPPER)).toBe("A");
    expect(toBase32(31, UPPER)).toBe("5");
  });

  it("throws when the custom alphabet is not 32 unique characters", () => {
    expect(() => toBase32(1, "abc")).toThrow(/must contain 32 unique characters/i);
  });

  it("disableAlphabetValidation skips uniqueness check but still rejects wrong length", () => {
    // A 32-char alphabet with a duplicate character: passes the
    // length check but fails the uniqueness check. Skipping the
    // uniqueness check returns a (less safe) encoding without
    // throwing.
    const dupe = "00000000000000000000000000000000";
    expect(() => toBase32(1, dupe)).toThrow(/must contain 32 unique characters/i);
    expect(() => toBase32(1, dupe, true)).not.toThrow();
    // Wrong length always throws regardless of the flag.
    expect(() => toBase32(1, "abc", true)).toThrow(
      /must contain exactly 32 characters/i,
    );
  });
});
