import type { CancellationToken } from "@databricks/sdk-experimental";
import { ApiError, Context, HttpError } from "@databricks/sdk-experimental";

// Direct import (not via the barrel). The package's NodeNext module
// resolution wants explicit `.js` extensions on relative imports, and
// reaching for `commonUtils` through `../index.client` confused the
// `noEmit` typecheck with a missing-extension error. A direct sibling
// import stays typed and doesn't risk a future cycle.
import { tieAbortSignal } from "./common.js";

export type ContextLike = Context | AbortSignal;

/** Wrap a `Context` (returned as-is) or `AbortSignal` (adapted) as an SDK `Context`. */
export function toContext(input: ContextLike): Context;
/**
 * Derive an SDK `Context` from `controller.signal`, optionally tying
 * `input` into the controller so the controller becomes the single
 * cancellation source for downstream SDK calls:
 *
 *   - `AbortSignal`: aborting it propagates into `controller` (and from
 *     there into every SDK call you pass the returned context to).
 *   - `Context`: its `cancellationToken` is tied into `controller`, and
 *     its other fields (`logger`, `opName`, `rootClassName`,
 *     `rootFnName`, `opId`) are preserved in the returned `Context`.
 *     The returned context's `cancellationToken` is replaced with one
 *     backed by `controller.signal`.
 *
 * The tie is one-way (parent -> child): aborting `controller`
 * directly does NOT cancel `input`. So a request-level cancel (your
 * loop's `try/finally { controller.abort() }`) won't tear down a
 * caller-supplied AbortSignal it didn't own.
 */
export function toContext(controller: AbortController, input?: ContextLike): Context;
export function toContext(
  source: AbortController | ContextLike,
  input?: ContextLike,
): Context {
  if (!(source instanceof AbortController)) {
    if (source instanceof Context) return source;
    return new Context({ cancellationToken: signalToCancellationToken(source) });
  }
  if (input instanceof AbortSignal) {
    tieAbortSignal(source, input);
  } else if (input instanceof Context) {
    const token = input.cancellationToken;
    if (token) tieCancellationToken(source, token);
    const merged = input.copy();
    merged.setItems({ cancellationToken: signalToCancellationToken(source.signal) });
    return merged;
  }
  return new Context({ cancellationToken: signalToCancellationToken(source.signal) });
}

/**
 * Adapt a WHATWG `AbortSignal` to the Databricks SDK's
 * `CancellationToken` interface. The SDK's `api-client.ts`
 * internally creates an `AbortController` and wires
 * `cancellationToken.onCancellationRequested` to it, so this
 * adapter is the one-line bridge from "platform-standard
 * cancellation" to "the SDK aborts the fetch on your behalf".
 */
function signalToCancellationToken(signal: AbortSignal): CancellationToken {
  return {
    get isCancellationRequested() {
      return signal.aborted;
    },
    onCancellationRequested(cb) {
      if (signal.aborted) {
        cb(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => cb(signal.reason), { once: true });
    },
  };
}

/**
 * Tie the SDK's `CancellationToken` interface back into an
 * `AbortController`. Mirrors {@link tieAbortSignal} but for the
 * SDK's cancellation shape, used when a caller hands us a
 * pre-built `Context` whose token we want to fold into our own
 * controller.
 */
function tieCancellationToken(
  controller: AbortController,
  token: CancellationToken,
): void {
  if (token.isCancellationRequested) {
    controller.abort();
    return;
  }
  token.onCancellationRequested((reason) => controller.abort(reason));
}

/**
 * True when `err` is a Databricks SDK "resource does not exist" error
 * (a deleted/expired conversation, a missing statement id, etc.).
 * Checks the typed {@link ApiError} 404 / `RESOURCE_DOES_NOT_EXIST`
 * shape first, then the lower-level {@link HttpError} 404, then a loose
 * message sniff for SDK shapes that surface as neither typed error.
 *
 * `messagePattern` (default `/does not exist|not found/i`) bounds that
 * last fallback so callers can tighten it for a specific resource.
 */
export function isNotFoundError(
  err: unknown,
  messagePattern: RegExp = /does not exist|not found/i,
): boolean {
  if (err instanceof ApiError) {
    if (err.statusCode === 404) return true;
    if (err.errorCode === "RESOURCE_DOES_NOT_EXIST") return true;
  }
  if (err instanceof HttpError && err.code === 404) return true;
  if (err instanceof Error && messagePattern.test(err.message)) return true;
  return false;
}
