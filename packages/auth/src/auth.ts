/**
 * Express middleware that authenticates requests with a Databricks
 * workspace OIDC JWT. A request is accepted only when its bearer token
 * is signed by the workspace JWKS and its `iss` claim points at the same
 * host as `DATABRICKS_HOST`.
 *
 * The workspace host fixes two things: the JWKS endpoint
 * (`https://<host>/oidc/jwks.json`) that supplies the signing keys, and
 * the issuer hostname every token is checked against. Signature keys are
 * fetched lazily and cached (with rotation) by jose's
 * `createRemoteJWKSet`, and the JWKS instance is memoized per host so the
 * cache is shared across requests.
 */

import { commonUtils, logUtils, netUtils } from "@dbx-tools/shared";
import type express from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/** Path of the workspace OIDC JWKS document, relative to the host. */
const JWKS_PATH = "/oidc/jwks.json";

export interface JwtAuthOptions {
  /**
   * Databricks workspace host the token must be issued by, e.g.
   * `https://my-workspace.cloud.databricks.com`. A bare hostname is
   * upgraded to `https://`. Defaults to `process.env.DATABRICKS_HOST`.
   */
  host?: string;
  /** Logger for rejected requests. Defaults to a tagged `"auth"` logger. */
  logger?: logUtils.Logger;
}

/**
 * Build the JWKS key resolver for a workspace's `/oidc/jwks.json`.
 * Memoized by URL so every middleware instance and request for the same
 * host shares one resolver (and therefore one rotating key cache).
 */
const jwksForUrl = commonUtils.memoize((jwksUrl: string) =>
  createRemoteJWKSet(new URL(jwksUrl)),
);

/** Extract the bearer token from an `Authorization` header, if present. */
function bearerToken(req: express.Request): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || undefined;
}

/**
 * Create the JWT-auth middleware. Resolves the workspace host once at
 * construction (throwing if `DATABRICKS_HOST` is unset / malformed) so
 * misconfiguration fails fast at wiring time rather than per request.
 *
 * On success the decoded {@link JWTPayload} is stashed on
 * `res.locals.jwt` for downstream handlers; otherwise the request is
 * answered with `401` and never reaches `next()`.
 *
 * @example
 * import express from "express";
 * import { databricksJwt } from "@dbx-tools/auth";
 *
 * const app = express();
 * app.use(databricksJwt());
 * app.get("/me", (_req, res) => res.json(res.locals.jwt));
 */
export function databricksJwt(options: JwtAuthOptions = {}): express.RequestHandler {
  const log = options.logger ?? logUtils.logger("auth");

  const host = options.host ?? process.env.DATABRICKS_HOST;
  const hostUrl = netUtils.urlBuilder(host);
  if (!hostUrl) {
    throw new Error(
      "databricksJwt: DATABRICKS_HOST is unset or not a valid URL; " +
        "pass `host` explicitly or set the env var.",
    );
  }
  // Every accepted token's issuer must resolve to this hostname, and the
  // signing keys come from this host's JWKS document.
  const expectedHostname = hostUrl.hostname;
  const jwksUrl = hostUrl.withPathReplace(JWKS_PATH).toString();

  return async (req, res, next) => {
    const token = bearerToken(req);
    if (!token) {
      res.status(401).json({ error: "missing bearer token" });
      return;
    }

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, await jwksForUrl(jwksUrl.toString())));
    } catch (err) {
      log.warn("rejected token: signature verification failed", {
        reason: commonUtils.errorMessage(err),
      });
      res.status(401).json({ error: "invalid token" });
      return;
    }

    // Beyond a valid signature, the issuer must be the configured
    // workspace: compare hostnames so issuer path/scheme variations
    // (`https://<host>/oidc`, `https://<host>`) all pass.
    const issuerUrl = netUtils.urlBuilder(payload.iss);
    if (!issuerUrl || issuerUrl.hostname !== expectedHostname) {
      log.warn("rejected token: issuer host mismatch", {
        iss: payload.iss,
        expected: expectedHostname,
      });
      res.status(401).json({ error: "invalid token issuer" });
      return;
    }

    res.locals.jwt = payload;
    next();
  };
}
