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

import { MASTRA_USER_KEY, type MastraPluginConfig, type User } from "./config.js";
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
      this.log.debug("auth:middleware", {
        method: req.method,
        path: req.path,
        threadId: requestContext.get(MASTRA_THREAD_ID_KEY),
        resourceId: requestContext.get(MASTRA_RESOURCE_ID_KEY),
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
