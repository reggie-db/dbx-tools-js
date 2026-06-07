import fastDeepEqual from "fast-deep-equal";

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

/**
 * Per-iteration context handed to {@link PollProducer} and the
 * predicate on each step of a {@link poll} loop. Bundles the
 * iteration metadata so the call signatures stay stable as `poll`
 * grows additional fields.
 *
 * `signal` is owned by `poll`: it tracks the external
 * `PollOptions.signal` (when supplied) and also fires when the
 * consumer breaks out of the loop, so producers can forward it to
 * any in-flight work (`fetch`, SDK calls, etc.) and have a single
 * cancellation source tear down both the request and the loop.
 *
 * `attributes` is a mutable scratchpad shared across every
 * iteration of a single `poll` run. The same object reference is
 * passed each call so writes from one iteration are visible to the
 * next - useful for stashing per-loop state (retry counters, start
 * timestamps, anything you'd otherwise close over via a let).
 * Generic `A` lets callers type the bag; defaults to
 * `Record<string, unknown>`.
 */
export interface PollContext<T, A = Record<string, unknown>> {
  /** Zero-based iteration index (`0` on the first call). */
  attempt: number;
  /** Value yielded on the prior iteration; `undefined` on the first. */
  previous: T | undefined;
  /** Cancellation handle. Always defined; forward to in-flight work. */
  signal: AbortSignal;
  /** Per-run mutable scratchpad shared across iterations. */
  attributes: A;
}

/** One step of a {@link poll} loop. See {@link PollContext}. */
export type PollProducer<T, A = Record<string, unknown>> = (
  ctx: PollContext<T, A>,
) => T | PromiseLike<T>;

export interface PollOptions<T, A = Record<string, unknown>> {
  /** Milliseconds to wait between polls. */
  intervalMs: number;
  /**
   * Predicate evaluated against each yielded value: return `true` to
   * keep polling, `false` to stop. May be sync or async - a
   * `PromiseLike<boolean>` is awaited before the decision is made.
   * Receives the same {@link PollContext} as the producer (same
   * `signal`, same `attributes` bag), so an async predicate can
   * forward the signal to its own in-flight work or read/write
   * shared state.
   *
   * Omit to poll forever (the consumer stops by breaking out of the
   * loop or by aborting `signal`).
   */
  filter?:
    | ((value: T, ctx: PollContext<T, A>) => boolean | PromiseLike<boolean>)
    | "distinct";
  predicate?: (value: T, ctx: PollContext<T, A>) => boolean | PromiseLike<boolean>;
  /**
   * External cancellation handle. Tied into the internal signal that
   * `poll` hands to `producer`, so aborting it tears down both the
   * in-flight request and the inter-poll sleep.
   */
  signal?: AbortSignal;
  /**
   * Initial value for `ctx.attributes`. Defaults to `{}`. The same
   * object is reused across iterations, so callers can pre-populate
   * fields (timers, retry counters, etc.) and the producer /
   * predicate can mutate them in place.
   */
  attributes?: A;
}

/**
 * Async iterable that drives a periodic poll. Each iteration:
 *
 *   1. Builds a {@link PollContext} (`attempt`, `previous`, `signal`,
 *      shared `attributes`) and calls `producer(ctx)`; yields the
 *      resolved value.
 *   2. Evaluates `options.predicate(value, ctx)`; stops when it
 *      returns (or resolves to) `false`.
 *   3. Sleeps `options.intervalMs` before the next attempt.
 *
 * The first call runs immediately (no leading sleep) so the consumer
 * sees a value without waiting an interval. Errors thrown by
 * `producer` propagate through the generator.
 *
 * `poll` always creates an internal `AbortController` and exposes
 * `internal.signal` as `ctx.signal`, so producers can rely on a
 * defined signal without a nullish check. The external
 * `options.signal` is tied in, and a `try/finally` aborts the
 * internal signal when the consumer breaks out of the `for await`
 * (or the loop throws), so any producer work still holding the
 * signal sees the cancellation too.
 *
 * @example
 * for await (const msg of poll(
 *   async ({ signal }) =>
 *     client.genie.getMessage({ ... }, { abortSignal: signal }),
 *   {
 *     intervalMs: 250,
 *     predicate: (m) => !TERMINAL_STATUSES.has(m.status),
 *     signal: controller.signal,
 *   },
 * )) {
 *   render(msg);
 * }
 *
 * @example
 * // Typed attributes for per-run state.
 * type Stats = { failures: number; startedAt: number };
 * for await (const x of poll<Thing, Stats>(
 *   async ({ attributes, signal }) => {
 *     try {
 *       return await fetchThing(signal);
 *     } catch (err) {
 *       attributes.failures += 1;
 *       throw err;
 *     }
 *   },
 *   {
 *     intervalMs: 500,
 *     attributes: { failures: 0, startedAt: Date.now() },
 *     predicate: (_v, { attempt, attributes }) =>
 *       attempt < 20 && attributes.failures < 3,
 *   },
 * )) {
 *   handle(x);
 * }
 */
