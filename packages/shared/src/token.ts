/**
 * JWT access-token helpers for Databricks Apps.
 *
 * Parses bearer tokens and `x-forwarded-access-token` payloads to read
 * OAuth scopes and other claims from incoming HTTP requests.
 */

import { forEachHeaderValue, type HeaderLike } from "./http.js";

const BEARER_PREFIX_REGEX = /^bearer\s+/i;
const SPLIT_REGEX = /\s+|\s*,\s*/;

/** Decode a JWT segment (base64url with standard base64 padding). */
function decodeJwtSegment(segment: string): string {
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf-8");
}

/**
 * Decode the JWT payload from a bearer token string or request headers.
 *
 * When `input` is header-like, walks every value for `headerName` (default
 * `x-forwarded-access-token`) and merges claim keys left-to-right.
 */
export function getAccessTokenPayload(
  input: HeaderLike | string,
  headerName: string | undefined = "x-forwarded-access-token",
): Record<string, unknown> {
  let accessTokenPayload: Record<string, unknown> | undefined;
  if (!(typeof input === "string")) {
    if (headerName) {
      forEachHeaderValue(input, headerName, (value: string) => {
        for (const [payloadKey, payloadValue] of Object.entries(
          getAccessTokenPayload(value),
        )) {
          if (!accessTokenPayload || !(payloadKey in accessTokenPayload)) {
            if (!accessTokenPayload) accessTokenPayload = {};
            accessTokenPayload[payloadKey] = payloadValue;
          }
        }
      });
    }
  } else {
    input = input.trim();
    if (input) {
      const match = BEARER_PREFIX_REGEX.exec(input);
      if (match) {
        const endIndex = match.index + match[0].length;
        input = input.slice(endIndex);
      }
      const parts = input.split(".", 4);
      if (parts.length === 2 || parts.length === 3) {
        try {
          const payload = JSON.parse(decodeJwtSegment(parts[1]!));
          if (typeof payload === "object" && payload !== null) {
            accessTokenPayload = payload as Record<string, unknown>;
          }
        } catch {
          // Malformed JWT payload; fall through to empty object.
        }
      }
    }
  }
  if (!accessTokenPayload) accessTokenPayload = {};
  return accessTokenPayload;
}

/**
 * OAuth scopes from the access-token JWT on `input`.
 *
 * Defaults to the `x-forwarded-access-token` header, which Databricks Apps
 * forward from the browser session.
 */
export function getAccessTokenScopes(
  input: HeaderLike | string,
  headerName?: string,
): Iterable<string> {
  const payload = getAccessTokenPayload(input, headerName);
  return splitAccessTokenClaim(payload.scope);
}

/**
 * Return true when `scopes` contains any value from `allowed`.
 *
 * Accepts the raw {@link MASTRA_SCOPES_KEY} array stamped on
 * `RequestContext` as well as iterables from {@link getAccessTokenScopes}.
 */
export function includesAccessTokenScope(
  scopes: unknown,
  allowed: readonly string[],
): boolean {
  if (!Array.isArray(scopes)) return false;
  return scopes.some((scope) =>
    allowed.includes(typeof scope === "string" ? scope : String(scope)),
  );
}

/** Split a JWT `scope` claim string or array into individual scope tokens. */
function* splitAccessTokenClaim(input: unknown): Iterable<string> {
  if (typeof input === "string") {
    for (const claim of input.split(SPLIT_REGEX)) {
      const value = claim.trim();
      if (value) {
        yield value;
      }
    }
  } else if (Array.isArray(input)) {
    for (const value of input) {
      yield* splitAccessTokenClaim(value);
    }
  }
}
