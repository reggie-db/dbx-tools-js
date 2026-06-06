/**
 * Mastra tool: `send_email`. Gated behind {@link requireApproval}
 * so the model can call it freely but execution is paused until a
 * human approves via the chat UI.
 *
 * The execute body is a stub - it logs the would-be email to the
 * server console (via `logUtils.logger`) and returns success. Swap
 * in a real SMTP / SES / Resend / Workspace Mail call later by
 * editing the `execute` body; the tool surface and approval gate
 * stay the same.
 *
 * Approval flow (Mastra + AI SDK V5):
 *
 * 1. Model calls the tool with `{ to, subject, body, ... }`.
 * 2. Mastra evaluates `requireApproval` (here always `true`),
 *    pauses the agent loop, and emits a `tool-call-approval`
 *    chunk on the response stream.
 * 3. The chat client renders an approve/deny prompt against the
 *    `state: 'approval-requested'` tool part. On approve, it sends
 *    a `MastraToolApproval` response back; on deny, the tool call
 *    is rejected and the model sees an error.
 * 4. On approve, this `execute` runs and logs the email.
 *
 * The tool is intentionally NOT auto-installed on every agent -
 * email is domain-specific, not infrastructure. Spread it into the
 * specific agents that should be able to draft emails.
 */

import { logUtils, stringUtils } from "@dbx-tools/shared";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const log = logUtils.logger("mastra/tool/send-email");

const emailInputSchema = z.object({
  to: z.string().describe(stringUtils.toDescription`
    Single recipient email address (e.g. "alice@example.com"). For
    multiple recipients, comma-separate them yourself.
  `),
  subject: z.string().describe(stringUtils.toDescription`
    Subject line.
  `),
  body: z.string().describe(stringUtils.toDescription`
    Email body. Plain text or markdown; the renderer downstream
    decides which to honour. Be specific - the recipient may not
    have any context the model has from prior chat turns.
  `),
  cc: z
    .array(z.string())
    .optional()
    .describe(stringUtils.toDescription`
      Optional CC recipients.
    `),
  bcc: z
    .array(z.string())
    .optional()
    .describe(stringUtils.toDescription`
      Optional BCC recipients.
    `),
});

const emailOutputSchema = z.object({
  sent: z.boolean().describe(stringUtils.toDescription`
    True when the email was dispatched. The current implementation
    always returns true after console-logging the would-be email;
    swap in a real provider to make this meaningful.
  `),
  recipient: z.string().describe(stringUtils.toDescription`
    Echo of the \`to\` field for confirmation.
  `),
});

/** Options accepted by {@link buildEmailTool}. */
export interface BuildEmailToolOptions {
  /**
   * Override the tool id. Defaults to `"send_email"`. Useful if a
   * caller wants `send_internal_email` / `send_external_email`
   * variants.
   */
  id?: string;
  /**
   * Replace the default execute body with a real provider call.
   * Receives the validated input and must return `{sent, recipient}`.
   * The console-log default is meant for demos / dev; production
   * deployments should wire SMTP / SES / Resend / Workspace Mail
   * here.
   */
  send?: (input: z.infer<typeof emailInputSchema>) => Promise<void> | void;
}

/**
 * Build the `send_email` tool. Approval-gated by default; the
 * execute body either calls the supplied {@link send} hook or
 * logs the email to the server console as a demo stub.
 *
 * @example
 * ```ts
 * import { buildEmailTool, createAgent, mastra } from "@dbx-tools/appkit-mastra";
 *
 * const support = createAgent({
 *   instructions: "...",
 *   tools(plugins) {
 *     return {
 *       ...(plugins.genie?.toolkit() ?? {}),
 *       send_email: buildEmailTool(),
 *     };
 *   },
 * });
 * ```
 */
export function buildEmailTool(opts: BuildEmailToolOptions = {}) {
  return createTool({
    id: opts.id ?? "send_email",
    description: stringUtils.toDescription`
      Send an email on the user's behalf. Pass a recipient
      address, subject, and body; the user will be prompted to
      approve the send before it goes out (the tool is
      approval-gated). Use this when the user explicitly asks
      to send / forward / share something via email - never
      autonomously. Keep subjects short and bodies focused; the
      recipient may not have any of the chat context.
    `,
    inputSchema: emailInputSchema,
    outputSchema: emailOutputSchema,
    requireApproval: true,
    execute: async (input) => {
      const { to, subject, body, cc, bcc } = input as z.infer<
        typeof emailInputSchema
      >;
      // Default behaviour: dump the email to the server console so
      // demos can see the gate fire end-to-end without a real
      // provider. Replace by passing `opts.send`.
      log.info("send", {
        to,
        ...(cc && cc.length > 0 ? { cc } : {}),
        ...(bcc && bcc.length > 0 ? { bcc } : {}),
        subject,
        bodyLength: body.length,
        body,
      });
      if (opts.send) {
        await opts.send(input as z.infer<typeof emailInputSchema>);
      }
      return { sent: true, recipient: to };
    },
  });
}
