import { describe, expect, it } from "bun:test";

import { emailMessageSchema, emailResultSchema } from "../src/protocol.js";

describe("emailMessageSchema", () => {
  it("accepts a minimal message with just to/subject/body", () => {
    const parsed = emailMessageSchema.parse({
      to: "alice@example.com",
      subject: "Hi",
      body: "# Hello",
    });
    expect(parsed).toEqual({
      to: "alice@example.com",
      subject: "Hi",
      body: "# Hello",
    });
  });

  it("accepts optional cc/bcc arrays", () => {
    const parsed = emailMessageSchema.parse({
      to: "a@example.com",
      subject: "s",
      body: "b",
      cc: ["b@example.com"],
      bcc: [],
    });
    expect(parsed.cc).toEqual(["b@example.com"]);
    expect(parsed.bcc).toEqual([]);
  });

  it("rejects a message missing a required field", () => {
    expect(() =>
      emailMessageSchema.parse({ to: "a@example.com", subject: "s" }),
    ).toThrow();
  });

  it("does not validate `to` as an email address (caller comma-separates)", () => {
    // The contract intentionally keeps `to` a free string; address shape
    // and multi-recipient splitting are the sender's job, not the schema's.
    expect(
      emailMessageSchema.parse({ to: "not-an-email", subject: "s", body: "b" }).to,
    ).toBe("not-an-email");
  });

  it("strips unknown keys rather than carrying them through", () => {
    const parsed = emailMessageSchema.parse({
      to: "a@example.com",
      subject: "s",
      body: "b",
      priority: "high",
    });
    expect(parsed).not.toHaveProperty("priority");
  });
});

describe("emailResultSchema", () => {
  it("accepts a result without the optional messageId", () => {
    const parsed = emailResultSchema.parse({
      sent: true,
      recipient: "a@example.com",
      from: "bot@example.com",
    });
    expect(parsed.messageId).toBeUndefined();
  });

  it("carries the messageId when present", () => {
    expect(
      emailResultSchema.parse({
        sent: true,
        recipient: "a@example.com",
        from: "bot@example.com",
        messageId: "<abc@smtp>",
      }).messageId,
    ).toBe("<abc@smtp>");
  });

  it("rejects a non-boolean sent flag", () => {
    expect(() =>
      emailResultSchema.parse({ sent: "yes", recipient: "a", from: "b" }),
    ).toThrow();
  });
});
