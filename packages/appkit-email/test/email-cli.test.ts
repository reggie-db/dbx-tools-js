#!/usr/bin/env bun
/**
 * Manual harness for firing off a single email through the resolved
 * email runtime - handy for smoke-testing SMTP creds or the file/outbox
 * fallback without standing up an app. Recipients accept the same
 * CSV / repeated-flag / list shapes the plugin does (via the shared
 * {@link netUtils.parseEmails}); the body is Markdown. Run it directly:
 *
 *   bun packages/appkit-email/test/email-cli.test.ts \
 *     --to alice@example.com,bob@example.com \
 *     --subject "Hi" --body "**Hello** from the CLI"
 *
 *   bun packages/appkit-email/test/email-cli.test.ts \
 *     -t alice@example.com -c team@example.com \
 *     -s "Report" --body-file ./report.md -a ./report.pdf --json
 *
 * The `From` address comes from `--from`, else it is derived from
 * `--user` against EMAIL_DOMAIN / EMAIL_FROM exactly as a real send would
 * be. `commander` is a root dev dependency (this package does not depend
 * on it); CLI harnesses always run from the repo root.
 *
 * `bun test` runs `.test.ts` files with no extra CLI argv, so the
 * `import.meta.main && argv > 2` guard keeps this a no-op under the test
 * runner and only fires when invoked directly with arguments.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";

import type { EmailAttachment, EmailMessage } from "@dbx-tools/appkit-email-shared";
import { netUtils } from "@dbx-tools/shared";
import { Command } from "commander";

import { resolveSenderAddress } from "../src/sender.js";
import { getEmailRuntime, resetEmailRuntime, sendEmail } from "../src/transport.js";

interface SendOptions {
  to: string[];
  cc: string[];
  bcc: string[];
  attach: string[];
  subject?: string;
  body?: string;
  bodyFile?: string;
  from?: string;
  user?: string;
  json?: boolean;
}

/** Accumulate a repeated `--opt value` flag into an array. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Resolve the Markdown body from `--body`, `--body-file`, or piped stdin. */
async function resolveBody(opts: SendOptions): Promise<string> {
  if (opts.body !== undefined) return opts.body;
  if (opts.bodyFile) return readFileSync(opts.bodyFile, "utf8");
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const piped = Buffer.concat(chunks).toString("utf8").trim();
    if (piped) return piped;
  }
  throw new Error("email-cli: no body - pass --body, --body-file, or pipe stdin");
}

/** A local file path becomes a `path`-backed attachment (nodemailer reads it). */
function toAttachment(path: string): EmailAttachment {
  return { filename: basename(path), path };
}

/** Warn (but don't block) on addresses that fail the shape check. */
function warnMalformed(label: string, addresses: string[]): void {
  const bad = addresses.filter((a) => !netUtils.isEmail(a));
  if (bad.length > 0) {
    process.stderr.write(`email-cli: warning - malformed ${label}: ${bad.join(", ")}\n`);
  }
}

async function main(): Promise<void> {
  const program = new Command()
    .name("email-cli")
    .description("Send one email through the resolved email runtime.");

  program
    .command("send", { isDefault: true })
    .description("Compose and send a single email.")
    .option("-t, --to <address>", "recipient (repeatable or CSV)", collect, [])
    .option("-c, --cc <address>", "CC recipient (repeatable or CSV)", collect, [])
    .option("-b, --bcc <address>", "BCC recipient (repeatable or CSV)", collect, [])
    .option("-a, --attach <path>", "file to attach (repeatable)", collect, [])
    .option("-s, --subject <subject>", "subject line")
    .option("--body <markdown>", "body as GitHub-Flavored Markdown")
    .option("--body-file <path>", "read the Markdown body from a file")
    .option("-f, --from <address>", "explicit sender; overrides --user derivation")
    .option("-u, --user <email>", "on-behalf-of user email to derive the sender from")
    .option("--json", "print the raw JSON result")
    .action(async (opts: SendOptions) => {
      const to = netUtils.parseEmails(opts.to);
      if (to.length === 0) {
        throw new Error("email-cli: at least one --to recipient is required");
      }
      const cc = netUtils.parseEmails(opts.cc);
      const bcc = netUtils.parseEmails(opts.bcc);
      warnMalformed("to", to);
      warnMalformed("cc", cc);
      warnMalformed("bcc", bcc);

      const message: EmailMessage = {
        to,
        subject: opts.subject ?? "",
        body: await resolveBody(opts),
        ...(cc.length > 0 ? { cc } : {}),
        ...(bcc.length > 0 ? { bcc } : {}),
        ...(opts.attach.length > 0 ? { attachments: opts.attach.map(toAttachment) } : {}),
      };

      const from = opts.from ?? resolveSenderAddress(getEmailRuntime().config, opts.user);
      const result = await sendEmail(message, from);

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      process.stdout.write(
        `sent from ${result.from} to ${result.recipient}` +
          `${result.messageId ? ` (${result.messageId})` : ""}\n`,
      );
    });

  await program.parseAsync(process.argv);
}

if (import.meta.main && process.argv.length > 2) {
  main()
    .then(() => {
      resetEmailRuntime();
      // Nodemailer can leave TLS sockets referenced on Bun; a one-shot
      // harness must exit explicitly once the send finishes.
      process.exit(0);
    })
    .catch((err: unknown) => {
      resetEmailRuntime();
      process.stderr.write(
        `${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      process.exit(1);
    });
}
