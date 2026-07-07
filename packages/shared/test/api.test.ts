import { describe, expect, it } from "bun:test";
import { ApiError, HttpError } from "@databricks/sdk-experimental";

import { errorContext } from "../src/api.js";

/** Minimal {@link ApiError} for tests (SDK constructor requires five args). */
function apiError(message: string, errorCode: string, statusCode: number): ApiError {
  return new ApiError(message, errorCode, statusCode, undefined, []);
}

describe("errorContext", () => {
  it("coerces nullish input to an empty object", () => {
    const ctx = errorContext(undefined);
    expect(ctx.statusCode).toBeUndefined();
    expect(ctx.messages).toEqual([]);
    expect(ctx.notAccessible).toBe(false);
  });

  it("reads exact HTTP status codes", () => {
    const ctx = errorContext(apiError("not found", "NOT_FOUND", 404));
    expect(ctx.hasStatusCode(404)).toBe(true);
    expect(ctx.hasStatusCode(500)).toBe(false);
  });

  it("matches HttpError status codes", () => {
    const ctx = errorContext(new HttpError("missing", 404));
    expect(ctx.hasStatusCode(404)).toBe(true);
  });

  it("matches message tokens via hasMessage", () => {
    const ctx = errorContext(new Error("The conversation does not exist"));
    expect(ctx.hasMessage("does", "not", "exist")).toBe(true);
    expect(ctx.hasMessage("does not exist")).toBe(true);
    expect(ctx.hasMessage("missing")).toBe(false);
  });

  it("matches tokenized phrase strings", () => {
    const ctx = errorContext(new Error("resource not found"));
    expect(ctx.hasMessage("not", "found")).toBe(true);
    expect(ctx.hasMessage("not found")).toBe(true);
  });

  it("uses the first HTTP status found on the error tree", () => {
    const cause = Object.assign(new Error("not found"), { statusCode: 404 });
    const err = Object.assign(new Error("wrapper"), { statusCode: 500, cause });
    const ctx = errorContext(err);
    expect(ctx.statusCode).toBe(500);
    expect(ctx.hasStatusCode(500)).toBe(true);
    expect(ctx.hasStatusCode(404)).toBe(false);
  });

  it("ignores status codes outside the HTTP range (100-599)", () => {
    expect(errorContext(Object.assign(new Error("low"), { statusCode: 99 })).statusCode).toBe(
      undefined,
    );
    expect(errorContext(Object.assign(new Error("high"), { statusCode: 600 })).statusCode).toBe(
      undefined,
    );
    expect(errorContext(Object.assign(new Error("zero"), { statusCode: 0 })).statusCode).toBe(
      undefined,
    );
    expect(errorContext(Object.assign(new Error("min"), { statusCode: 100 })).statusCode).toBe(
      100,
    );
    expect(errorContext(Object.assign(new Error("max"), { statusCode: 599 })).statusCode).toBe(
      599,
    );
    const skipped = Object.assign(new Error("wrapper"), { statusCode: 99 });
    const cause = Object.assign(new Error("cause"), { statusCode: 404 });
    skipped.cause = cause;
    expect(errorContext(skipped).statusCode).toBe(404);
  });

  it("reads message text from Error.cause", () => {
    const err = new Error("wrapper", { cause: new Error("resource not found") });
    expect(errorContext(err).hasMessage("not", "found")).toBe(true);
  });

  it("reads HTTP status from nested errors", () => {
    const cause = Object.assign(new Error("permission denied"), { statusCode: 404 });
    const err = new Error("wrapper", { cause });
    expect(errorContext(err).hasStatusCode(404)).toBe(true);
  });

  it("reads primitive throws and Error.cause text", () => {
    expect(errorContext("resource not found").hasMessage("not", "found")).toBe(true);
    const err = new Error("wrapper", { cause: "resource not found" });
    expect(errorContext(err).hasMessage("not", "found")).toBe(true);
  });

  it("reads AggregateError child errors", () => {
    const err = new AggregateError(
      [new Error("permission denied"), new Error("resource not found")],
      "batch failed",
    );
    expect(errorContext(err).hasMessage("not", "found")).toBe(true);
  });
});

describe("ErrorContext.notFound", () => {
  it("recognizes typed 404 and message-missing errors", () => {
    expect(errorContext(apiError("not found", "NOT_FOUND", 404)).notAccessible).toBe(
      true,
    );
    expect(errorContext(new Error("Path does not exist")).notAccessible).toBe(true);
    expect(errorContext(new Error("resource not found")).notAccessible).toBe(true);
    expect(errorContext(new Error("permission denied")).notAccessible).toBe(false);
  });

  it("matches HTTP status classes via hasStatusCode(4)", () => {
    expect(
      errorContext(apiError("bad request", "BAD_REQUEST", 400)).hasStatusCode(4),
    ).toBe(true);
    expect(errorContext(apiError("denied", "FORBIDDEN", 403)).hasStatusCode(4)).toBe(
      true,
    );
    expect(
      errorContext(apiError("unauthorized", "UNAUTHORIZED", 401)).hasStatusCode(4),
    ).toBe(true);
    expect(
      errorContext(apiError("error", "INTERNAL_ERROR", 500)).hasStatusCode(4),
    ).toBe(false);
  });

  it("treats HttpError 404 as notFound via 4xx status class", () => {
    expect(errorContext(new HttpError("missing", 404)).notAccessible).toBe(true);
  });

  it("matches via message without a matching status class", () => {
    expect(
      errorContext(apiError("item not found", "FORBIDDEN", 403)).notAccessible,
    ).toBe(true);
    expect(
      errorContext(apiError("does not exist", "INTERNAL_ERROR", 500)).notAccessible,
    ).toBe(true);
  });

  it("matches RESOURCE_DOES_NOT_EXIST via errorCode tokens", () => {
    expect(
      errorContext(apiError("missing", "RESOURCE_DOES_NOT_EXIST", 400)).notAccessible,
    ).toBe(true);
  });
});

describe("ErrorContext.hasStatusCode", () => {
  it("matches when any status filter argument matches", () => {
    const ctx = errorContext(apiError("denied", "FORBIDDEN", 403));
    expect(ctx.hasStatusCode(404, 403)).toBe(true);
    expect(ctx.hasStatusCode(403, 404)).toBe(true);
    expect(ctx.hasStatusCode(404, 500)).toBe(false);
  });
});
