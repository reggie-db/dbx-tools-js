// React surface for the `send_email` approval flow: a presentational
// preview of the drafted message plus a self-contained Approve / Deny
// card built around it, styled with AppKit tokens.

export type { EmailMessage } from "@dbx-tools/appkit-email-shared";
export {
  EmailApprovalCard,
  EmailPreview,
  type EmailApprovalCardProps,
  type EmailDraft,
  type EmailPreviewProps,
} from "./email-approval-card.js";
