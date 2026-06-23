// Public surface of @dbx-tools/appkit-email-ui/react.
//
// - `EmailPreview`: the labelled To / Subject / Body card body, with the
//   body rendered as markdown. Drop it into a custom approval card.
// - `EmailApprovalCard`: a self-contained Approve / Deny card around the
//   preview for the `send_email` tool.
// - `EmailMessage` / `EmailDraft`: the email contract types.

export type { EmailMessage } from "@dbx-tools/appkit-email-shared";
export {
  EmailApprovalCard,
  EmailPreview,
  type EmailApprovalCardProps,
  type EmailDraft,
  type EmailPreviewProps,
} from "./email-approval-card.js";
