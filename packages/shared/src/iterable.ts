/**
 * Lazy iterable sequences with `Array`-compatible transforms and
 * terminal methods. Built for one-pass sources (generators, streams)
 * where re-iteration is not guaranteed unless caching is enabled.
 */

function isReusableIterable(value: Iterable<unknown>): boolean {
  return Array.isArray(value) || value instanceof Set || value instanceof Map;
}

function isEmptyIterable(value: Iterable<unknown>): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (value instanceof Set || value instanceof Map) return value.size === 0;
  return false;
}

function flattenValue(value: unknown, depth: number): Iterable<unknown> {
  if (depth > 0 && Array.isArray(value)) {
    const nextDepth = Number.isFinite(depth) ? depth - 1 : depth;
    return {
      *[Symbol.iterator]() {
        for (const item of value) yield* flattenValue(item, nextDepth);
      },
    };
  }
  return [value];
}

class SequenceImpl<T> {
  private iterator?: Iterator<T>;
  private exhausted: boolean;
  private consumed: boolean;
  private head?: T;

  constructor(
    private readonly source: Iterable<T>,
    private readonly cache: T[] | undefined,
    state: { exhausted?: boolean; consumed?: boolean } = {},
  ) {
    this.exhausted = state.exhausted ?? false;
    this.consumed = state.consumed ?? false;
  }

  private get caching(): boolean {
    return this.cache !== undefined;
  }

  private hasBuffered(): boolean {
    return this.caching ? this.cache!.length > 0 : this.head !== undefined;
  }

  private markConsumed(): void {
    if (!this.caching) this.consumed = true;
  }

  /**
   * `true` when the sequence has no values. Peeks at most one element
   * lazily; a later iteration still yields that element.
   */
  get done(): boolean {
    if (this.exhausted && !this.hasBuffered()) return true;
    this.pullOne();
    return !this.hasBuffered();
  }

  private pullOne(): void {
    if (this.exhausted || this.hasBuffered()) return;
    this.iterator ??= this.source[Symbol.iterator]();
    const next = this.iterator.next();
    if (next.done) this.exhausted = true;
    else if (this.caching) this.cache!.push(next.value);
    else this.head = next.value;
  }

  *[Symbol.iterator](): Iterator<T> {
    if (!this.caching && this.consumed) return;
    if (this.exhausted && !this.hasBuffered()) {
      this.markConsumed();
      return;
    }

    if (!this.caching) {
      if (this.head !== undefined) {
        const value = this.head;
        this.head = undefined;
        yield value;
      }
      this.iterator ??= this.source[Symbol.iterator]();
      for (let next = this.iterator.next(); !next.done; next = this.iterator.next()) {
        yield next.value;
      }
      this.exhausted = true;
      this.consumed = true;
      return;
    }

    this.iterator ??= this.source[Symbol.iterator]();
    let index = 0;
    for (;;) {
      if (index < this.cache!.length) {
        yield this.cache![index++]!;
        continue;
      }
      if (this.exhausted) return;
      const next = this.iterator.next();
      if (next.done) {
        this.exhausted = true;
        return;
      }
      this.cache!.push(next.value);
      yield next.value;
      index++;
    }
  }

  private derive<U>(fn: (value: T, index: number) => Iterable<U>): Sequence<U> {
    const self = this;
    return sequence({
      *[Symbol.iterator]() {
        let index = 0;
        for (const value of self) yield* fn(value, index++);
      },
    });
  }

  /** Same semantics as `Array.prototype.map`. */
  map<U>(callback: (value: T, index: number) => U): Sequence<U> {
    return this.derive((value, index) => [callback(value, index)]);
  }

  /** Same semantics as `Array.prototype.filter`. */
  filter<S extends T>(predicate: (value: T, index: number) => value is S): Sequence<S>;
  filter(predicate: (value: T, index: number) => boolean): Sequence<T>;
  filter(predicate: (value: T, index: number) => boolean): Sequence<T> {
    return this.derive(function* (value, index) {
      if (predicate(value, index)) yield value;
    });
  }

  /**
   * Lazily yields values in encounter order, skipping a value only when
   * an equal one was already yielded (`Set` / SameValueZero). Uniqueness
   * is checked per element as the sequence is consumed; the source is
   * not materialized up front.
   */
  distinct(): Sequence<T> {
    const self = this;
    return sequence({
      *[Symbol.iterator]() {
        const seen = new Set<T>();
        for (const value of self) {
          if (seen.has(value)) continue;
          seen.add(value);
          yield value;
        }
      },
    });
  }

  /** Same semantics as `Array.prototype.flatMap`. */
  flatMap<U>(callback: (value: T, index: number) => U | ReadonlyArray<U>): Sequence<U> {
    return this.derive((value, index) => {
      const result = callback(value, index);
      return Array.isArray(result) ? result : [result];
    });
  }

