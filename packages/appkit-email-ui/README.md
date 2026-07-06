# @dbx-tools/appkit-email-ui

React UI for [`@dbx-tools/appkit-email`](../appkit-email): a
self-contained Approve / Deny card for an outbound email awaiting human
confirmation (the `send_email` tool flow), the field preview it wraps,
and a standard editable compose view for use outside a chat bubble.

The components are presentational - they render the draft (To / Cc /
Subject / Markdown body / attachment filenames) and report intent. `to`
and `cc` may each carry one or more addresses. The approval / send state
and transport belong to the caller (wire them to your AppKit chat
client's tool-approval flow, or your own send action). The preview,
approval card, and compose view all share the address / attachment
helpers and the Markdown body renderer, so a draft looks the same
everywhere.

## Install

```bash
npm install @dbx-tools/appkit-email-ui
```

Peers: `@databricks/appkit-ui`, `react`, `react-dom`.

## Usage

Import the styles once, then render the card when a `send_email` tool
call is pending approval:

```tsx
import "@dbx-tools/appkit-email-ui/styles.css";
import { EmailApprovalCard } from "@dbx-tools/appkit-email-ui/react";

<EmailApprovalCard
  email={draft} // partial EmailMessage as it streams in
  onApprove={() => resolve({ approved: true })}
  onDeny={() => resolve({ approved: false })}
/>;
```

Need only the labelled To / Cc / Subject / Body / Files preview (to
compose your own card)? Use `EmailPreview`:

```tsx
import { EmailPreview } from "@dbx-tools/appkit-email-ui/react";

<EmailPreview email={draft} />;
```

The body is rendered as Markdown so links, lists, and emphasis display
rather than showing raw syntax.

## Compose view

`EmailComposeView` is a standard editable form (To / Cc / Bcc / Subject /
Markdown body with a live preview toggle / file attachments) for sending
mail outside the approval flow. It owns the draft as local state and
hands the assembled `EmailMessage` to `onSend`:

```tsx
import { EmailComposeView } from "@dbx-tools/appkit-email-ui/react";

<EmailComposeView
  senders={senders} // from GET /api/email/senders (optional)
  onSend={(message, from) => sendEmail(message, from)}
  onCancel={() => setComposing(false)}
/>;
```

When `senders` is provided (e.g. fetched from the plugin's `/senders`
route), a `From` dropdown is shown and its value is passed to `onSend`;
omit it to let the server resolve the sender. Attachments are read into
base64 `EmailAttachment`s in the browser.
