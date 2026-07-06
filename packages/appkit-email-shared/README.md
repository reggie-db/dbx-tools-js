# @dbx-tools/appkit-email-shared

The browser-safe wire-format contract for
[`@dbx-tools/appkit-email`](../appkit-email): the email a model drafts
and the result of dispatching it, as zod schemas plus inferred types.

Pure types and schemas - no `node:*` imports - so the server-side
sender, the `send_email` Mastra tool, and the React approval UI all
validate and type against one definition.

## Install

```bash
npm install @dbx-tools/appkit-email-shared
```

## Usage

```ts
import {
  emailMessageSchema,
  type EmailMessage,
  type EmailResult,
} from "@dbx-tools/appkit-email-shared";

const draft: EmailMessage = emailMessageSchema.parse({
  to: ["alice@example.com", "bob@example.com"],
  subject: "Status",
  body: "# Update\n- shipped\n- tested",
  cc: ["lead@example.com"],
  attachments: [{ filename: "report.pdf", path: "/tmp/report.pdf" }],
});
```

`emailMessageSchema` is the `send_email` tool's input: one or more `to`
recipients, a subject, a Markdown `body`, and optional `cc` / `bcc`
arrays and `attachments`. Each attachment carries a `filename` plus
either inline `content` (with an optional `encoding` such as `base64`)
or a `path` (local file, `data:` URI, or https URL), and an optional
`contentType`. `emailResultSchema` is the dispatch result returned to
the model (`recipient` echoes the comma-joined `to` list).

`emailSendersSchema` / `EmailSenders` type the plugin's `GET /senders`
payload - the permitted `From` options for the current user (`senders`),
the `defaultSender` among them, and whether the list is an enforced
`restricted` allow-list - so a compose UI can populate a sender dropdown.

> Note: array fields intentionally omit `.min()` / `.nonempty()` so the
> generated JSON schema carries no `minItems`, which some Model Serving
> endpoints reject when a tool schema is forwarded to them.
