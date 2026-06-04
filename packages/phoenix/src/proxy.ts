/**
 * Express middleware that reverse-proxies the Phoenix daemon.
 *
 * Built on `http-proxy-middleware` instead of hand-rolled
 * `node:http` plumbing. The library handles the things we kept
 * getting bitten by:
 *
 * - Hop-by-hop header stripping (`Connection`, `Upgrade`,
 *   `Transfer-Encoding`, ...). Forwarding these verbatim to a
 *   fresh upstream socket caused `socket hang up` on otherwise
 *   healthy responses.
 * - WebSocket upgrade negotiation for Phoenix's GraphQL
 *   subscriptions (`ws: true`). Full WS upgrade routing also
 *   requires the host HTTP server's `upgrade` event to dispatch
 *   through this middleware; Express's router doesn't do that
 *   natively, so the flag here is a no-op until a host wires
 *   `middleware.upgrade` to `server.on("upgrade", ...)`. Plain
 *   HTTP polling (the default Phoenix UI path) works regardless.
 * - Replaying bodies that `express.json()` already pulled off the
 *   wire (via the `fixRequestBody` proxyReq hook). Without this,
 *   POSTs ship a stale `Content-Length` header against an empty
 *   stream and uvicorn tears the socket down before responding.
 * - Pipe lifecycle. We no longer race `req.close` against
 *   `res.end` and don't destroy half-read upstream sockets.
 *
 * Path handling:
 * - Phoenix is spawned with `PHOENIX_HOST_ROOT_PATH=/api/phoenix`
 *   (see `serve.ts`), matching the official traefik example:
 *   https://github.com/Arize-ai/phoenix/tree/main/examples/reverse-proxy
 *   The contract is: the reverse proxy STRIPS the prefix before
 *   forwarding; Phoenix PREPENDS the prefix when emitting outgoing
 *   URLs (HTML asset paths, GraphQL endpoint, etc.).
 * - Express already strips the plugin mount path off `req.url` by
 *   the time we run, so the request hits the upstream at the bare
 *   path Phoenix expects. `http-proxy-middleware` forwards `req.url`
 *   verbatim - no extra `pathRewrite` needed.
 */

import { createProxyMiddleware, fixRequestBody } from "http-proxy-middleware";
import type { Request, RequestHandler, Response } from "express";

/** Connection info needed to build the upstream URL. */
export interface ProxyTarget {
  host: string;
  port: number;
}

/**
 * Build an Express middleware that forwards every inbound request
 * to `target` and pipes the response back. Suitable as the only
 * handler under `router.use("/", proxyTo(...))`.
 */
export function proxyTo(target: ProxyTarget): RequestHandler {
  const middleware = createProxyMiddleware<Request, Response>({
    target: `http://${target.host}:${target.port}`,
    changeOrigin: true,
    ws: true,
    on: {
      // Replay bodies that `express.json()` (installed globally by
      // AppKit's ServerPlugin) already drained off the wire.
      // Without this, the upstream stalls waiting for bytes that
      // never arrive and the client sees `socket hang up`.
      proxyReq: fixRequestBody,
    },
  });
  // `createProxyMiddleware` returns `Promise<void>`, which Express's
  // `RequestHandler` (returning `void`) doesn't structurally match.
  // The library handles its own errors and never throws, so the
  // floating promise is safe to swallow here.
  return (req, res, next) => {
    void middleware(req, res, next);
  };
}
