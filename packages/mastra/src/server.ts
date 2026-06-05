/**
 * Express-layer plumbing for the Mastra plugin: a `MastraServer` that
 * stamps the per-request `RequestContext`, and a route-patch middleware
 * that lets `@mastra/ai-sdk` `chatRoute` work behind an Express mount
 * point.
 */

import { getExecutionContext } from "@databricks/appkit";
import { httpUtils, logUtils, stringUtils } from "@dbx-tools/appkit-shared";
import {
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_THREAD_ID_KEY,
  type RequestContext,
} from "@mastra/core/request-context";
import { MastraServer as MastraServerExpress } from "@mastra/express";
import type express from "express";
import { randomUUID } from "node:crypto";

import {
  MASTRA_ENVIRONMENT_KEY,
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
 * `@mastra/express` subclass that stamps `RequestContext` with the
 * AppKit user, resource id, and a thread id backed by an HTTP-only
 * session cookie (`appkit_<plugin-name>_session_id`).
 */
export class MastraServer extends MastraServerExpress {
  private log: logUtils.Logger;

  constructor(
    private config: MastraPluginConfig,
    ...args: ConstructorParameters<typeof MastraServerExpress>
  ) {
    super(...args);
    this.log = logUtils.logger(config);
  }

  override registerAuthMiddleware(): void {
    super.registerAuthMiddleware();
    this.app.use((req, res, next) => {
      const requestContext = res.locals.requestContext! as RequestContext;
      this.configureRequestContextUser(requestContext);
      this.configureRequestContextThreadId(req, res, requestContext);
      this.configureRequestContextModelOverride(req, requestContext);
      this.configureRequestContextEnvironment(requestContext);
      this.configureRequestContextRequestId(req, res, requestContext);
      this.log.debug("auth:middleware", {
        method: req.method,
        path: req.path,
        requestId: requestContext.get(MASTRA_REQUEST_ID_KEY),
        threadId: requestContext.get(MASTRA_THREAD_ID_KEY),
        resourceId: requestContext.get(MASTRA_RESOURCE_ID_KEY),
        userName: requestContext.get(MASTRA_USER_NAME_KEY),
        userEmail: requestContext.get(MASTRA_USER_EMAIL_KEY),
        environment: requestContext.get(MASTRA_ENVIRONMENT_KEY),
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
   * Stamp the deployment environment label so traces are filterable
   * by env in the observability platform. Reads `MASTRA_ENVIRONMENT`
   * first (explicit override), then `NODE_ENV` as the conventional
   * fallback; leaves the key unset when both are absent rather than
   * guessing.
   */
  configureRequestContextEnvironment(requestContext: RequestContext) {
    if (requestContext.get(MASTRA_ENVIRONMENT_KEY)) return;
    const environment = process.env.MASTRA_ENVIRONMENT ?? process.env.NODE_ENV;
    if (environment) requestContext.set(MASTRA_ENVIRONMENT_KEY, environment);
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

  configureRequestContextThreadId(
    req: express.Request,
    res: express.Response,
    requestContext: RequestContext,
  ) {
    if (requestContext.get(MASTRA_THREAD_ID_KEY)) return;
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

/**
 * Patches around `@mastra/express`'s custom-route dispatcher so
 * `chatRoute` works when `MastraServer` is hosted on an Express subapp
 * mounted under a parent path (e.g. `/api/mastra`).
 *
 * Two concerns:
 *
 * 1. The adapter's `registerCustomApiRoutes` matches against `req.path`
 *    (mount-relative, correct) but dispatches to its internal Hono
 *    mini-app using `req.originalUrl`, which still contains the parent
 *    mount prefix. The Hono app registers the literal `chatRoute` paths
 *    (for example `/route/chat`), so the absolute URL never matches
 *    until we overwrite `originalUrl` for `/route` and `/route/*` to
 *    the mount-relative path.
 *
 * 2. `memory.resource` must be the authenticated user, not whatever the
 *    client posts. The custom-route forwarder re-serializes `req.body`
 *    into the Request body it hands Hono, so mutating the parsed body
 *    here would propagate into `handleChatStream`'s params (kept for
 *    future use; `express.json()` runs first so `req.body` is parsed).
 */
export function attachRoutePatchMiddleware(app: express.Express): void {
  app.use((req, _res, next) => {
    const isChat = req.path === "/route" || req.path.startsWith("/route/");
    if (!isChat) return next();
    req.originalUrl = req.path;
    next();
  });
}
