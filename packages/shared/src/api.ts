/**
 * Databricks SDK glue for the server surface: adapting WHATWG
 * cancellation (`AbortSignal` / `AbortController`) into the SDK's
 * `Context` / `CancellationToken` shapes, classifying "resource does
 * not exist" errors, and resolving the current workspace's URL and
 * numeric id from the active execution context, a default client, or
 * the environment.
 *
 * Server-only: leans on the Databricks SDK `WorkspaceClient` and the
 * AppKit execution context.
 */

import type { CancellationToken, Config } from "@databricks/sdk-experimental";
import { Context, WorkspaceClient } from "@databricks/sdk-experimental";

// Direct import (not via the barrel). The package's NodeNext module
// resolution wants explicit `.js` extensions on relative imports, and
// reaching for `commonUtils` through `../index.client` confused the
// `noEmit` typecheck with a missing-extension error. A direct sibling
// import stays typed and doesn't risk a future cycle.
import { tryGetExecutionContext } from "./appkit.js";
import { memoize, tieAbortSignal, errorMessages, errorNodes } from "./common.js";
import { urlBuilder, type UrlBuilder } from "./net.browser.js";
import { tokenizeWithOptions } from "./string.js";

/** Databricks workspace ids are a 10-20 digit run embedded in the host. */
const WORKSPACE_ID_REGEX = /\d{10,20}/;

/** Either an SDK `Context` or a WHATWG `AbortSignal`. */
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
 * Lazy view over a thrown value for error classification via
 * {@link errorContext}. HTTP status is taken from the last positive
 * `statusCode` / `code` on the error tree; messages and tokens come
 * from every `message` / `errorCode` field (including `cause` and
 * `AggregateError.errors`).
 */
export type ErrorContext = ErrorContextImpl;

class ErrorContextImpl {
  private _statusCode: number | undefined;
  private _messages: string[] | undefined;
  private _messageTokens: string[] | undefined;

  constructor(private readonly err: NonNullable<unknown>) {}

  /**
   * Last positive `statusCode` / `code` found while walking the error
   * tree, else `undefined`. Status `0` is ignored.
   */
  get statusCode(): number | undefined {
    if (this._statusCode === undefined) {
      outer: for (const node of errorNodes(this.err)) {
        if (typeof node !== "object" || node === null) continue;
        for (const key of ["statusCode", "code"] as const) {
          if (!(key in node)) continue;
          const value = (node as Record<string, unknown>)[key];
          if (typeof value === "number" && value > 99 && value < 600) {
            this._statusCode = value;
            break outer;
          }
        }
      }
      if (this._statusCode === undefined) {
        this._statusCode = -1;
      }
    }
    return this._statusCode == -1 ? undefined : this._statusCode;
  }

  /** Every `message` / `errorCode` string in the error tree. */
  get messages(): string[] {
    if (this._messages === undefined) {
      this._messages = [...errorMessages(this.err)];
    }
    return this._messages;
  }

  /** Lowercased tokens from {@link messages}. */
  get messageTokens(): string[] {
    if (this._messageTokens === undefined) {
      this._messageTokens = [
        ...tokenizeWithOptions({ lowerCase: true }, ...this.messages),
      ];
    }
    return this._messageTokens;
  }

  /** True for any 4xx status or message tokens `not exist` / `not found`. */
  get notAccessible(): boolean {
    if (this.hasStatusCode(4)) return true;
    return this.hasMessage("not", "exist") || this.hasMessage("not", "found");
  }

  /**
   * Match HTTP status. Pass a full code (`404`) or a class (`4` for any
   * 4xx). Additional filters are OR'd: returns `true` when any filter
   * matches. Returns `false` when no status is on the error tree.
   */
  hasStatusCode(statusCodeFilter: number, ...statusCodeFilters: number[]): boolean {
    const code = this.statusCode;
    if (code) {
      for (const filter of [statusCodeFilter, ...statusCodeFilters]) {
        const match = (filter < 100 ? Math.trunc(code / 100) : code) === filter;
        if (match) return true;
      }
    }
    return false;
  }

  /**
   * True when every token from the filter phrase(s) appears in
   * {@link messageTokens}. Each argument is tokenized on non-alphanumeric
   * boundaries; all resulting tokens must match (e.g.
   * `hasMessage("not", "found")` or `hasMessage("not found")`).
   */
  hasMessage(messageFilter: string, ...messageFilters: string[]): boolean {
    return [messageFilter, ...messageFilters]
      .flatMap((filter) => Array.from(tokenizeWithOptions({ lowerCase: true }, filter)))
      .every((filterToken) => this.messageTokens.includes(filterToken));
  }
}

/** Build an {@link ErrorContext} for status and message checks. `null` / `undefined` become `{}`. */
export function errorContext(err: unknown): ErrorContext {
  return new ErrorContextImpl(err ?? {});
}

/**
 * Resolve the current workspace host as a {@link UrlBuilder}: the
 * workspace `Config` host first, then the `DATABRICKS_HOST` env var,
 * else `undefined`.
 */
export async function getWorkspaceUrl(): Promise<UrlBuilder | undefined> {
  const config = await getWorkspaceConfig();
  if (config) {
    const configHost = urlBuilder(await config.getHost());
    if (configHost) {
      return configHost;
    }
  }
  const databricksHost = urlBuilder(process.env.DATABRICKS_HOST);
  if (databricksHost) {
    return databricksHost;
  }
  return undefined;
}

/**
 * Resolve the numeric workspace id: the workspace `Config`'s
 * `workspaceId` first, else the 10-20 digit run of `workspaceHost`
 * (defaulting to {@link getWorkspaceUrl}'s host). `undefined` when
 * neither yields an id.
 */
export async function getWorkspaceId(
  workspaceHost?: string,
): Promise<string | undefined> {
  const workspaceId = (await getWorkspaceConfig())?.workspaceId;
  if (workspaceId) {
    return workspaceId;
  }
  workspaceHost = workspaceHost ?? (await getWorkspaceUrl())?.host;
  if (workspaceHost) {
    const workspaceId = workspaceHost.match(WORKSPACE_ID_REGEX)?.[0];
    if (workspaceId) {
      return workspaceId;
    }
  }
  return undefined;
}

// ────────────────────────────────────────────────────────────────
// Private helpers
// ────────────────────────────────────────────────────────────────

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
 * Lazily-constructed default `WorkspaceClient` (env / profile auth),
 * memoized so the construction happens at most once per process. Used
 * only when there's no AppKit execution context to borrow a client
 * from.
 */
const getDefaultWorkspaceClient = memoize(async () => new WorkspaceClient({}));

/**
 * The active workspace `Config`: the execution-context client's config
 * when AppKit is initialized, else the default client's. Returns
 * `undefined` (never throws) when neither is available.
 */
async function getWorkspaceConfig(): Promise<Config | undefined> {
  let client = tryGetExecutionContext()?.client;
  if (!client) {
    try {
      client = await getDefaultWorkspaceClient();
    } catch {
      // no client available; fall back to the environment
    }
  }
  return client?.config;
}
