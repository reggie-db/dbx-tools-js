import { afterEach, describe, expect, it } from "bun:test";

import { resolveEmailConfig } from "../src/config.js";
import { resetEmailRuntime } from "../src/transport.js";

const SMTP_ENV_KEYS = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "EMAIL_DOMAIN",
  "EMAIL_FROM",
  "EMAIL_OUTBOX_MODE",
  "EMAIL_OUTBOX_DIR",
] as const;

const savedEnv = new Map<string, string | undefined>();

function stashEnv(): void {
  for (const key of SMTP_ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  resetEmailRuntime();
}

function restoreEnv(): void {
  for (const key of SMTP_ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  resetEmailRuntime();
}

describe("resolveEmailConfig", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("resolves SMTP mode when host, user, password, and domain are set", () => {
    stashEnv();
    process.env["SMTP_HOST"] = "mail.example.com";
    process.env["SMTP_USER"] = "bot@example.com";
    process.env["SMTP_PASSWORD"] = "secret";
    process.env["EMAIL_DOMAIN"] = "example.com";

    const config = resolveEmailConfig();
    expect(config.mode).toBe("smtp");
    if (config.mode === "smtp") {
      expect(config.host).toBe("mail.example.com");
      expect(config.auth).toEqual({ user: "bot@example.com", pass: "secret" });
      expect(config.domain).toBe("example.com");
    }
  });

  it("throws when SMTP credentials are partially configured", () => {
    stashEnv();
    process.env["SMTP_HOST"] = "mail.example.com";
    process.env["SMTP_USER"] = "bot@example.com";

    expect(() => resolveEmailConfig()).toThrow(/incomplete SMTP configuration/i);
    expect(() => resolveEmailConfig()).toThrow(/SMTP_PASSWORD/);
  });

  it("throws when SMTP is absent and outbox mode is not enabled", () => {
    stashEnv();
    expect(() => resolveEmailConfig()).toThrow(/SMTP is not configured/i);
  });

  it("resolves file mode when outbox mode is explicitly enabled", () => {
    stashEnv();
    process.env["EMAIL_OUTBOX_MODE"] = "1";
    process.env["EMAIL_OUTBOX_DIR"] = "/tmp/test-outbox";

    const config = resolveEmailConfig();
    expect(config.mode).toBe("file");
    if (config.mode === "file") {
      expect(config.outDir).toBe("/tmp/test-outbox");
    }
  });

  it("throws in SMTP mode when no sender source is configured", () => {
    stashEnv();
    process.env["SMTP_HOST"] = "mail.example.com";
    process.env["SMTP_USER"] = "bot@example.com";
    process.env["SMTP_PASSWORD"] = "secret";

    expect(() => resolveEmailConfig()).toThrow(/no sender source/i);
  });
});
