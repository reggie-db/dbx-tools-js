/**
 * AppKit plugin (registered name: `email`) that owns the SMTP runtime
 * for outbound mail. Registering it validates the SMTP configuration
 * and verifies connectivity at startup, so a bad host / credential
 * surfaces in the boot logs instead of on the first approved send. The
 * actual send happens through the approval-gated {@link emailTool}
 * spread into an agent; this plugin primes the shared transport the
 * tool reuses and exposes a direct {@link sendEmail} for non-agent
 * callers.
 *
 * Configuration is the manifest-published {@link EmailPluginConfig}
 * (SMTP host/port/credentials, sender domain or explicit `from`, and an
 * optional `allowedSenders` restriction), with unprefixed `SMTP_*` /
 * `EMAIL_*` environment fallbacks.
 *
 * The plugin mounts one route under its base path (`/api/email`):
 * `GET /senders` returns the permitted `From` options for the calling
 * user, so a compose UI can offer them in a dropdown.
 */

import {
  getExecutionContext,
  Plugin,
  toPlugin,
  type IAppRouter,
  type PluginManifest,
} from "@databricks/appkit";
import type {
  EmailMessage,
  EmailResult,
  EmailSenders,
} from "@dbx-tools/appkit-email-shared";
import { commonUtils, logUtils } from "@dbx-tools/shared";
import type express from "express";
import { EMAIL_CONFIG_SCHEMA, type EmailPluginConfig } from "./config.js";
import { isSenderAllowed, listSenderOptions, resolveSenderAddress } from "./sender.js";
import { getEmailRuntime, sendEmail } from "./transport.js";

/** Mount-relative route (under `/api/email`) for the sender-options lookup. */
const SENDERS_ROUTE = "/senders";

/**
 * AppKit plugin that configures and verifies the SMTP transport used by
 * the `send_email` tool.
 */
export class EmailPlugin extends Plugin<EmailPluginConfig> {
  static manifest = {
    name: "email",
    displayName: "Email",
    description:
      "Sends approval-gated email over SMTP, with the sender derived from " +
      "the on-behalf-of user's address on a configured domain.",
    stability: "beta",
    resources: {
      required: [],
      optional: [],
    },
    config: { schema: EMAIL_CONFIG_SCHEMA },
  } satisfies PluginManifest<"email">;

  private log = logUtils.logger(this);

  /**
   * Prime the shared runtime from this plugin's config (over env). In
   * SMTP mode, verify connectivity - a failed verify is logged as a
   * warning rather than thrown, so the app still boots and the first
   * send surfaces the real error via the approval flow. With no SMTP
   * credentials the runtime is in file/outbox mode (only when
   * `EMAIL_OUTBOX_MODE` is set), logged here so it's obvious mail is
   * being written to disk rather than sent.
   */
  override async setup(): Promise<void> {
    const { transporter, config } = getEmailRuntime(this.config);
    if (config.mode === "file") {
      this.log.warn("outbox:enabled", {
        dir: config.outDir,
        reason:
          "no SMTP credentials configured; emails are written to disk instead of sent",
      });
      return;
    }
    try {
      await transporter?.verify();
      this.log.info("smtp:ready", {
        host: config.host,
        port: config.port,
        secure: config.secure,
      });
    } catch (err) {
      this.log.warn("smtp:unverified", { error: commonUtils.errorMessage(err) });
    }
  }

  /**
   * Expose the sender-options lookup so UI compose views can populate a
   * `From` dropdown from the configured allow-list. Mounted under the
   * plugin base path, i.e. `GET /api/email/senders`. Runs in the OBO
   * user scope so domain wildcards resolve against the caller's own
   * local part.
   */
  override injectRoutes(router: IAppRouter): void {
    router.get(SENDERS_ROUTE, (req, res, next) => {
      this.userScopedSelf(req)
        .listSenders()
        .then((senders) => res.json(senders))
        .catch(next);
    });
  }

  override exports() {
    return {
      /**
       * Send a message immediately from `from` through the shared
       * transport, bypassing the approval flow. For agent-driven sends
       * use {@link emailTool} instead.
       */
      sendEmail: (message: EmailMessage, from: string): Promise<EmailResult> =>
        sendEmail(message, from),
      /**
       * Sender options for the current user (the `GET /senders` payload).
       * AppKit wraps this with `asUser(req)` for OBO scoping.
       */
      listSenders: (): Promise<EmailSenders> => this.listSenders(),
    };
  }

  /**
   * Compute the `From` options offered to the current user: the concrete
   * addresses the configured allow-list permits (domain wildcards
   * expanded against the OBO user's local part), the default among them,
   * and whether the list is an enforced restriction. See
   * {@link listSenderOptions}.
   */
  private async listSenders(): Promise<EmailSenders> {
    const { config } = getEmailRuntime();
    const ctx = getExecutionContext();
    const userEmail = "isUserContext" in ctx ? ctx.userEmail : undefined;
    const senders = listSenderOptions(config, userEmail);
    // Prefer the address a send would actually default to; fall back to
    // the first offered option when that can't be resolved / permitted.
    let defaultSender = senders[0];
    try {
      const resolved = resolveSenderAddress(config, userEmail).toLowerCase();
      if (isSenderAllowed(resolved, config.allowedSenders)) defaultSender = resolved;
    } catch {
      // Keep the first offered option (or none) as the default.
    }
    return {
      senders,
      ...(defaultSender ? { defaultSender } : {}),
      restricted: config.allowedSenders.length > 0,
    };
  }

  /**
   * Return `this.asUser(req)` when the request carries an OBO token,
   * otherwise `this`. Avoids the noisy AppKit "asUser without token"
   * warning on every request in local dev; behavior is unchanged in
   * production where a missing token means a real OBO call.
   */
  private userScopedSelf(req: express.Request): this {
    return req.header("x-forwarded-access-token") ? (this.asUser(req) as this) : this;
  }
}

export const email = toPlugin(EmailPlugin);
