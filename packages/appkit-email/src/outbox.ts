/**
 * Filesystem outbox for the no-SMTP fallback: {@link writeOutboxEmail}
 * persists one drafted message as a standalone HTML file under
 * `<dir>/<from>/<timestamp>-<subject-slug>.html` instead of sending it.
 * This lets the approval flow and agents be exercised end-to-end with
 * zero email configuration - open the file in a browser to see exactly
 * what would have gone out (the HTML matches the SMTP send, headers
 * table aside). The body is rendered + style-inlined by
 * {@link renderEmailHtml}.
 */

import type { EmailMessage } from "@dbx-tools/appkit-email-shared";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { renderEmailHtml } from "./email-html.js";

/** Filesystem-safe slug of the subject for the file name. */
function subjectSlug(subject: string): string {
  const slug = subject
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (slug || "email").slice(0, 48);
}

/** The envelope rows shown above the body in the preview file. */
function headerRows(
  message: EmailMessage,
  from: string,
): Array<readonly [string, string]> {
  const rows: Array<readonly [string, string | undefined]> = [
    ["From", from],
    ["To", message.to],
    ["Cc", message.cc?.join(", ")],
    ["Bcc", message.bcc?.join(", ")],
    ["Subject", message.subject],
    ["Date", new Date().toISOString()],
  ];
  return rows.filter((row): row is [string, string] => Boolean(row[1]));
}

/**
 * Write one message as HTML under `<dir>/<from>/` and return the
 * absolute path. The per-sender folder mirrors the SMTP `From`, so test
 * output groups by who the message would have been sent as.
 */
export async function writeOutboxEmail(
  message: EmailMessage,
  from: string,
  dir: string,
): Promise<string> {
  const folder = resolve(dir, from);
  await mkdir(folder, { recursive: true });
  const path = join(folder, `${Date.now()}-${subjectSlug(message.subject)}.html`);
  const html = renderEmailHtml({
    subject: message.subject,
    headers: headerRows(message, from),
    body: message.body,
    footer:
      "Local outbox preview - written to disk, not sent (no SMTP credentials configured).",
  });
  await writeFile(path, html, "utf8");
  return path;
}
