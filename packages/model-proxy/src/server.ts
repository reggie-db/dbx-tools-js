/**
 * OpenAI-compatible HTTP proxy in front of Databricks Model Serving.
 *
 * Databricks serving endpoints already speak the OpenAI wire format, so
 * this server is a thin pass-through: it resolves the request's (possibly
 * fuzzy) `model` to a real endpoint id via the {@link DatabricksBackend},
 * stamps a fresh auth header, and forwards the body to that endpoint's
 * `invocations` URL, streaming the response straight back to the client.
 * Any OpenAI-compatible tool (iTerm, editors, the `openai` SDK) can point
 * its base URL at this server and use loose model names.
 *
 * Routes:
 *   - `GET  /health`, `GET /`            liveness
 *   - `GET  /v1/models`, `GET /models`   list resolvable endpoints
 *   - `POST /v1/chat/completions`        proxy (also `/completions`,
 *     `/v1/completions`, `/v1/embeddings`, and the un-prefixed variants)
 */

import { commonUtils, logUtils } from "@dbx-tools/shared";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import type { DatabricksBackend } from "./backend.js";
import { DEFAULT_BIND_HOST, DEFAULT_PORT } from "./defaults.js";

const log = logUtils.logger("model-proxy/server");

/** POST routes forwarded verbatim to a serving endpoint's invocations URL. */
const PROXY_PATHS = new Set([
  "/v1/chat/completions",
  "/chat/completions",
  "/v1/completions",
  "/completions",
  "/v1/embeddings",
  "/embeddings",
]);

/** GET routes that list the resolvable model catalogue. */
const MODELS_PATHS = new Set(["/v1/models", "/models"]);

/** Options shared by {@link createProxyServer} and {@link startProxyServer}. */
export interface ProxyServerOptions {
  /**
   * When set, local clients must present this value as a bearer token
   * (`Authorization: Bearer <key>`). Unset leaves the proxy open, which is
   * fine for a loopback bind but should be paired with a key on a wider one.
   */
  apiKey?: string;
}

/** Options for {@link startProxyServer}, adding the listen address. */
export interface StartProxyOptions extends ProxyServerOptions {
  host?: string;
  port?: number;
}

/** Build (but do not start) the proxy HTTP server. */
export function createProxyServer(
  backend: DatabricksBackend,
  options: ProxyServerOptions = {},
): Server {
  return createServer((req, res) => {
    void handleRequest(backend, options, req, res);
  });
}

/**
 * Build and start the proxy, resolving once it is accepting connections.
 * Returns the server and its base URL (with the actually-bound port, so a
 * `port: 0` request surfaces the OS-assigned port).
 */
export async function startProxyServer(
  backend: DatabricksBackend,
  options: StartProxyOptions = {},
): Promise<{ server: Server; url: string }> {
  const host = options.host ?? DEFAULT_BIND_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const server = createProxyServer(backend, options);
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  return { server, url: `http://${host}:${boundPort}` };
}

async function handleRequest(
  backend: DatabricksBackend,
  options: ProxyServerOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  try {
    if (req.method === "GET" && (path === "/health" || path === "/")) {
      sendJson(res, 200, { status: "ok" });
      return;
    }
    if (options.apiKey && !isAuthorized(req, options.apiKey)) {
      sendJson(res, 401, errorBody("invalid api key", "invalid_request_error"));
      return;
    }
    if (req.method === "GET" && MODELS_PATHS.has(path)) {
      await handleModels(backend, res);
      return;
    }
    if (req.method === "POST" && PROXY_PATHS.has(path)) {
      await handleProxy(backend, req, res);
      return;
    }
    sendJson(
      res,
      404,
      errorBody(`unsupported route ${req.method ?? "?"} ${path}`, "invalid_request_error"),
    );
  } catch (err) {
    const message = commonUtils.errorMessage(err);
    log.error("request failed", { path, error: message });
    if (!res.headersSent) sendJson(res, 500, errorBody(message, "proxy_error"));
    else res.end();
  }
}

/** `GET /v1/models`: surface the serving catalogue as OpenAI model objects. */
async function handleModels(
  backend: DatabricksBackend,
  res: ServerResponse,
): Promise<void> {
  const endpoints = await backend.models(true);
  const data = endpoints.map((endpoint) => ({
    id: endpoint.name,
    object: "model",
    created: 0,
    owned_by: "databricks",
  }));
  sendJson(res, 200, { object: "list", data });
}

/**
 * Resolve the request's model to a real endpoint, then forward the body to
 * that endpoint's invocations URL with fresh auth, streaming the upstream
 * response (SSE or JSON) straight back to the client.
 */
async function handleProxy(
  backend: DatabricksBackend,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as Record<string, unknown>;
  const requested = typeof body.model === "string" ? body.model : undefined;
  if (!requested) {
    sendJson(res, 400, errorBody("missing 'model' in request body", "invalid_request_error"));
    return;
  }

  const resolved = await backend.resolve(requested);
  // Address the endpoint by URL; rewrite the body's `model` to the real id
  // so pay-per-token endpoints that echo it still see a valid value.
  body.model = resolved.modelId;

  const wantsStream = body.stream === true;
  const headers = await backend.authHeaders();
  headers["content-type"] = "application/json";
  headers.accept = wantsStream ? "text/event-stream" : "application/json";

  log.info("proxy", {
    requested,
    resolved: resolved.modelId,
    matched: resolved.matched,
    stream: wantsStream,
  });

  const upstream = await fetch(backend.invocationsUrl(resolved.modelId), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    "x-resolved-model": resolved.modelId,
  });
  await streamBody(upstream, res);
}

/** Pump an upstream `fetch` Response body to the Node response, chunk by chunk. */
async function streamBody(upstream: Response, res: ServerResponse): Promise<void> {
  const body = upstream.body;
  if (!body) {
    res.end();
    return;
  }
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && !res.writableEnded) res.write(Buffer.from(value));
      if (res.writableEnded) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    res.end();
  }
}

/** True when the request carries the expected bearer token. */
function isAuthorized(req: IncomingMessage, apiKey: string): boolean {
  const header = req.headers.authorization;
  if (!header) return false;
  return header.replace(/^Bearer\s+/i, "").trim() === apiKey;
}

/** Drain a request body and parse it as JSON (empty body parses to `{}`). */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

/** Serialize and send a JSON response. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** OpenAI-shaped error envelope. */
function errorBody(message: string, type: string): { error: { message: string; type: string } } {
  return { error: { message, type } };
}