export async function* poll<T, A = Record<string, unknown>>(
  producer: PollProducer<T, A>,
  options: PollOptions<T, A>,
): AsyncGenerator<T, void, void> {
  const { intervalMs, predicate, signal, attributes } = options;
  const controller = new AbortController();
  if (signal) tieAbortSignal(controller, signal);
  // Single shared attributes object so writes from one iteration are
  // visible on the next. `{} as A` is safe because either the caller
  // supplied `attributes` (typed) or `A` defaulted to the unknown
  // record shape (in which case `{}` satisfies it).
  const sharedAttributes = attributes ?? ({} as A);
  try {
    let previous: T | undefined;
    for (let attempt = 0; ; attempt++) {
      controller.signal.throwIfAborted();
      const ctx: PollContext<T, A> = {
        attempt,
        previous,
        signal: controller.signal,
        attributes: sharedAttributes,
      };
      const value = await producer(ctx);
      if (options.filter) {
        if (options.filter === "distinct") {
          if (fastDeepEqual(previous, value)) continue;
        } else if (!(await options.filter(value, ctx))) continue;
      }
      yield value;
      if (predicate && !(await predicate(value, ctx))) return;
      await sleep(intervalMs, controller.signal);
      previous = value;
    }
  } finally {
    controller.abort();
  }
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

/**
 * Tie a child `AbortController` to a parent signal. The child
 * aborts whenever the parent aborts; aborting the child does not
 * affect the parent (so a fetch-level cancel doesn't tear down the
 * main poll loop).
 */
export function tieAbortSignal(child: AbortController, parent?: AbortSignal): void {
  if (!parent) return;
  else if (parent.aborted) {
    child.abort(parent.reason);
    return;
  }
  parent.addEventListener("abort", () => child.abort(parent.reason), {
    once: true,
  });
}

/**
 * Promisified `setTimeout` that wakes up early (and rejects with
 * `signal.reason`) when `signal` aborts mid-wait. Short-circuits to a
 * rejected promise when the signal is already aborted on entry.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Mint a short, collision-resistant id by sampling the first `length`
 * hex chars of a v4 UUID. `length` defaults to 8 (collision odds
 * ~1 in 4 billion - safe within a single conversation turn / job /
 * batch). Uses `globalThis.crypto.randomUUID()` so it works in
 * both Node (>= 19) and modern browsers.
 *
 * Use for ids that the caller cares about being typeable / short
 * (e.g. chart ids the LLM types into `[[chart:<id>]]` markers).
 * For ids that need to survive across long-running batches or be
 * globally unique, use a full UUID instead.
 */
export function shortId(length: number = 8): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, length);
}

/**
 * Extract a human-readable message from any thrown value. Returns
 * `value.message` when `value` is an `Error`, otherwise coerces
 * via `String(value)`. Collapses the ubiquitous
 *
 * ```ts
 * err instanceof Error ? err.message : String(err)
 * ```
 *
 * dance into a single helper, useful for log attributes and any
 * other "give me something printable" context where the caller
 * doesn't want to re-throw or rely on `console.error`'s default
 * formatting.
 */
export function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
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
