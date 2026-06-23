# @dbx-tools/appkit-email

An AppKit plugin and approval-gated Mastra tool for sending outbound
email over SMTP, with the sender derived from the on-behalf-of user.

A model can draft a message freely, but nothing leaves the building
until a human clicks **Approve** in the chat UI. On approval the `From`
address is resolved (an explicit `from`, or the OBO user's local part
re-homed on your sending domain) and the message is dispatched through a
shared SMTP transport. Bodies are written in Markdown and rendered to
HTML before sending.

## Install

Already wired in this monorepo via `workspace:*`. Standalone:

```bash
npm install @dbx-tools/appkit-email
```

## Usage

Register the `email` plugin (validates SMTP config and verifies
connectivity at startup) and spread the `send_email` tool into the
agents that should be able to draft mail:

```ts
import { createApp } from "@databricks/appkit";
import { email, emailTool } from "@dbx-tools/appkit-email";

await createApp({
  plugins: [
    email(), // primes + verifies the shared SMTP transport
    mastra({
      agents: {
        support: createAgent({
          instructions: "...",
          tools: () => ({ send_email: emailTool() }),
        }),
      },
    }),
  ],
});
```

For a non-agent send (bypassing the approval flow), use the plugin's
export or the bare `sendEmail`:

```ts
import { sendEmail } from "@dbx-tools/appkit-email";

await sendEmail(
  { to: "alice@example.com", subject: "Report", body: "# Done\nAll good." },
  "bot@mail.example.com",
);
```

## Configuration

Set on the `email()` plugin config or via environment variables
(explicit config wins, then env). Env names are unprefixed because the
app talks to a single SMTP server.

| Field | Env | Notes |
| --- | --- | --- |
| `smtp.host` | `SMTP_HOST` | SMTP server hostname |
| `smtp.port` | `SMTP_PORT` | default `587` |
| `smtp.secure` | `SMTP_SECURE` | TLS-on-connect; default `port === 465` |
| `smtp.user` | `SMTP_USER` | auth username |
| `smtp.password` | `SMTP_PASSWORD` | auth password / API key |
| `domain` | `EMAIL_DOMAIN` | builds the sender as `<user-local-part>@<domain>` |
| `from` | `EMAIL_FROM` | explicit `From`; skips per-user derivation |
| `outDir` | `EMAIL_OUTBOX_DIR` | outbox directory (file mode) |

### SMTP vs. outbox mode

- **SMTP mode** — when `host` + `user` + `password` are all present,
  mail is sent for real. A sender source (`domain` or `from`) is
  required.
- **File / outbox mode** — when SMTP credentials are absent, each
  message is written to disk as HTML under `outDir` (falling back to
  `<cwd>/tmp`) instead of being sent. Zero-config local testing of the
  approval flow; the sender falls back to the OBO user's own address.

## Sender derivation

By default the local part of the on-behalf-of user's email is re-homed
on `domain`: `alice@databricks.com` with `EMAIL_DOMAIN=mail.example.com`
sends as `alice@mail.example.com`. An explicit `from` / `EMAIL_FROM`
short-circuits this.

## See also

- [`@dbx-tools/appkit-email-shared`](../appkit-email-shared) - the
  browser-safe wire contract (`EmailMessage` / `EmailResult`).
- [`@dbx-tools/appkit-email-ui`](../appkit-email-ui) - the React
  approval card for the `send_email` tool.
