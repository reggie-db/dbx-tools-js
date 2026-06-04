import { describe, expect, it } from "bun:test";

import { memoize, memoized } from "../src/common.js";

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
