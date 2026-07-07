import { describe, expect, test } from "bun:test";

import {
  getAccessTokenPayload,
  getAccessTokenScopes,
  includesAccessTokenScope,
} from "../src/token.js";

function jwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("tokenUtils", () => {
  test("decodes base64url JWT payloads", () => {
    const token = jwt({ scope: "workspace all-apis", sub: "alice" });
    expect(getAccessTokenPayload(token)).toEqual({
      scope: "workspace all-apis",
      sub: "alice",
    });
  });

  test("splits scope strings and arrays", () => {
    const token = jwt({ scope: "workspace,all-apis" });
    expect([...getAccessTokenScopes(token)]).toEqual(["workspace", "all-apis"]);

    const arrayToken = jwt({ scope: ["workspace", "sql"] });
    expect([...getAccessTokenScopes(arrayToken)]).toEqual(["workspace", "sql"]);
  });

  test("includesAccessTokenScope matches stamped request scopes", () => {
    expect(
      includesAccessTokenScope(["workspace"], ["workspace", "all-apis"]),
    ).toBe(true);
    expect(includesAccessTokenScope(["sql"], ["workspace", "all-apis"])).toBe(
      false,
    );
    expect(includesAccessTokenScope(undefined, ["workspace"])).toBe(false);
  });

  test("reads bearer Authorization headers", () => {
    const token = jwt({ scope: "all-apis" });
    const scopes = [
      ...getAccessTokenScopes({ authorization: `Bearer ${token}` }, "authorization"),
    ];
    expect(scopes).toEqual(["all-apis"]);
  });
});
