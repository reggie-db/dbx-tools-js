import { describe, expect, it } from "bun:test";

import type { ResolvedEmailConfig } from "../src/config.js";
import {
  assertSenderAllowed,
  deriveSenderAddress,
  isSenderAllowed,
  listSenderOptions,
  parseAllowedSenders,
  resolveSenderAddress,
} from "../src/sender.js";

/** A file-mode resolved config (the simplest shape with no SMTP fields). */
function fileConfig(over: Partial<ResolvedEmailConfig> = {}): ResolvedEmailConfig {
  return {
    mode: "file",
    outDir: "/tmp/outbox",
    allowedSenders: [],
    ...over,
  } as ResolvedEmailConfig;
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

describe("parseAllowedSenders", () => {
  it("returns an empty list for undefined (no restriction)", () => {
    expect(parseAllowedSenders(undefined)).toEqual([]);
  });

  it("splits a comma/space string, lower-cases, trims, and de-dupes", () => {
    expect(parseAllowedSenders(" *@Domain.com,  User@D2.com  *@Domain.com ")).toEqual([
      "*@domain.com",
      "user@d2.com",
    ]);
  });

  it("normalizes an array the same way", () => {
    expect(parseAllowedSenders(["A@B.com", "", "  a@b.com "])).toEqual(["a@b.com"]);
  });
});

describe("isSenderAllowed", () => {
  it("permits everything when the allow-list is empty", () => {
    expect(isSenderAllowed("anyone@anywhere.com", [])).toBe(true);
  });

  it("matches an exact address case-insensitively", () => {
    expect(isSenderAllowed("Bot@Fixed.com", ["bot@fixed.com"])).toBe(true);
    expect(isSenderAllowed("other@fixed.com", ["bot@fixed.com"])).toBe(false);
  });

  it("matches any local part on a wildcard or bare domain", () => {
    expect(isSenderAllowed("alice@mail.com", ["*@mail.com"])).toBe(true);
    expect(isSenderAllowed("bob@mail.com", ["mail.com"])).toBe(true);
    expect(isSenderAllowed("alice@other.com", ["*@mail.com"])).toBe(false);
  });

  it("does not treat the bare domain as a valid sender (needs a local part)", () => {
    expect(isSenderAllowed("@mail.com", ["*@mail.com"])).toBe(false);
  });

  it("permits everything for the `*` pattern", () => {
    expect(isSenderAllowed("whoever@wherever.io", ["*"])).toBe(true);
  });
});

describe("assertSenderAllowed", () => {
  it("is a no-op for a permitted sender", () => {
    expect(() => assertSenderAllowed("alice@mail.com", ["*@mail.com"])).not.toThrow();
  });

  it("throws for a disallowed sender, naming the allow-list", () => {
    expect(() => assertSenderAllowed("alice@evil.com", ["*@mail.com"])).toThrow(
      /not permitted by the configured allow-list/i,
    );
  });
});

describe("listSenderOptions", () => {
  it("returns the single default sender when unrestricted", () => {
    const config = fileConfig({ domain: "mail.example.com" });
    expect(listSenderOptions(config, "alice@databricks.com")).toEqual([
      "alice@mail.example.com",
    ]);
  });

  it("expands wildcards against the user local part and passes exact addresses through", () => {
    const config = fileConfig({
      domain: "mail.example.com",
      allowedSenders: ["*@mail.example.com", "noreply@fixed.com"],
    });
    // The resolved default is permitted, so it leads; the wildcard
    // expands to the same address (de-duped) and the exact address follows.
    expect(listSenderOptions(config, "alice@databricks.com")).toEqual([
      "alice@mail.example.com",
      "noreply@fixed.com",
    ]);
  });

  it("drops domain wildcards when no user local part is available", () => {
    const config = fileConfig({
      allowedSenders: ["*@mail.example.com", "noreply@fixed.com"],
    });
    expect(listSenderOptions(config, undefined)).toEqual(["noreply@fixed.com"]);
  });
});
