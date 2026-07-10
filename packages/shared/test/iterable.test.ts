import { describe, expect, test } from "bun:test";

import { emptySequence, type Sequence, sequence } from "../src/iterable.js";

function seq<T>(arr: readonly T[]): Sequence<T> {
  return sequence(arr);
}

function expectSameAsArray<T, R>(
  arr: readonly T[],
  fromSequence: (s: Sequence<T>) => R,
  fromArray: (a: readonly T[]) => R,
): void {
  expect(fromSequence(seq(arr))).toEqual(fromArray(arr));
}

describe("sequence array parity", () => {
  test("done peeks one value without consuming iteration", () => {
    const s = sequence([1, 2, 3]);
    expect(s.done).toBe(false);
    expect([...s]).toEqual([1, 2, 3]);
    expect(emptySequence.done).toBe(true);
    expect([...emptySequence]).toEqual([]);
  });

  test("distinct drops later duplicates in encounter order", () => {
    const arr = [1, 2, 1, 3, 2, 4];
    expect([...sequence(arr).distinct()]).toEqual([...new Set(arr)]);
    expect([...sequence(["a", "A", "a"]).distinct()]).toEqual(["a", "A"]);
  });

  test("distinct is lazy and checks uniqueness as values are pulled", () => {
    let pulled = 0;
    const src = sequence({
      *[Symbol.iterator]() {
        for (const n of [1, 1, 2, 3]) {
          pulled++;
          yield n;
        }
      },
    });
    const iter = src.distinct()[Symbol.iterator]();

    expect(iter.next()).toEqual({ value: 1, done: false });
    expect(pulled).toBe(1);

    expect(iter.next()).toEqual({ value: 2, done: false });
    expect(pulled).toBe(3);

    expect(iter.next()).toEqual({ value: 3, done: false });
    expect(pulled).toBe(4);

    expect(iter.next()).toEqual({ value: undefined, done: true });
    expect(pulled).toBe(4);
  });

  test("empty source returns emptySequence", () => {
    expect([...sequence()]).toEqual([]);
    expect([...sequence(null)]).toEqual([]);
    expect([...sequence(undefined)]).toEqual([]);
    expect(sequence()).toBe(emptySequence);
    expect(sequence(null)).toBe(emptySequence);
    expect(sequence([])).toBe(emptySequence);
    expect(sequence(new Set())).toBe(emptySequence);
    expect(sequence(new Map())).toBe(emptySequence);
    expect(sequence().done).toBe(true);
  });

  test("iteration matches array spread", () => {
    const arr = [1, 2, 3];
    expect([...seq(arr)]).toEqual([...arr]);
  });

  test("toArray matches array spread", () => {
    const arr = [1, 2, 3];
    expect(seq(arr).toArray()).toEqual([...arr]);
  });

  test("map matches Array.prototype.map", () => {
    const arr = [1, 2, 3, 4];
    expectSameAsArray(
      arr,
      (s) => [...s.map((n) => n * 2)],
      (a) => a.map((n) => n * 2),
    );
  });

  test("filter matches Array.prototype.filter", () => {
    const arr = [1, 2, 3, 4];
    expectSameAsArray(
      arr,
      (s) => [...s.filter((n) => n % 2 === 0)],
      (a) => a.filter((n) => n % 2 === 0),
    );
  });

  test("flatMap matches Array.prototype.flatMap", () => {
    const arr = [1, 2, 3];
    expectSameAsArray(
      arr,
      (s) => [...s.flatMap((n) => n)],
      (a) => a.flatMap((n) => n),
    );
    expectSameAsArray(
      arr,
      (s) => [...s.flatMap((n) => [n, n * 10])],
      (a) => a.flatMap((n) => [n, n * 10]),
    );
  });

  test("flat matches Array.prototype.flat", () => {
    const nested = [1, [2, 3], 4];
    expectSameAsArray(nested, (s) => [...s.flat()], (a) => a.flat());

    const deep = [1, [2, [3]], 4];
    expectSameAsArray(deep, (s) => [...s.flat(2)], (a) => a.flat(2));
    expectSameAsArray(deep, (s) => [...s.flat(0)], (a) => a.flat(0));
    expectSameAsArray(deep, (s) => [...s.flat(-1)], (a) => a.flat(0));
    expectSameAsArray(
      deep,
      (s) => [...s.flat(Infinity)],
      (a) => a.flat(Infinity),
    );

    const withSet = [1, new Set([2, 3]), 4];
    expectSameAsArray(withSet, (s) => [...s.flat()], (a) => a.flat());
  });

  test("find matches Array.prototype.find", () => {
    const arr = ["a", "b", "c", "b"];
    expectSameAsArray(
      arr,
      (s) => s.find((v) => v === "b"),
      (a) => a.find((v) => v === "b"),
    );
    expectSameAsArray(
      arr,
      (s) => s.find((v) => v === "z"),
      (a) => a.find((v) => v === "z"),
    );
  });

  test("findLast matches Array.prototype.findLast", () => {
    const arr = ["a", "b", "c", "b"];
    expectSameAsArray(
      arr,
      (s) => s.findLast((v) => v === "b"),
      (a) => a.findLast((v) => v === "b"),
    );
  });

  test("findIndex matches Array.prototype.findIndex", () => {
    const arr = ["a", "b", "c", "b"];
    expectSameAsArray(
      arr,
      (s) => s.findIndex((v) => v === "b"),
      (a) => a.findIndex((v) => v === "b"),
    );
    expectSameAsArray(
      arr,
      (s) => s.findIndex((v) => v === "z"),
      (a) => a.findIndex((v) => v === "z"),
    );
  });

  test("findLastIndex matches Array.prototype.findLastIndex", () => {
    const arr = ["a", "b", "c", "b"];
    expectSameAsArray(
      arr,
      (s) => s.findLastIndex((v) => v === "b"),
      (a) => a.findLastIndex((v) => v === "b"),
    );
  });

  test("some matches Array.prototype.some", () => {
    const arr = [1, 2, 3];
    expectSameAsArray(
      arr,
      (s) => s.some((n) => n > 2),
      (a) => a.some((n) => n > 2),
    );
    expectSameAsArray(
      arr,
      (s) => s.some((n) => n > 9),
      (a) => a.some((n) => n > 9),
    );
    expectSameAsArray(
      [],
      (s) => s.some(() => true),
      (a) => a.some(() => true),
    );
  });

  test("every matches Array.prototype.every", () => {
    expectSameAsArray(
      [2, 4, 6],
      (s) => s.every((n) => n % 2 === 0),
      (a) => a.every((n) => n % 2 === 0),
    );
    expectSameAsArray(
      [2, 3, 4],
      (s) => s.every((n) => n % 2 === 0),
      (a) => a.every((n) => n % 2 === 0),
    );
    expectSameAsArray(
      [],
      (s) => s.every(() => false),
      (a) => a.every(() => false),
    );
  });

  test("forEach matches Array.prototype.forEach", () => {
    const arr = [1, 2, 3];
    const seqSeen: number[] = [];
    const arrSeen: number[] = [];
    seq(arr).forEach((n, i) => seqSeen.push(n * 10 + i));
    arr.forEach((n, i) => arrSeen.push(n * 10 + i));
    expect(seqSeen).toEqual(arrSeen);
  });

  test("concat matches Array.prototype.concat", () => {
    const arr = [1, 2];
    expectSameAsArray(
      arr,
      (s) => [...s.concat(3, [4, 5])],
      (a) => a.concat(3, [4, 5]),
    );
    const setArg = new Set([3]);
    expectSameAsArray(
      arr,
      (s) => [...s.concat(setArg as unknown as number)],
      (a) => a.concat(setArg as unknown as number),
    );
  });

  test("at matches Array.prototype.at", () => {
    const arr = [1, 2, 3, 4];
    for (const index of [0, 1, -1, -2, 1.7, -1.9, 99, -99]) {
      expectSameAsArray(
        arr,
        (s) => s.at(index),
        (a) => a.at(index),
      );
    }
  });

  test("first matches Array.prototype.find for first element", () => {
    expectSameAsArray(
      [9, 8, 7],
      (s) => s.first(),
      (a) => a.find(() => true),
    );
    expectSameAsArray(
      [],
      (s) => s.first(),
      (a) => a.find(() => true),
    );
  });

  test("callbacks receive the same index as array methods", () => {
    const arr = [10, 20, 30];
    const seqIndexes: number[] = [];
    const arrIndexes: number[] = [];
    [...seq(arr).map((_, i) => {
      seqIndexes.push(i);
      return _;
    })];
    arr.map((_, i) => {
      arrIndexes.push(i);
      return _;
    });
    expect(seqIndexes).toEqual(arrIndexes);
  });
});
