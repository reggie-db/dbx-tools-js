/**
 * The email runtime: a lazily-built, process-wide dispatcher plus its
 * resolved config, and {@link sendEmail} which sends one
 * {@link EmailMessage} through it. In SMTP mode the runtime holds a
 * memoized nodemailer transport (shared by the plugin's setup and the
 * agent tool, so they reuse one connection pool); in file/outbox mode it
 * holds no transport and {@link sendEmail} writes HTML to disk instead.
 * The first caller (normally the plugin at setup) primes it with the
 * plugin's config; later callers reuse it.
 */

import type { EmailMessage, EmailResult } from "@dbx-tools/appkit-email-shared";
import nodemailer, { type Transporter } from "nodemailer";
import {
  resolveEmailConfig,
  type EmailPluginConfig,
  type ResolvedEmailConfig,
} from "./config.js";
import { renderEmailHtml } from "./email-html.js";
import { writeOutboxEmail } from "./outbox.js";

/** The shared dispatcher and the config it was built from. */
export interface EmailRuntime {
  /** Present only in SMTP mode. */
  transporter?: Transporter;
  config: ResolvedEmailConfig;
}

let runtime: EmailRuntime | undefined;

/**
 * Return the shared runtime, building it on first use from the supplied
 * config layered over environment defaults. Overrides are only read when
 * the runtime is first created, so prime it from the plugin's config at
 * setup; subsequent calls (e.g. the tool's `execute`) pass nothing and
 * get the same instance.
 */
export function getEmailRuntime(overrides?: EmailPluginConfig): EmailRuntime {
  if (!runtime) {
    const config = resolveEmailConfig(overrides);
    runtime = {
      config,
      ...(config.mode === "smtp"
        ? {
            transporter: nodemailer.createTransport({
              host: config.host,
              port: config.port,
              secure: config.secure,
              auth: config.auth,
            }),
          }
        : {}),
    };
  }
  return runtime;
}

/** Drop the memoized runtime so the next {@link getEmailRuntime} rebuilds it. */
export function resetEmailRuntime(): void {
  runtime?.transporter?.close();
  runtime = undefined;
}

/**
 * Send (SMTP mode) or persist (file/outbox mode) one message from the
 * resolved `from` address. The body is markdown: SMTP sends it as both a
 * plain-text part (the raw source) and an HTML part (rendered), and the
 * outbox embeds the rendered HTML in a document. In file mode the
 * returned `messageId` is the path written.
 */
export async function sendEmail(message: EmailMessage, from: string): Promise<EmailResult> {
  const { config, transporter } = getEmailRuntime();

  if (config.mode === "file") {
    const path = await writeOutboxEmail(message, from, config.outDir);
    return { sent: true, recipient: message.to, from, messageId: path };
  }

  if (!transporter) throw new Error("email: SMTP transport unavailable");
  const info = await transporter.sendMail({
    from,
    to: message.to,
    subject: message.subject,
    text: message.body,
    html: renderEmailHtml({ subject: message.subject, body: message.body }),
    ...(message.cc && message.cc.length > 0 ? { cc: message.cc } : {}),
    ...(message.bcc && message.bcc.length > 0 ? { bcc: message.bcc } : {}),
  });
  return {
    sent: true,
    recipient: message.to,
    from,
    ...(info.messageId ? { messageId: info.messageId } : {}),
  };
}
