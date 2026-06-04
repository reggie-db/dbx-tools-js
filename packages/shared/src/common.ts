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
 * Thenable returns (anything with a `.then` method) are accepted; the
 * cached value is always a native `Promise<T>` because we route through
 * `Promise.resolve().then(factory)`.
 */
export function memoize<T>(factory: () => T | PromiseLike<T>): () => Promise<T>;

/**
 * Memoize by call arguments. Sync `fn` returns values directly; if `fn`
 * returns a thenable (`Promise` or any object with a `.then` method),
 * concurrent calls for the same key share one in-flight promise.
 *
 * Input is `T | PromiseLike<T>` so foreign thenables (e.g. third-party
 * promise libraries, hand-rolled `{ then }` shims) are accepted; the
 * async branch wraps them with `Promise.resolve(...)` so the cached
 * entry is always a native `Promise<T>` even when the caller hands us a
 * non-spec-compliant thenable.
 */
export function memoize<TArgs extends readonly unknown[], TReturn>(
  fn: (...args: TArgs) => TReturn | PromiseLike<TReturn>,
  options?: MemoizeOptions<TArgs>,
): (...args: TArgs) => TReturn | Promise<TReturn>;

export function memoize<TArgs extends readonly unknown[], TReturn>(
  fn:
    | ((...args: TArgs) => TReturn | PromiseLike<TReturn>)
    | (() => TReturn | PromiseLike<TReturn>),
  options?: MemoizeOptions<TArgs>,
): ((...args: TArgs) => TReturn | Promise<TReturn>) | (() => Promise<TReturn>) {
  if (fn.length === 0) {
    const factory = fn as () => TReturn | PromiseLike<TReturn>;
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

    const result = (fn as (...args: TArgs) => TReturn | PromiseLike<TReturn>)(...args);
    if (isThenable(result)) {
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

function isThenable<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    value !== null &&
    typeof value === "object" &&
    "then" in value &&
    typeof (value as PromiseLike<T>).then === "function"
  );
}

export function fnvHash(...values: string[]): string {
  return fnvHashWithOptions({}, ...values);
}

export function fnvHashWithOptions(
  options: { length?: number; alphabet?: string } = {},
  ...values: string[]
): string {
  const { length = 6 } = options;

  let digest = 0x811c9dc5;

  for (const value of values) {
    for (let i = 0; i < value.length; i++) {
      digest ^= value.charCodeAt(i);
      digest = Math.imul(digest, 0x01000193);
    }
  }
  const alphabet = base32Alphabet(options.alphabet);
  return toBase32(digest, alphabet, true)
    .padStart(7, alphabet[0])
    .slice(0, Math.min(length, 7));
}

const BASE32_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

function base32Alphabet(alphabet?: string): string {
  if (alphabet === undefined) return BASE32_ALPHABET;
  else if (new Set(alphabet).size !== 32) {
    throw new Error("Base32 alphabet must contain 32 unique characters");
  }
  return alphabet;
}

export function toBase32(
  value: number,
  alphabet?: string,
  disableAlphabetValidation?: boolean,
): string {
  if (!disableAlphabetValidation) {
    alphabet = base32Alphabet(alphabet);
  }
  if (alphabet!.length !== 32) {
    throw new Error(
      `Base32 alphabet must contain exactly 32 characters, got ${alphabet!.length}`,
    );
  }
  value >>>= 0;
  if (value === 0) {
    return alphabet![0]!;
  }
  let result = "";
  while (value > 0) {
    result = alphabet![value & 31] + result;
    value >>>= 5;
  }
  return result;
}

export function isDatabricksAppEnv(env?: Record<string, string | undefined>): boolean {
  env ??= typeof process !== "undefined" && process.env ? process.env : undefined;
  if (!env) {
    return false;
  }
  const appName = env.DATABRICKS_APP_NAME?.trim();
  const host = env.DATABRICKS_HOST?.trim();
  const port = env.DATABRICKS_APP_PORT?.trim();

  if (!appName || !host || !port) {
    return false;
  }

  try {
    const url = new URL(host);
    if (!["http:", "https:"].includes(url.protocol)) {
      return false;
    }
  } catch {
    return false;
  }

  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    return false;
  }

  return true;
}
