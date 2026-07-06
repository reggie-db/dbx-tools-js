/**
 * Express-layer plumbing for the Mastra plugin: a `MastraServer` that
 * stamps the per-request `RequestContext`, and a route-patch middleware
 * that lets the plugin's custom API routes (e.g. `historyRoute`) work
 * behind an Express mount point.
 */

import { getExecutionContext } from "@databricks/appkit";
import {
  MLFLOW_TRACE_ID_HEADER,
  THREAD_ID_HEADER,
  THREAD_ID_QUERY,
} from "@dbx-tools/appkit-mastra-shared";
import { httpUtils, logUtils, stringUtils } from "@dbx-tools/shared";
import {
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_THREAD_ID_KEY,
  type RequestContext,
} from "@mastra/core/request-context";
import { MastraServer as MastraServerExpress } from "@mastra/express";
import { trace } from "@opentelemetry/api";
import type express from "express";
import { randomUUID } from "node:crypto";

import { resolveFeedbackEnabled } from "./mlflow.js";

import {
  MASTRA_REQUEST_ID_KEY,
  MASTRA_USER_EMAIL_KEY,
  MASTRA_USER_KEY,
  MASTRA_USER_NAME_KEY,
  type MastraPluginConfig,
  type User,
} from "./config.js";
import {
  extractModelOverride,
  MASTRA_MODEL_OVERRIDE_KEY,
  resolveServingConfig,
} from "./serving.js";

/**
 * OpenTelemetry's sentinel for "no valid trace" - 32 zero hex chars.
 * `trace.getActiveSpan()` returns a non-recording span with this id
 * when no SDK is registered, which must never be surfaced as a trace to
 * attach feedback to.
 */
const INVALID_TRACE_ID = "0".repeat(32);

/**
 * `@mastra/express` subclass that stamps `RequestContext` with the
 * AppKit user, resource id, and a thread id backed by an HTTP-only
 * session cookie (`appkit_<plugin-name>_session_id`).
 */
export class MastraServer extends MastraServerExpress {
  private log: logUtils.Logger;
  /**
   * Whether to stamp the MLflow trace-id header on responses. Shares the
   * plugin's feedback gate via {@link resolveFeedbackEnabled}.
   */
  private feedbackEnabled: boolean;

  constructor(
    private config: MastraPluginConfig,
    ...args: ConstructorParameters<typeof MastraServerExpress>
  ) {
    super(...args);
    this.log = logUtils.logger(config);
    this.feedbackEnabled = resolveFeedbackEnabled(config.feedback);
  }

  override registerAuthMiddleware(): void {
    super.registerAuthMiddleware();
    this.app.use((req, res, next) => {
      const requestContext = res.locals.requestContext! as RequestContext;
      this.configureRequestContextUser(requestContext);
      this.configureRequestContextThreadId(req, res, requestContext);
      this.configureRequestContextModelOverride(req, requestContext);
      this.configureRequestContextRequestId(req, res, requestContext);
      this.configureMlflowTraceId(res);
      this.log.debug("auth:middleware", {
        method: req.method,
        path: req.path,
        requestId: requestContext.get(MASTRA_REQUEST_ID_KEY),
        threadId: requestContext.get(MASTRA_THREAD_ID_KEY),
        resourceId: requestContext.get(MASTRA_RESOURCE_ID_KEY),
        userName: requestContext.get(MASTRA_USER_NAME_KEY),
        userEmail: requestContext.get(MASTRA_USER_EMAIL_KEY),
        modelOverride: requestContext.get(
          // imported below; logged so a misrouted request shows
          // up alongside its model selection in `LOG_LEVEL=debug`.
          "mastra__model_override",
        ),
      });
      next();
    });
  }

  configureRequestContextUser(requestContext: RequestContext) {
    if (
      [MASTRA_USER_KEY, MASTRA_RESOURCE_ID_KEY].every((key) => requestContext.get(key))
    )
      return;
    const executionContext = getExecutionContext();
    const user: User = {
      id:
        "userId" in executionContext
          ? executionContext.userId
          : executionContext.serviceUserId,
      executionContext,
    };
    requestContext.set(MASTRA_USER_KEY, user);
    requestContext.set(MASTRA_RESOURCE_ID_KEY, user.id);
    // AppKit's `UserContext` surfaces display name / email only on
    // OBO requests. Service-context calls (background tasks, server
    // start-up) leave these undefined and we skip the stamp so
    // downstream trace metadata stays absent rather than empty.
    if ("isUserContext" in executionContext) {
      if (executionContext.userName) {
        requestContext.set(MASTRA_USER_NAME_KEY, executionContext.userName);
      }
      if (executionContext.userEmail) {
        requestContext.set(MASTRA_USER_EMAIL_KEY, executionContext.userEmail);
      }
    }
  }

