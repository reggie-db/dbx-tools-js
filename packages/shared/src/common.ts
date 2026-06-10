import fastDeepEqual from "fast-deep-equal";

/** Minimal shape for objects that expose an optional `name` (e.g. AppKit plugins). */
export interface NameLike {
  name?: string;
}

export type NonFunctionKeys<T> = {
  [K in keyof T]: T[K] extends (...args: any[]) => any ? never : K;
}[keyof T];

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
   * Hard upper bound on the total lifetime of the poll loop, in
   * milliseconds. When the budget elapses, `poll` aborts its
   * internal signal so the in-flight producer and inter-poll
   * sleep both tear down promptly, and the loop throws with the
   * `TimeoutError` `DOMException` produced by
   * `AbortSignal.timeout(timeoutMs)`. The budget starts ticking
   * the moment the generator is created, not on first iteration.
   * Omit to poll until `predicate` returns `false` or the
   * external `signal` aborts.
   */
  timeoutMs?: number;
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
  const { intervalMs, predicate, signal, attributes, timeoutMs } = options;
  const controller = new AbortController();
  if (signal) tieAbortSignal(controller, signal);
  if (timeoutMs !== undefined) {
    tieAbortSignal(controller, AbortSignal.timeout(timeoutMs));
  }
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
 * `signal.reason`) when `signal` aborts mid-wait. Short-circuits
 * to a rejected promise when the signal is already aborted on
 * entry, so the abort path is consistent regardless of whether
 * the wait actually started.
 *
 * Use as the building block for any "wait, but cancel cleanly"
 * pattern - inter-poll backoff, pacing loops, retry timers,
 * long-poll budgets - so cancellation always rejects with the
 * caller's `signal.reason` rather than silently resolving after
 * the timer expires.
 *
 * @example
 * await commonUtils.sleep(250, req.signal);
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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
 * Mint a v4 UUID, or a short hex slice of one when `length` is set.
 *
 * - `id()` returns a full RFC 4122 v4 UUID (e.g.
 *   `"123e4567-e89b-12d3-a456-426614174000"`). Pick this when
 *   global uniqueness matters: long-running batches, ids that
 *   cross a storage / process boundary, anything that may
 *   collide across machines. Default for new ids.
 * - `id(length)` returns the first `length` hex chars of a fresh
 *   UUID with dashes stripped (e.g. `id(8) -> "a3f1c92b"`). Pick
 *   this when the id has to be short / typeable and the scope
 *   is bounded - cache keys local to a request, slug suffixes,
 *   anything that's only meaningful within a single conversation
 *   turn or batch. `length <= 0` throws.
 *
 * Implementation note: built on `globalThis.crypto.randomUUID()`
 * so the same function works in Node (>= 19) and modern browsers
 * without a polyfill or `node:crypto` import.
 *
 * @example
 * id();   // "123e4567-e89b-12d3-a456-426614174000"
 * id(8);  // "a3f1c92b"  (~1-in-4-billion collisions)
 * id(12); // "a3f1c92b4d7e"  (~1-in-280-trillion)
 */
