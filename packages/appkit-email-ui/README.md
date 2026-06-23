# @dbx-tools/appkit-email-ui

React UI for the [`@dbx-tools/appkit-email`](../appkit-email)
`send_email` tool: a self-contained Approve / Deny card for an outbound
email awaiting human confirmation, plus the field preview it wraps.

The components are presentational - they render the draft (To / Subject
/ Markdown body) and report Approve / Deny intent. The approval state
and resolve transport belong to the caller (wire them to your AppKit
chat client's tool-approval flow).

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

Need only the labelled To / Subject / Body preview (to compose your own
card)? Use `EmailPreview`:

```tsx
import { EmailPreview } from "@dbx-tools/appkit-email-ui/react";

<EmailPreview email={draft} />;
```

The body is rendered as Markdown so links, lists, and emphasis display
rather than showing raw syntax.
