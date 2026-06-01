/** Minimal shape for objects that expose an optional `name` (e.g. AppKit plugins). */
export interface NameLike {
  name?: string;
}

type MemoizeKeyFn<TArgs extends readonly unknown[]> = (...args: TArgs) => string;

export interface MemoizeOptions<TArgs extends readonly unknown[]> {
  /** Build a cache key from call arguments. Defaults to `JSON.stringify(args)`. */
  key?: MemoizeKeyFn<TArgs>;
}

/**
 * Run a zero-argument factory once; later calls return the same result.
 *
 * Concurrent callers share one in-flight promise until the factory settles.
 */
export function memoize<T>(factory: () => T | Promise<T>): () => Promise<T>;

/**
 * Memoize by call arguments. Sync `fn` returns values directly; if `fn` is
 * async (or returns a promise), concurrent calls for the same key share one
 * in-flight promise.
 */
export function memoize<TArgs extends readonly unknown[], TReturn>(
  fn: (...args: TArgs) => TReturn | Promise<TReturn>,
  options?: MemoizeOptions<TArgs>,
): (...args: TArgs) => TReturn | Promise<TReturn>;

export function memoize<TArgs extends readonly unknown[], TReturn>(
  fn:
    | ((...args: TArgs) => TReturn | Promise<TReturn>)
    | (() => TReturn | Promise<TReturn>),
  options?: MemoizeOptions<TArgs>,
): ((...args: TArgs) => TReturn | Promise<TReturn>) | (() => Promise<TReturn>) {
  if (fn.length === 0) {
    const factory = fn as () => TReturn | Promise<TReturn>;
    let cache: Promise<TReturn> | undefined;
    return () => {
      if (cache === undefined) {
        cache = Promise.resolve().then(factory);
      }
      return cache;
    };
  }

  const keyOf = options?.key ?? defaultMemoizeKey<TArgs>;
  const syncCache = new Map<string, TReturn>();
  const asyncCache = new Map<string, Promise<TReturn>>();

  return (...args: TArgs) => {
    const key = keyOf(...args);
    if (asyncCache.has(key)) {
      return asyncCache.get(key)!;
    }
    if (syncCache.has(key)) {
      return syncCache.get(key)!;
    }

    const result = (fn as (...args: TArgs) => TReturn | Promise<TReturn>)(...args);
    if (isPromise(result)) {
      const pending = Promise.resolve(result);
      asyncCache.set(key, pending);
      void pending.catch(() => {
        asyncCache.delete(key);
      });
      return pending;
    }

    syncCache.set(key, result);
    return result;
  };
}

/**
 * Method decorator: memoizes the decorated method by its arguments.
 *
 * Requires `experimentalDecorators` in the consumer's `tsconfig.json`.
 */
export function memoized(
  _target: object,
  _propertyKey: string | symbol,
  descriptor: PropertyDescriptor,
): PropertyDescriptor {
  const original = descriptor.value;
  if (typeof original !== "function") {
    throw new TypeError("@memoized can only decorate methods");
  }
  descriptor.value = memoize(original as (...args: readonly unknown[]) => unknown);
  return descriptor;
}

function defaultMemoizeKey<TArgs extends readonly unknown[]>(...args: TArgs): string {
  return JSON.stringify(args);
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    value !== null &&
    typeof value === "object" &&
    "then" in value &&
    typeof (value as Promise<T>).then === "function"
  );
}