export function id(length?: number): string {
  if (length !== undefined && length <= 0) {
    throw new Error("Length must be greater than 0");
  }
  const id = globalThis.crypto.randomUUID();
  if (length !== undefined) {
    return id.replace(/-/g, "").slice(0, length);
  }
  return id;
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

/**
 * Short, deterministic FNV-1a hash over one or more values.
 * Wraps {@link fnvHashWithOptions} with all defaults: 6-char
 * Crockford-style base-32 output (digits + lowercase, minus
 * `i`/`l`/`o`/`u`). Browser-safe (no `node:crypto`).
 *
 * Accepts any mix of primitives, arrays, plain objects, `Map`s,
 * and `Set`s; nested structures are walked deterministically so
 * the hash is order-stable for objects / maps / sets and
 * order-sensitive for arrays. Cycles are detected and folded
 * into a `circular:` marker so you can safely hand it
 * self-referential graphs.
 *
 * Use for cache keys, slug suffixes, log correlation ids, and
 * other "give me something short and stable" needs - **never**
 * for tokens, signatures, or anything an attacker shouldn't be
 * able to forge. FNV-1a is a non-cryptographic hash.
 *
 * @example
 * commonUtils.fnvHash("databricks-claude-sonnet-4-6"); // "k3p9q7"
 * commonUtils.fnvHash({ user: "alice", project: "demo" }); // stable
 * commonUtils.fnvHash([1, 2, 3]) !== commonUtils.fnvHash([3, 2, 1]);
 */
export function fnvHash(...values: unknown[]): string {
  return fnvHashWithOptions({}, ...values);
}

/**
 * Configurable counterpart to {@link fnvHash}.
 *
 * Options:
 *   - `length` (default `6`): number of base-32 chars to return.
 *     Capped at 7 - the underlying digest is 32 bits, which
 *     base-32-encodes to at most 7 chars; values past 7 are
 *     silently clamped. Output is left-padded with the alphabet's
 *     zero character so short digests still hit the requested
 *     width.
 *   - `alphabet` (default Crockford-style `"0123456789abcdefghjkmnpqrstvwxyz"`):
 *     32 distinct characters used to encode the digest. Pass a
 *     custom alphabet to fit a downstream charset constraint
 *     (e.g. uppercase only). Throws when the string is not exactly
 *     32 unique chars.
 *   - `digest` (default `0x811c9dc5`, the FNV-1a offset basis):
 *     the seed the running digest starts from. Useful for
 *     namespacing (`{ digest: namespaceHash }`) so otherwise-
 *     identical inputs hashed under different namespaces never
 *     collide, and for chaining hashes across pipeline stages.
 *
 * Walks all `values` through {@link hashAttributes} so structured
 * inputs (objects / maps / sets / arrays / cycles) hash in a
 * canonical order. The hash is **not** stable across changes to
 * the alphabet or `length` - those tune the output, not the
 * digest input.
 *
 * @example
 * fnvHashWithOptions({ length: 4 }, "user@example.com");          // 4 chars
 * fnvHashWithOptions({ digest: nsHash }, key) !== fnvHash(key);   // namespaced
 * fnvHashWithOptions({ alphabet: UPPER_ALPHA }, value);           // custom charset
 */
export function fnvHashWithOptions(
  options: { length?: number; alphabet?: string; digest?: number } = {},
  ...values: unknown[]
): string {
  const { length = 6 } = options;

  let digest = options.digest ?? 0x811c9dc5;

  for (const value of hashAttributes(values)) {
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

/**
 * Walk an arbitrary value as a stream of canonicalized string
 * tokens suitable for feeding into a streaming hash like FNV-1a.
 * Used by {@link fnvHashWithOptions} so structured inputs hash
 * deterministically without a stringification round-trip
 * through `JSON.stringify` (which silently drops `undefined`,
 * has no canonical key order, and can't represent cycles).
 *
 * Canonicalization rules:
 *
 *   - `null` / `undefined` collapse to `null:` so the two are
 *     indistinguishable in the digest.
 *   - Primitives (`string` / `number` / `boolean`) are tagged with
 *     their `typeof` so `"1"` and `1` produce different digests.
 *   - Arrays preserve order: `[1,2]` and `[2,1]` hash differently.
 *   - Plain objects emit keys in lexical order of each key's own
 *     hash-token stream, so `{a:1,b:2}` and `{b:2,a:1}` collapse
 *     to the same digest.
 *   - `Map` keys go through the same key-sort path as objects, so
 *     non-string keys (numbers, objects) sort canonically.
 *   - `Set`s are sorted by each element's hash-token stream and
 *     emit only the elements (no values), so insertion order
 *     doesn't leak into the digest.
 *   - Cycles are detected via a `WeakSet` tracker - the second
 *     time a node is visited it emits `circular:` and stops
 *     descending, so self-referential graphs hash without
 *     blowing the stack.
 *   - Anything else (functions, symbols, class instances with no
 *     enumerable keys past `Set`/`Map`/`Array` checks) falls
 *     through to a `${typeof}:${JSON.stringify(input)}` token.
 *
 * Yielding strings (rather than returning one) lets the caller
 * fold each chunk into a streaming digest without materialising
 * the full canonical form, which keeps memory bounded for large
 * objects.
 *
 * Internal helper - {@link fnvHashWithOptions} is the public
 * surface.
 */
function* hashAttributes(input: any, seen?: WeakSet<object>): Generator<string> {
  if (input === null || input === undefined) {
    yield "null:";
    return;
  }

  const inputType = typeof input;
  if (inputType === "string" || inputType === "number" || inputType === "boolean") {
    yield `${inputType}:`;
    yield input.toString();
    return;
  }
  seen ??= new WeakSet<object>();

  if (inputType === "object") {
    if (seen.has(input)) {
      yield "circular:";
      return;
    }
    seen.add(input);
    try {
      if (Array.isArray(input)) {
        yield "[";
        for (const item of input) {
          yield* hashAttributes(item, seen);
          yield ",";
        }
        yield "]";
        return;
      } else {
        const hashAttributeKeys = (keys: Array<unknown>) => {
          return keys
            .map((key) => {
              const keyHashAttributes = [...hashAttributes(key, seen)];
              return {
                key,
                keyHashAttributes,
                sortKey: keyHashAttributes.join("\0"),
              };
            })
            .sort((a, b) => a.sortKey.localeCompare(b.sortKey));
        };
        if (input instanceof Set) {
          yield "[";
          for (const hashAttributeKey of hashAttributeKeys(Array.from(input))) {
            yield* hashAttributeKey.keyHashAttributes;
            yield ",";
          }
          yield "]";
          return;
        } else {
          yield "{";
          const keys =
            input instanceof Map ? Array.from(input.keys()) : Object.keys(input);
          for (const hashAttributeKey of hashAttributeKeys(keys)) {
            const value =
              input instanceof Map
                ? input.get(hashAttributeKey.key)
                : input[hashAttributeKey.key as keyof typeof input];
            yield* hashAttributeKey.keyHashAttributes;
            yield ":";
            yield* hashAttributes(value, seen);
            yield ",";
          }
          yield "}";
          return;
        }
      }
    } finally {
      seen.delete(input);
    }
  }
  yield `${inputType}:${JSON.stringify(input)}`;
}

/**
 * Default Crockford-style base-32 alphabet: digits `0-9` then
 * lowercase letters with `i`, `l`, `o`, `u` removed (the four
 * Crockford treats as ambiguous with digits). Same alphabet
 * everything in this module produces by default, so output is
 * safe to drop into URLs, filenames, and `[A-Za-z0-9_-]`-bound
 * marker captures.
 */
const BASE32_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * Resolve a caller-supplied alphabet against the default. Returns
 * the default Crockford-style alphabet when the caller passed
 * nothing; otherwise validates the override is exactly 32 unique
 * chars and returns it. Throws on bad alphabets so callers fail
 * fast instead of producing silently-degraded encodings.
 */
function base32Alphabet(alphabet?: string): string {
  if (alphabet === undefined) return BASE32_ALPHABET;
  else if (new Set(alphabet).size !== 32) {
    throw new Error("Base32 alphabet must contain 32 unique characters");
  }
  return alphabet;
}

/**
 * Encode a 32-bit unsigned integer as base-32 using the default
 * Crockford-style alphabet (or `alphabet` when provided). The
 * encoding has **no** zero-padding by default - `toBase32(0)`
 * returns the alphabet's zero character, otherwise the result is
 * the minimal number of digits that fits the value. Pad / truncate
 * at the call site when you need a fixed width.
 *
 * `disableAlphabetValidation` skips the unique-32-char check on
 * `alphabet` for hot paths that have already validated the
 * alphabet. The function still requires `alphabet.length === 32`
 * either way - a wrong-length alphabet always throws.
 *
 * Used internally by {@link fnvHashWithOptions} but exported for
 * other "encode a small integer compactly" needs.
 *
 * @example
 * toBase32(0);        // "0"
 * toBase32(31);       // "z"
 * toBase32(0xdeadbe); // "6vmtw" (5 chars)
 */
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

/**
 * Narrow `value` to a plain (non-array) object. Use as a type guard
 * before indexing into / mutating parsed JSON so the access is
 * type-safe.
 *
 * @example
 * if (commonUtils.isRecord(parsed)) parsed.foo = 1;
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Delete every key in `keys` that is present on `value`, returning
 * whether anything was removed. A no-op that returns `false` when
 * `value` isn't a record (see {@link isRecord}), so callers can pass
 * an `unknown` nested field directly.
 *
 * @example
 * commonUtils.deleteKeys(payload, ["output", "messages"]);
 */
export function deleteKeys(value: unknown, keys: readonly string[]): boolean {
  if (!isRecord(value)) return false;
  let modified = false;
  for (const key of keys) {
    if (key in value) {
      delete value[key];
      modified = true;
    }
  }
  return modified;
}