  /**
   * Stamp a per-request id and echo it on the response so an upstream
   * proxy / curl client / browser-side log line can pair its view of
   * the request with the matching trace span. Reuses `X-Request-Id`
   * when the upstream already supplies one so multi-hop traces stay
   * joined; otherwise mints a UUIDv4.
   *
   * The id is surfaced as `mastra__requestId` span metadata via
   * {@link TRACE_REQUEST_CONTEXT_KEYS} and as the `X-Request-Id`
   * response header so dev tools can copy it from either side.
   */
  configureRequestContextRequestId(
    req: express.Request,
    res: express.Response,
    requestContext: RequestContext,
  ) {
    if (requestContext.get(MASTRA_REQUEST_ID_KEY)) return;
    const headerValue = req.headers["x-request-id"];
    const upstream = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    const requestId = upstream?.trim() || randomUUID();
    requestContext.set(MASTRA_REQUEST_ID_KEY, requestId);
    res.setHeader("X-Request-Id", requestId);
  }

  /**
   * Stamp the turn's MLflow trace id on the response so the chat client
   * can attach thumbs / comment feedback to it later. MLflow derives
   * its trace id from the OpenTelemetry trace id (`tr-<hex>`), and every
   * Mastra span for this request inherits the ambient OTel context (see
   * `observability.ts`), so the active span's trace id here is the id
   * MLflow will record for the turn.
   *
   * No-op unless feedback is enabled, and when no live OTel span is
   * active (e.g. the OTLP SDK isn't registered): in that case the header
   * is simply absent and the client hides feedback for that message,
   * degrading gracefully rather than emitting a bogus trace id.
   */
  configureMlflowTraceId(res: express.Response) {
    if (!this.feedbackEnabled || res.headersSent) return;
    const traceId = trace.getActiveSpan()?.spanContext().traceId;
    if (!traceId || traceId === INVALID_TRACE_ID) return;
    res.setHeader(MLFLOW_TRACE_ID_HEADER, `tr-${traceId}`);
  }

  /**
   * Resolve the thread id this request targets and pin it on
   * `RequestContext` (consumed by the agent stream for persistence and
   * by the history / threads routes). Resolution order:
   *
   *   1. A client-supplied thread id (the thread-selection header /
   *      `?threadId=` query). This is how the chat UI references a
   *      specific conversation among the many a user owns - it picks a
   *      thread id from the `/threads` listing (or mints one for a new
   *      conversation) and stamps it here. The id is scoped to the
   *      caller's resource by the recall / list routes, so a client
   *      can only ever read or write its own threads.
   *   2. The per-session cookie (`appkit_<plugin-name>_session_id`),
   *      minted on first contact. This is the default single-thread
   *      fallback for clients that don't manage threads explicitly, so
   *      existing embeds keep one stable conversation per session with
   *      no client changes.
   */
  configureRequestContextThreadId(
    req: express.Request,
    res: express.Response,
    requestContext: RequestContext,
  ) {
    if (requestContext.get(MASTRA_THREAD_ID_KEY)) return;
    const requested = this.readRequestedThreadId(req);
    if (requested) {
      requestContext.set(MASTRA_THREAD_ID_KEY, requested);
      return;
    }
    const cookies = httpUtils.parseCookies(req.headers.cookie);
    const cookieName = stringUtils.toIdentifierWithOptions(
      { delimiter: "_", distinct: true },
      "appkit",
      this.config.name!,
      "sessionId",
    );
    let sessionId = cookies[cookieName];
    if (!sessionId) {
      sessionId = randomUUID();
      res.cookie(cookieName, sessionId, {
        httpOnly: true,
        sameSite: "lax",
        secure: req.secure,
        path: "/",
      });
    }
    requestContext.set(MASTRA_THREAD_ID_KEY, sessionId);
  }

  /**
   * Read the client-selected thread id from the request, preferring
   * the thread-selection header over the `?threadId=` query. Returns
   * `null` when neither carries a non-empty value so the caller falls
   * back to the session cookie.
   */
  private readRequestedThreadId(req: express.Request): string | null {
    const headerValue = req.headers[THREAD_ID_HEADER];
    const queryValue = req.query[THREAD_ID_QUERY];
    return (
      stringUtils.trimToNull(
        Array.isArray(headerValue) ? headerValue[0] : headerValue,
      ) ??
      stringUtils.trimToNull(Array.isArray(queryValue) ? queryValue[0] : queryValue)
    );
  }

