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
 * (SMTP host/port/credentials, sender domain or explicit `from`), with
 * unprefixed `SMTP_*` / `EMAIL_*` environment fallbacks.
 */

import { Plugin, toPlugin, type PluginManifest } from "@databricks/appkit";
import type { EmailMessage, EmailResult } from "@dbx-tools/appkit-email-shared";
import { commonUtils, logUtils } from "@dbx-tools/shared";
import { EMAIL_CONFIG_SCHEMA, type EmailPluginConfig } from "./config.js";
import { getEmailRuntime, sendEmail } from "./transport.js";

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
   * credentials the runtime is in file/outbox mode, logged here so it's
   * obvious mail is being written to disk rather than sent.
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

  override exports() {
    return {
      /**
       * Send a message immediately from `from` through the shared
       * transport, bypassing the approval flow. For agent-driven sends
       * use {@link emailTool} instead.
       */
      sendEmail: (message: EmailMessage, from: string): Promise<EmailResult> =>
        sendEmail(message, from),
    };
  }
}

export const email = toPlugin(EmailPlugin);
