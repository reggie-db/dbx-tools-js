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
agents that should be able to draft mail. The tool is approval-gated,
so the `mastra` plugin must have **storage** enabled (register
`lakebase()` before `mastra()` so it auto-enables, or pass
`storage: true` explicitly). Without storage, app startup fails with a
clear error instead of hanging after the user clicks Approve.

```ts
import { createApp, lakebase } from "@databricks/appkit";
import { email, emailTool } from "@dbx-tools/appkit-email";

await createApp({
  plugins: [
    lakebase(),
    email(), // primes + verifies the shared SMTP transport
    mastra({
      storage: true,
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
  {
    to: ["alice@example.com", "bob@example.com"],
    cc: ["lead@example.com"],
    subject: "Report",
    body: "# Done\nAll good.",
    attachments: [{ filename: "report.pdf", path: "/tmp/report.pdf" }],
  },
  "bot@mail.example.com",
);
```

`to`, `cc`, and `bcc` each accept one or more addresses. Attachments
carry a `filename` plus either inline `content` (with an optional
`encoding` such as `base64`) or a `path` (local file, `data:` URI, or
https URL); the `contentType` is inferred from the filename when
omitted. In outbox mode attachments are listed in the preview header
but not written to disk.

## Configuration

Set on the `email()` plugin config or via environment variables
(explicit config wins, then env). Env names are unprefixed because the
app talks to a single SMTP server.

| Field           | Env                | Notes                                             |
| --------------- | ------------------ | ------------------------------------------------- |
| `smtp.host`     | `SMTP_HOST`        | SMTP server hostname                              |
| `smtp.port`     | `SMTP_PORT`        | default `587`                                     |
| `smtp.secure`   | `SMTP_SECURE`      | TLS-on-connect; default `port === 465`            |
| `smtp.user`     | `SMTP_USER`        | auth username                                     |
| `smtp.password` | `SMTP_PASSWORD`    | auth password / API key                           |
| `domain`         | `EMAIL_DOMAIN`         | builds the sender as `<user-local-part>@<domain>` |
| `from`           | `EMAIL_FROM`           | explicit `From`; skips per-user derivation        |
| `outDir`         | `EMAIL_OUTBOX_DIR`     | outbox directory (file mode)                      |
| `allowedSenders` | `EMAIL_ALLOWED_SENDERS` | allow-list of permitted `From` patterns           |

### SMTP vs. outbox mode

- **SMTP mode** — when `host` + `user` + `password` are all present,
  mail is sent for real. A sender source (`domain` or `from`) is
  required.
- **File / outbox mode** — when SMTP credentials are absent and
  `EMAIL_OUTBOX_MODE=1` is set, each message is written to disk as HTML
  under `outDir` (falling back to `<cwd>/tmp`) instead of being sent.
  Without SMTP credentials and without that flag, config resolution
  throws.

## Sender derivation

By default the local part of the on-behalf-of user's email is re-homed
on `domain`: `alice@databricks.com` with `EMAIL_DOMAIN=mail.example.com`
sends as `alice@mail.example.com`. An explicit `from` / `EMAIL_FROM`
short-circuits this.

## Restricting the sender

Set `allowedSenders` (or `EMAIL_ALLOWED_SENDERS`) to constrain the
`From` address. The value is read flexibly - a single address, a
CSV / semicolon / whitespace-separated string, or an array of any of
those (parsed via the shared `netUtils.parseEmails`) - so `"*@a.com,
*@b.com"`, `["*@a.com", "*@b.com"]`, and `"*@a.com *@b.com"` are all
equivalent. Each entry is one of:

- an exact address - `noreply@company.com`
- a domain wildcard - `*@company.com` (or the bare `company.com`), any
  local part on that domain
- `*` - any address

```ts
email({ allowedSenders: ["*@company.com", "alerts@ops.company.com"] });
```

A resolved or chosen sender that matches no entry is rejected at send
time (`sendEmail` throws). An empty / unset list means no restriction.

### Sender options endpoint

The plugin mounts `GET /api/email/senders` (OBO-scoped). It returns the
concrete `From` choices for the calling user so a compose UI can render a
dropdown:

```jsonc
{
  "senders": ["alice@company.com", "alerts@ops.company.com"],
  "defaultSender": "alice@company.com",
  "restricted": true // false when unrestricted (senders is at most the default)
}
```

Domain wildcards are expanded against the caller's own local part
(`*@company.com` -> `alice@company.com`); exact addresses pass through.
The same payload is available in-process via the plugin's `listSenders()`
export.

## CLI

A small harness at `test/email-cli.test.ts` fires a single message
through the resolved runtime - handy for smoke-testing SMTP creds or the
outbox fallback. Run it from the repo root (`commander` is a root dev
dependency; this package does not depend on it):

```bash
bun packages/appkit-email/test/email-cli.test.ts \
  --to alice@example.com,bob@example.com \
  --subject "Hi" --body "**Hello** from the CLI"

# repeated flags, an attachment, a body file, JSON output
bun packages/appkit-email/test/email-cli.test.ts \
  -t alice@example.com -c team@example.com \
  -s "Report" --body-file ./report.md -a ./report.pdf --json
```

Recipients (`-t/--to`, `-c/--cc`, `-b/--bcc`) accept the same
CSV / repeated-flag / list shapes the plugin does. The `From` comes from
`--from`, else it is derived from `--user` against `EMAIL_DOMAIN` /
`EMAIL_FROM` exactly as a real send would be. The body is read from
`--body`, `--body-file`, or piped stdin.

## See also

- [`@dbx-tools/appkit-email-shared`](../appkit-email-shared) - the
  browser-safe wire contract (`EmailMessage` / `EmailResult`).
- [`@dbx-tools/appkit-email-ui`](../appkit-email-ui) - the React
  approval card for the `send_email` tool plus a standalone compose view.