  configureRequestContextModelOverride(
    req: express.Request,
    requestContext: RequestContext,
  ) {
    // Per-request model override: only honored when the plugin
    // opts in (default). Sources, in priority order, are
    // `X-Mastra-Model` header, `?model=` query, and `model` /
    // `modelId` body field; see `serving.ts`.
    const serving = resolveServingConfig(this.config);
    if (serving.allowOverride) {
      const override = extractModelOverride({
        headers: req.headers as Record<string, string | string[] | undefined>,
        query: req.query as Record<string, unknown>,
        body: req.body,
      });
      if (override) requestContext.set(MASTRA_MODEL_OVERRIDE_KEY, override);
    }
  }
}

/** Inputs for {@link isMastraRequestAllowed}. */
export interface MastraApiGateOptions {
  /** `config.apiAccess`; `"full"` short-circuits to allow everything. */
  access: "scoped" | "full";
  /** Whether the MCP transport is mounted (so `/mcp/*` is legitimate). */
  mcpEnabled: boolean;
}

/**
 * Mount-relative agent inference paths (`/agents/:id/<verb>...`). Matched
 * by prefix on the verb so future variants (`streamVNext`, `stream/vnext`,
 * `generateVNext`) stay covered without a code change.
 *
 * Covers the plain inference verbs (`stream` / `generate` / `network`) plus
 * the human-in-the-loop resume verbs a paused `requireApproval` tool needs
 * to continue: `approve-tool-call` / `decline-tool-call` (streaming, and via
 * prefix their `-generate` non-streaming variants), the `-network-` variants,
 * and `resume-stream` (covers `resume-stream-until-idle`). Without these an
 * approval-gated tool (e.g. `send_email`) can be requested but never approved
 * from the browser - the resume `POST` 403s under scoped mode. These are the
 * only *writes* the browser client is allowed to make against stock Mastra.
 */
const AGENT_INFERENCE =
  /^\/agents\/[^/]+\/(stream|generate|network|resume-stream|approve-tool-call|decline-tool-call|approve-network-tool-call|decline-network-tool-call)/i;

/** Mount-relative read-only agent metadata (`/agents`, `/agents/:id`). */
const AGENT_METADATA = /^\/agents(\/[^/]+)?$/;

/**
 * Whether a request to the stock `@mastra/express` sub-app should be
 * dispatched, given the configured {@link MastraApiGateOptions.access}.
 *
 * `path` is mount-relative (what the plugin's catch-all sees, e.g.
 * `/agents/x/stream`, `/route/history/x`, `/mcp/...`). In `"scoped"`
 * mode the allowlist is deliberately tight - the chat client only ever
 * needs agent inference, read-only agent metadata, this plugin's own
 * OBO/resource-scoped `/route/*` routes, and (when enabled) MCP - so the
 * whole admin / mutating / bulk-export surface Mastra also exposes is
 * denied by default rather than enumerated.
 */
export function isMastraRequestAllowed(
  method: string,
  path: string,
  opts: MastraApiGateOptions,
): boolean {
  if (opts.access === "full") return true;
  const p = path.startsWith("/") ? path : `/${path}`;
  // This plugin's own custom routes are individually OBO- and
  // resource-scoped (see history.ts / threads.ts), so every method is safe.
  if (p === "/route" || p.startsWith("/route/")) return true;
  if (opts.mcpEnabled && (p === "/mcp" || p.startsWith("/mcp/"))) return true;
  const m = method.toUpperCase();
  if (m === "POST" && AGENT_INFERENCE.test(p)) return true;
  if (m === "GET" && AGENT_METADATA.test(p)) return true;
  return false;
}

/**
 * Patches around `@mastra/express`'s custom-route dispatcher so the
 * plugin's custom API routes (e.g. `historyRoute`) work when
 * `MastraServer` is hosted on an Express subapp mounted under a parent
 * path (e.g. `/api/mastra`).
 *
 * The adapter's `registerCustomApiRoutes` matches against `req.path`
 * (mount-relative, correct) but dispatches to its internal Hono
 * mini-app using `req.originalUrl`, which still contains the parent
 * mount prefix. The Hono app registers the literal route paths
 * (for example `/route/history`), so the absolute URL never matches
 * until we overwrite `originalUrl` for `/route` and `/route/*` to the
 * mount-relative path.
 */
export function attachRoutePatchMiddleware(app: express.Express): void {
  app.use((req, _res, next) => {
    const isCustomRoute = req.path === "/route" || req.path.startsWith("/route/");
    if (!isCustomRoute) return next();
    req.originalUrl = req.path;
    next();
  });
}
