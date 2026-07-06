/**
 * The `send_email` Mastra tool: approval-gated so a model can draft a
 * message freely but nothing leaves the building until a human clicks
 * Approve in the chat UI. On approval the sender is resolved (explicit
 * `from` config, else derived from the on-behalf-of user's email) and
 * the message is dispatched through the shared SMTP transport.
 *
 * The sender derivation runs inside the AppKit user scope, so
 * `getExecutionContext()` returns the OBO user whose local-part seeds
 * the address (see {@link deriveSenderAddress}).
 */

import { getExecutionContext } from "@databricks/appkit";
import {
  emailMessageSchema,
  emailResultSchema,
  type EmailMessage,
} from "@dbx-tools/appkit-email-shared";
import { logUtils, stringUtils } from "@dbx-tools/shared";
import { createTool } from "@mastra/core/tools";
import { resolveSenderAddress } from "./sender.js";
import { getEmailRuntime, sendEmail } from "./transport.js";

const log = logUtils.logger("email/tool/send-email");

/** Options accepted by {@link emailTool}. */
export interface EmailToolOptions {
  /**
   * Override the tool id. Defaults to `"send_email"`; the chat UI's
   * approval gate keys off this id, so keep it unless you also teach
   * the client about the new name.
   */
  id?: string;
}

/**
 * Build the approval-gated `send_email` tool. Spread it into the agents
 * that should be able to draft mail; it is intentionally not installed
 * everywhere.
 *
 * @example
 * ```ts
 * import { emailTool } from "@dbx-tools/appkit-email";
 * import { createAgent } from "@dbx-tools/appkit-mastra";
 *
 * const support = createAgent({
 *   instructions: "...",
 *   tools: () => ({ send_email: emailTool() }),
 * });
 * ```
 */
export function emailTool(opts: EmailToolOptions = {}) {
  return createTool({
    id: opts.id ?? "send_email",
    description: stringUtils.toDescription(`
      Send an email on the user's behalf. Pass one or more recipient
      addresses (with optional cc / bcc and file attachments), a subject,
      and a body; the user is prompted to approve the send before it goes
      out (this tool is approval-gated). Use it only when the user
      explicitly asks to send / forward / share something via email -
      never autonomously. Keep subjects short and bodies self-contained:
      the recipient has none of the chat context. Write the body in
      GitHub-Flavored Markdown - headings, lists, and real Markdown
      tables - not ASCII art (no "=====" dividers or space/pipe-drawn
      tables); it is rendered to HTML before sending.
    `),
    inputSchema: emailMessageSchema,
    outputSchema: emailResultSchema,
    requireApproval: true,
    execute: async (input) => {
      const message = input as EmailMessage;
      const { config } = getEmailRuntime();
      const ctx = getExecutionContext();
      const userEmail = "isUserContext" in ctx ? ctx.userEmail : undefined;
      const from = resolveSenderAddress(config, userEmail);
      const result = await sendEmail(message, from);
      log.info("sent", {
        to: result.recipient,
        from: result.from,
        ...(result.messageId ? { messageId: result.messageId } : {}),
      });
      return result;
    },
  });
}
