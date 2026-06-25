import { describe, expect, it } from "bun:test";

import type { ResolvedEmailConfig } from "../src/config.js";
import { deriveSenderAddress, resolveSenderAddress } from "../src/sender.js";

/** A file-mode resolved config (the simplest shape with no SMTP fields). */
function fileConfig(over: Partial<ResolvedEmailConfig> = {}): ResolvedEmailConfig {
  return { mode: "file", outDir: "/tmp/outbox", ...over } as ResolvedEmailConfig;
}

describe("deriveSenderAddress", () => {
  it("re-homes the OBO local part on the configured domain", () => {
    expect(deriveSenderAddress("alice@databricks.com", "mail.example.com")).toBe(
      "alice@mail.example.com",
    );
  });

  it("trims surrounding whitespace from the local part", () => {
    expect(deriveSenderAddress("  alice  @databricks.com", "d.com")).toBe(
      "alice@d.com",
    );
  });

  it("throws when no user email is available", () => {
    expect(() => deriveSenderAddress(undefined, "d.com")).toThrow(
      /no on-behalf-of user email/i,
    );
  });

  it("throws when the email has no local part", () => {
    expect(() => deriveSenderAddress("@databricks.com", "d.com")).toThrow();
  });
});

describe("resolveSenderAddress", () => {
  it("uses an explicit `from` verbatim, ignoring user and domain", () => {
    const config = fileConfig({ from: "noreply@fixed.com", domain: "ignored.com" });
    expect(resolveSenderAddress(config, "alice@databricks.com")).toBe(
      "noreply@fixed.com",
    );
  });

  it("derives `<local>@<domain>` when a domain is configured", () => {
    const config = fileConfig({ domain: "mail.example.com" });
    expect(resolveSenderAddress(config, "alice@databricks.com")).toBe(
      "alice@mail.example.com",
    );
  });

  it("falls back to the user's address verbatim in file mode with no domain", () => {
    expect(resolveSenderAddress(fileConfig(), "  alice@databricks.com  ")).toBe(
      "alice@databricks.com",
    );
  });

  it("throws when no from, no domain, and no user email are available", () => {
    expect(() => resolveSenderAddress(fileConfig(), undefined)).toThrow(
      /no sender address available/i,
    );
  });
});
