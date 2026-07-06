/**
 * Sender-address policy: turn the on-behalf-of user's email into an
 * outbound `From`, and (optionally) restrict which addresses may send.
 *
 * The default `From` re-homes the local part (everything before `@`) of
 * the OBO email on the configured sending domain, so `alice@databricks.com`
 * through a domain of `mail.example.com` goes out as
 * `alice@mail.example.com`. An explicit `from` short-circuits that; the
 * file/outbox fallback (no domain) keeps the user's address verbatim so
 * test artifacts land under a recognizable folder.
 *
 * When an allow-list is configured (see {@link parseAllowedSenders}) the
 * resolved `From` is constrained to it: a pattern is either an exact
 * address (`user@domain.com`), a domain wildcard (`*@domain.com` or the
 * bare `domain.com`, matching any local part on that domain), or `*`
 * (any). {@link listSenderOptions} expands the allow-list into the
 * concrete addresses a UI dropdown can offer for the current user.
 */

import { netUtils } from "@dbx-tools/shared";

import type { ResolvedEmailConfig } from "./config.js";

/**
 * Re-home the OBO user's local part on `domain`. Throws when no usable
 * local part is available (e.g. a service-context call with no user).
 */
export function deriveSenderAddress(
  userEmail: string | undefined,
  domain: string,
): string {
  const local = userEmail?.split("@")[0]?.trim();
  if (!local) {
    throw new Error(
      "email: cannot derive sender address - no on-behalf-of user email is available; set `from` / EMAIL_FROM to send from a fixed address",
    );
  }
  return `${local}@${domain}`;
}

/**
 * Normalize a sender allow-list from config (a `string[]`) or an env var
 * (a CSV / whitespace-separated string). Delegates to the shared
 * {@link netUtils.parseEmails} so allow-list patterns are read exactly
 * like recipient lists elsewhere: entries are trimmed, lower-cased (so
 * matching in {@link isSenderAllowed} is case-insensitive), and
 * de-duplicated; empties are dropped. An empty result means "no
 * restriction".
 */
export function parseAllowedSenders(raw: string | string[] | undefined): string[] {
  return netUtils.parseEmails(raw, { lowercase: true });
}

/** The `@domain` suffix a wildcard / bare-domain pattern matches, else null. */
function patternDomainSuffix(pattern: string): string | null {
  if (pattern.startsWith("*@")) return `@${pattern.slice(2)}`;
  if (!pattern.includes("@")) return `@${pattern}`;
  return null;
}

/** Whether `address` (already lower-cased) satisfies a single pattern. */
function matchesPattern(address: string, pattern: string): boolean {
  if (pattern === "*") return true;
  const suffix = patternDomainSuffix(pattern);
  if (suffix) return address.length > suffix.length && address.endsWith(suffix);
  return address === pattern;
}

/**
 * Whether `from` is permitted by the allow-list. An empty (or absent)
 * allow-list permits everything.
 */
export function isSenderAllowed(from: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  const address = from.trim().toLowerCase();
  return patterns.some((pattern) => matchesPattern(address, pattern));
}

/**
 * Throw when `from` is not permitted by the allow-list. No-op when the
 * allow-list is empty. The single enforcement point for the restriction
 * (called from {@link sendEmail}), so every send path is covered whether
 * the address was derived server-side or chosen in a UI.
 */
export function assertSenderAllowed(from: string, patterns: string[]): void {
  if (!isSenderAllowed(from, patterns)) {
    throw new Error(
      `email: sender "${from}" is not permitted by the configured allow-list (${patterns.join(", ")})`,
    );
  }
}

/**
 * Resolve the `From` address for a send from the resolved config and the
 * current OBO user: explicit `from` wins, then `<local>@<domain>`, then
 * (file/outbox mode only) the user's email verbatim. Throws when none of
 * those yield an address.
 */
export function resolveSenderAddress(
  config: ResolvedEmailConfig,
  userEmail: string | undefined,
): string {
  if (config.from) return config.from;
  if (config.domain) return deriveSenderAddress(userEmail, config.domain);
  const email = userEmail?.trim();
  if (!email) {
    throw new Error(
      "email: no sender address available - set `from` / EMAIL_FROM, `domain` / EMAIL_DOMAIN, or run on behalf of a user",
    );
  }
  return email;
}

/**
 * Expand the resolved config's allow-list into the concrete `From`
 * addresses offered to the current user - the data a UI sender dropdown
 * renders. Exact-address patterns pass through; domain wildcards
 * (`*@domain.com` / bare `domain.com`) are concretized as
 * `<user-local>@<domain>` and dropped when no OBO user local part is
 * available. When no allow-list is configured, the single default sender
 * ({@link resolveSenderAddress}) is returned when it can be resolved,
 * else an empty list. The default resolved sender, when permitted, is
 * ordered first.
 */
export function listSenderOptions(
  config: ResolvedEmailConfig,
  userEmail: string | undefined,
): string[] {
  const patterns = config.allowedSenders ?? [];
  const local = userEmail?.split("@")[0]?.trim().toLowerCase();
  const options: string[] = [];
  const add = (address: string | undefined): void => {
    if (address && !options.includes(address)) options.push(address);
  };

  // Surface the address a send would use by default first, when it can
  // be resolved and the allow-list (if any) permits it.
  try {
    const fallback = resolveSenderAddress(config, userEmail);
    if (isSenderAllowed(fallback, patterns)) add(fallback.toLowerCase());
  } catch {
    // No default resolvable (e.g. file mode with no user / domain / from).
  }

  for (const pattern of patterns) {
    if (pattern === "*") continue; // "any" can't be enumerated as a choice
    if (pattern.startsWith("*@") || !pattern.includes("@")) {
      const domain = pattern.startsWith("*@") ? pattern.slice(2) : pattern;
      if (local) add(`${local}@${domain}`);
    } else {
      add(pattern); // exact address
    }
  }
  return options;
}
