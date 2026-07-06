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

import type {
  EmailAttachment,
  EmailMessage,
  EmailResult,
} from "@dbx-tools/appkit-email-shared";
import nodemailer, {
  type SendMailOptions,
  type Transporter,
} from "nodemailer";
import {
  resolveEmailConfig,
  type EmailPluginConfig,
  type ResolvedEmailConfig,
} from "./config.js";
import { renderEmailHtml } from "./email-html.js";
import { writeOutboxEmail } from "./outbox.js";
import { assertSenderAllowed } from "./sender.js";

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

/** The comma-joined recipient string echoed back in {@link EmailResult}. */
function recipientEcho(to: string[]): string {
  return to.join(", ");
}

/**
 * Map the wire-format {@link EmailAttachment}s onto nodemailer's
 * attachment shape, dropping unset optional keys so nodemailer applies
 * its own defaults (utf-8 encoding, filename-inferred content type). The
 * wire fields are a deliberate subset of nodemailer's, so this is a
 * straight structural pass-through.
 */
function toMailAttachments(
  attachments: EmailAttachment[] | undefined,
): SendMailOptions["attachments"] {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((att) => ({
    filename: att.filename,
    ...(att.content !== undefined ? { content: att.content } : {}),
    ...(att.encoding !== undefined ? { encoding: att.encoding } : {}),
    ...(att.path !== undefined ? { path: att.path } : {}),
    ...(att.contentType !== undefined ? { contentType: att.contentType } : {}),
  }));
}

/**
 * Send (SMTP mode) or persist (file/outbox mode) one message from the
 * resolved `from` address. `to` (and optional `cc` / `bcc`) each accept
 * one or more addresses, and `attachments` are forwarded as files. The
 * body is markdown: SMTP sends it as both a plain-text part (the raw
 * source) and an HTML part (rendered), and the outbox embeds the
 * rendered HTML in a document. In file mode the returned `messageId` is
 * the path written. Throws when `to` carries no recipient, or when `from`
 * is not permitted by the configured sender allow-list.
 */
export async function sendEmail(
  message: EmailMessage,
  from: string,
): Promise<EmailResult> {
  if (message.to.length === 0) {
    throw new Error("email: `to` must include at least one recipient");
  }
  const { config, transporter } = getEmailRuntime();
  assertSenderAllowed(from, config.allowedSenders);
  const recipient = recipientEcho(message.to);

  if (config.mode === "file") {
    const path = await writeOutboxEmail(message, from, config.outDir);
    return { sent: true, recipient, from, messageId: path };
  }

  if (!transporter) throw new Error("email: SMTP transport unavailable");
  const attachments = toMailAttachments(message.attachments);
  const info = await transporter.sendMail({
    from,
    to: message.to,
    subject: message.subject,
    text: message.body,
    html: renderEmailHtml({ subject: message.subject, body: message.body }),
    ...(message.cc && message.cc.length > 0 ? { cc: message.cc } : {}),
    ...(message.bcc && message.bcc.length > 0 ? { bcc: message.bcc } : {}),
    ...(attachments ? { attachments } : {}),
  });
  return {
    sent: true,
    recipient,
    from,
    ...(info.messageId ? { messageId: info.messageId } : {}),
  };
}
