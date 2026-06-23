/**
 * Sender-address resolution: turn the on-behalf-of user's email into an
 * outbound `From`. The default re-homes the local part (everything
 * before `@`) of the OBO email on the configured sending domain, so
 * `alice@databricks.com` through a domain of `mail.example.com` goes
 * out as `alice@mail.example.com`. An explicit `from` short-circuits
 * that; the file/outbox fallback (no domain) keeps the user's address
 * verbatim so test artifacts land under a recognizable folder.
 */

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
