// Wire-format contract for `@dbx-tools/appkit-email`: the email a model
// drafts and the result of dispatching it. Pure (zod + inferred types,
// no Node-only imports) so the server-side sender, the Mastra tool, and
// the React approval UI all validate / type against one definition.
//
// Array fields intentionally avoid `.min()` / `.nonempty()`: those emit
// `minItems` in the JSON schema, which some Model Serving endpoints
// reject ("array types do not support minItems") when the schema is
// forwarded as a tool definition.

import { z } from "zod";

/** Schema for a single file attached to an outbound email. */
export const emailAttachmentSchema = z.object({
  filename: z
    .string()
    .describe('File name shown to the recipient (e.g. "report.pdf").'),
  content: z
    .string()
    .optional()
    .describe(
      "Inline file content as a string. For binary data set `encoding` (e.g. \"base64\"). Provide this or `path`, not both.",
    ),
  encoding: z
    .string()
    .optional()
    .describe(
      'Encoding of `content` (e.g. "base64", "utf-8", "hex"). Defaults to utf-8 when omitted.',
    ),
  path: z
    .string()
    .optional()
    .describe(
      "Read the content from here instead of inlining it: a local file path, a data: URI, or an https URL. Provide this or `content`, not both.",
    ),
  contentType: z
    .string()
    .optional()
    .describe(
      'MIME type override (e.g. "application/pdf"). Inferred from the filename when omitted.',
    ),
});

/** A single file attached to an {@link EmailMessage}. */
export type EmailAttachment = z.infer<typeof emailAttachmentSchema>;

/** Schema for the email a model asks to send (the tool input). */
export const emailMessageSchema = z.object({
  to: z
    .array(z.string())
    .describe(
      'One or more recipient email addresses (e.g. ["alice@example.com", "bob@example.com"]). Provide at least one.',
    ),
  subject: z.string().describe("Subject line. Keep it short and specific."),
  body: z
    .string()
    .describe(
      [
        "Email body in GitHub-Flavored Markdown; it is rendered to HTML before sending.",
        "Use real Markdown structure: '#'/'##' headings, '-' or '1.' lists, **bold**/_italic_, '>' blockquotes, and fenced ``` code blocks.",
        "For tabular data, emit a real Markdown table: a header row, then a '| --- | --- |' separator row, then one '| ... |' row per record.",
        "Do NOT format with ASCII art: no '=====' or '-----' divider lines, and never hand-draw tables or bar charts with spaces, pipes, or '#'. Use the Markdown constructs above instead.",
        "Be self-contained: the recipient has none of the chat context.",
      ].join(" "),
    ),
  cc: z
    .array(z.string())
    .optional()
    .describe("Optional CC recipient addresses (one or more)."),
  bcc: z
    .array(z.string())
    .optional()
    .describe("Optional BCC recipient addresses (one or more)."),
  attachments: z
    .array(emailAttachmentSchema)
    .optional()
    .describe("Optional file attachments to include with the message."),
});

/** A validated outbound email message. */
export type EmailMessage = z.infer<typeof emailMessageSchema>;

/** Schema for the dispatch result returned to the model after a send. */
export const emailResultSchema = z.object({
  sent: z.boolean().describe("True once the message was handed to the SMTP server."),
  recipient: z
    .string()
    .describe("Echo of the `to` recipients (comma-joined) for confirmation."),
  from: z
    .string()
    .describe("The resolved sender address the message was actually sent from."),
  messageId: z
    .string()
    .optional()
    .describe("SMTP message id assigned by the server, when one was returned."),
});

/** The outcome of dispatching an {@link EmailMessage}. */
export type EmailResult = z.infer<typeof emailResultSchema>;

/**
 * Schema for the sender options a UI can offer for the `From` address -
 * the payload of the plugin's `GET /senders` route. When the plugin
 * configures a sender allow-list, `senders` holds the concrete addresses
 * the current user may send as (domain wildcards expanded against the
 * user's local part) and `restricted` is true; a picker should require a
 * choice from the list. When unrestricted, `senders` holds at most the
 * single default address (if one can be resolved) and `restricted` is
 * false, so a UI may allow free entry.
 */
export const emailSendersSchema = z.object({
  senders: z
    .array(z.string())
    .describe("Permitted sender addresses to offer as `From` choices."),
  defaultSender: z
    .string()
    .optional()
    .describe("The address a send uses by default (first `senders` entry, if any)."),
  restricted: z
    .boolean()
    .describe("True when `senders` is an enforced allow-list rather than a hint."),
});

/** Sender options for a `From` picker (see {@link emailSendersSchema}). */
export type EmailSenders = z.infer<typeof emailSendersSchema>;