  /** Same semantics as `Array.prototype.flat` (arrays only; default depth `1`). */
  flat(depth = 1): Sequence<T> {
    if (depth < 1) return this;
    return this.derive((value) => flattenValue(value, depth)) as Sequence<T>;
  }

  /** Same semantics as `Array.prototype.find`. */
  find<S extends T>(predicate: (value: T, index: number) => value is S): S | undefined;
  find(predicate: (value: T, index: number) => boolean): T | undefined;
  find(predicate: (value: T, index: number) => boolean): T | undefined {
    let index = 0;
    for (const value of this) {
      if (predicate(value, index++)) return value;
    }
    return undefined;
  }

  /** Same semantics as `Array.prototype.findLast`. */
  findLast<S extends T>(
    predicate: (value: T, index: number) => value is S,
  ): S | undefined;
  findLast(predicate: (value: T, index: number) => boolean): T | undefined;
  findLast(predicate: (value: T, index: number) => boolean): T | undefined {
    let index = 0;
    let match: T | undefined;
    for (const value of this) {
      if (predicate(value, index++)) match = value;
    }
    return match;
  }

  /** Same semantics as `Array.prototype.findIndex`. */
  findIndex(predicate: (value: T, index: number) => boolean): number {
    let index = 0;
    for (const value of this) {
      if (predicate(value, index)) return index;
      index++;
    }
    return -1;
  }

  /** Same semantics as `Array.prototype.findLastIndex`. */
  findLastIndex(predicate: (value: T, index: number) => boolean): number {
    let index = 0;
    let match = -1;
    for (const value of this) {
      if (predicate(value, index)) match = index;
      index++;
    }
    return match;
  }

  /** Same semantics as `Array.prototype.some`. */
  some(predicate: (value: T, index: number) => boolean): boolean {
    let index = 0;
    for (const value of this) if (predicate(value, index++)) return true;
    return false;
  }

  /** Same semantics as `Array.prototype.every`. */
  every<S extends T>(
    predicate: (value: T, index: number) => value is S,
  ): this is Sequence<S>;
  every(predicate: (value: T, index: number) => boolean): boolean;
  every(predicate: (value: T, index: number) => boolean): boolean {
    let index = 0;
    for (const value of this) if (!predicate(value, index++)) return false;
    return true;
  }

  /** Same semantics as `Array.prototype.forEach`. */
  forEach(callback: (value: T, index: number) => void): void {
    let index = 0;
    for (const value of this) callback(value, index++);
  }

  /** Same semantics as `Array.prototype.concat`. */
  concat(...items: (T | readonly T[])[]): Sequence<T> {
    const self = this;
    return sequence({
      *[Symbol.iterator]() {
        yield* self;
        for (const item of items) {
          if (Array.isArray(item)) yield* item;
          else yield item;
        }
      },
    });
  }

  /** Same semantics as `Array.prototype.at`. */
  at(index: number): T | undefined {
    return this.toArray().at(index);
  }

  /** Yields at most `count` elements from the front of the sequence. */
  take(count: number): Sequence<T> {
    if (count <= 0) return emptySequence as Sequence<T>;
    const self = this;
    return sequence({
      *[Symbol.iterator]() {
        let taken = 0;
        for (const value of self) {
          yield value;
          if (++taken >= count) return;
        }
      },
    });
  }

  /** First element, or `undefined` when empty (via `find`). */
  first(): T | undefined {
    return this.find(() => true);
  }

  /** Materialize the sequence into a new array. */
  toArray(): T[] {
    return [...this];
  }
}

/** Shared empty sequence (reusable for any `T`). */
export const emptySequence: Sequence<never> = new SequenceImpl([], undefined, {
  exhausted: true,
  consumed: true,
});

/** Lazy sequence over an iterable source. */
export type Sequence<T> = SequenceImpl<T>;

/**
 * Wrap `source` in a lazy sequence.
 *
 * @param source - Values to iterate. Omitted, `null`, `undefined`, or an
 *   empty array / `Set` / `Map` yields {@link emptySequence}.
 * @param cache - When `true`, pulled values are retained so the sequence
 *   can be iterated again. When `"auto"`, caching is enabled only for
 *   arrays, `Set`, and `Map`. Defaults to `false` (single-pass).
 */
export function sequence<T>(
  source?: Iterable<T> | null,
  options?: { cache?: boolean | "auto" },
): Sequence<T> {
  if (source === undefined || source === null || isEmptyIterable(source)) {
    return emptySequence as Sequence<T>;
  }
  const cacheOption = options?.cache !== undefined ? options.cache : false;
  const caching = cacheOption === "auto" ? isReusableIterable(source) : cacheOption;
  return new SequenceImpl(source, caching ? [] : undefined);
}
