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
  to: "alice@example.com",
  subject: "Status",
  body: "# Update\n- shipped\n- tested",
});
```

`emailMessageSchema` is the `send_email` tool's input (recipient,
subject, Markdown body, optional `cc` / `bcc`); `emailResultSchema` is
the dispatch result returned to the model.

> Note: array fields intentionally omit `.min()` / `.nonempty()` so the
> generated JSON schema carries no `minItems`, which some Model Serving
> endpoints reject when a tool schema is forwarded to them.
