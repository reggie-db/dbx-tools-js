import { describe, expect, it } from "bun:test";

import {
  emailMessageSchema,
  emailResultSchema,
  emailSendersSchema,
} from "../src/protocol.js";

describe("emailMessageSchema", () => {
  it("accepts a minimal message with just to/subject/body", () => {
    const parsed = emailMessageSchema.parse({
      to: ["alice@example.com"],
      subject: "Hi",
      body: "# Hello",
    });
    expect(parsed).toEqual({
      to: ["alice@example.com"],
      subject: "Hi",
      body: "# Hello",
    });
  });

  it("accepts one or more `to` recipients", () => {
    const parsed = emailMessageSchema.parse({
      to: ["a@example.com", "b@example.com"],
      subject: "s",
      body: "b",
    });
    expect(parsed.to).toEqual(["a@example.com", "b@example.com"]);
  });

  it("accepts optional cc/bcc arrays", () => {
    const parsed = emailMessageSchema.parse({
      to: ["a@example.com"],
      subject: "s",
      body: "b",
      cc: ["b@example.com"],
      bcc: [],
    });
    expect(parsed.cc).toEqual(["b@example.com"]);
    expect(parsed.bcc).toEqual([]);
  });

  it("accepts optional attachments and drops unset keys", () => {
    const parsed = emailMessageSchema.parse({
      to: ["a@example.com"],
      subject: "s",
      body: "b",
      attachments: [
        { filename: "report.pdf", path: "/tmp/report.pdf" },
        { filename: "data.csv", content: "aGVsbG8=", encoding: "base64" },
      ],
    });
    expect(parsed.attachments).toEqual([
      { filename: "report.pdf", path: "/tmp/report.pdf" },
      { filename: "data.csv", content: "aGVsbG8=", encoding: "base64" },
    ]);
  });

  it("requires a filename on each attachment", () => {
    expect(() =>
      emailMessageSchema.parse({
        to: ["a@example.com"],
        subject: "s",
        body: "b",
        attachments: [{ content: "x" }],
      }),
    ).toThrow();
  });

  it("rejects a message missing a required field", () => {
    expect(() =>
      emailMessageSchema.parse({ to: ["a@example.com"], subject: "s" }),
    ).toThrow();
  });

  it("rejects a bare string `to` (recipients are an array)", () => {
    expect(() =>
      emailMessageSchema.parse({ to: "a@example.com", subject: "s", body: "b" }),
    ).toThrow();
  });

  it("does not validate `to` entries as email addresses", () => {
    // The contract intentionally keeps each `to` entry a free string;
    // address shape is the sender's job, not the schema's.
    expect(
      emailMessageSchema.parse({ to: ["not-an-email"], subject: "s", body: "b" }).to,
    ).toEqual(["not-an-email"]);
  });

  it("strips unknown keys rather than carrying them through", () => {
    const parsed = emailMessageSchema.parse({
      to: ["a@example.com"],
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

describe("emailSendersSchema", () => {
  it("accepts a restricted list with a default sender", () => {
    const parsed = emailSendersSchema.parse({
      senders: ["alice@mail.com", "noreply@fixed.com"],
      defaultSender: "alice@mail.com",
      restricted: true,
    });
    expect(parsed.senders).toEqual(["alice@mail.com", "noreply@fixed.com"]);
    expect(parsed.defaultSender).toBe("alice@mail.com");
    expect(parsed.restricted).toBe(true);
  });

  it("accepts an unrestricted payload without a default", () => {
    const parsed = emailSendersSchema.parse({ senders: [], restricted: false });
    expect(parsed.senders).toEqual([]);
    expect(parsed.defaultSender).toBeUndefined();
  });

  it("requires the restricted flag", () => {
    expect(() => emailSendersSchema.parse({ senders: [] })).toThrow();
  });
});
