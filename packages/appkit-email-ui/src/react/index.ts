// React surface for `@dbx-tools/appkit-email`: a read-only Approve / Deny
// card for the `send_email` tool's approval flow, the field preview it
// wraps, and a standard editable compose view for use outside a chat
// bubble. All three share `./fields` and `./email-body`, so a drafted
// message renders identically across them. Styled with AppKit tokens.

export type { EmailAttachment, EmailMessage } from "@dbx-tools/appkit-email-shared";
export { EmailBody, type EmailBodyProps } from "./email-body.js";
export type { EmailDraft } from "./fields.js";
export {
  attachmentNames,
  joinAddresses,
  parseAddresses,
} from "./fields.js";
export {
  EmailApprovalCard,
  EmailPreview,
  type EmailApprovalCardProps,
  type EmailPreviewProps,
} from "./email-approval-card.js";
export { EmailComposeView, type EmailComposeProps } from "./email-compose.js";
