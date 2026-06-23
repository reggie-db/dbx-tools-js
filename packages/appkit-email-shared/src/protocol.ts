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

/** Schema for the email a model asks to send (the tool input). */
export const emailMessageSchema = z.object({
  to: z
    .string()
    .describe(
      'Single recipient email address (e.g. "alice@example.com"). Comma-separate multiple recipients yourself.',
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
  cc: z.array(z.string()).optional().describe("Optional CC recipient addresses."),
  bcc: z.array(z.string()).optional().describe("Optional BCC recipient addresses."),
});

/** A validated outbound email message. */
export type EmailMessage = z.infer<typeof emailMessageSchema>;

/** Schema for the dispatch result returned to the model after a send. */
export const emailResultSchema = z.object({
  sent: z.boolean().describe("True once the message was handed to the SMTP server."),
  recipient: z.string().describe("Echo of the `to` field for confirmation."),
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
