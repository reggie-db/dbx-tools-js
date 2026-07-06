import { Button } from "@databricks/appkit-ui/react";
import { CheckIcon, MailIcon, XIcon } from "lucide-react";
import { EmailBody } from "./email-body.js";
import { attachmentNames, joinAddresses, type EmailDraft } from "./fields.js";

// Presentational pieces for an outbound email awaiting a human Approve /
// Deny: the field preview (To / Cc / Subject / Body / Files, body
// rendered as markdown) and a self-contained approval card wrapping it.
// State and the resolve transport belong to the caller; these components
// only render and report intent. The editable counterpart is
// `EmailComposeView` in `./email-compose`; both share `./fields` and
// `./email-body`.

export type { EmailDraft } from "./fields.js";

/** Props for {@link EmailPreview}. */
export interface EmailPreviewProps {
  email: EmailDraft;
}

/**
 * Render an email draft as a labelled `To` / `Cc` / `Subject` / `Body` /
 * `Files` list. `to` / `cc` may carry one or more addresses; the body is
 * markdown so links, lists, and emphasis render rather than showing raw
 * syntax. Fields that are empty are omitted.
 */
export const EmailPreview = ({ email }: EmailPreviewProps) => {
  const to = joinAddresses(email.to);
  const cc = joinAddresses(email.cc);
  const attachments = attachmentNames(email.attachments);
  return (
    <dl className="space-y-1 text-xs">
      {to && (
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-muted-foreground">To</dt>
          <dd className="truncate">{to}</dd>
        </div>
      )}
      {cc && (
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-muted-foreground">Cc</dt>
          <dd className="truncate">{cc}</dd>
        </div>
      )}
      {email.subject && (
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-muted-foreground">Subject</dt>
          <dd className="truncate font-medium">{email.subject}</dd>
        </div>
      )}
      {email.body && (
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-muted-foreground">Body</dt>
          <dd className="min-w-0 flex-1 break-words text-foreground">
            <EmailBody>{email.body}</EmailBody>
          </dd>
        </div>
      )}
      {attachments && (
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-muted-foreground">Files</dt>
          <dd className="min-w-0 flex-1 truncate">{attachments}</dd>
        </div>
      )}
    </dl>
  );
};

/** Props for {@link EmailApprovalCard}. */
export interface EmailApprovalCardProps {
  email: EmailDraft;
  /** Called when the user approves the send. */
  onApprove?: () => void | Promise<void>;
  /** Called when the user denies the send. */
  onDeny?: () => void | Promise<void>;
  /** Disable both actions while a decision is in flight. */
  pending?: boolean;
  /** Disable both actions regardless of pending state. */
  disabled?: boolean;
  /** Header label. Defaults to "Approval needed: send email". */
  title?: string;
}

/**
 * A drop-in approval card for the `send_email` tool: the email preview
 * plus Approve / Deny actions. Wire `onApprove` / `onDeny` to whatever
 * resumes the suspended tool call (e.g. the AI-SDK `addToolResult`).
 */
export const EmailApprovalCard = ({
  email,
  onApprove,
  onDeny,
  pending,
  disabled,
  title = "Approval needed: send email",
}: EmailApprovalCardProps) => {
  const blocked = Boolean(disabled) || Boolean(pending);
  return (
    <div className="not-prose my-2 rounded-md border border-warning/40 bg-warning/5 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-warning">
        <MailIcon className="size-3.5" />
        <span>{title}</span>
      </div>
      <EmailPreview email={email} />
      <div className="mt-3 flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="default"
          disabled={blocked || !onApprove}
          onClick={() => onApprove?.()}
        >
          <CheckIcon className="size-3" />
          Approve
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={blocked || !onDeny}
          onClick={() => onDeny?.()}
        >
          <XIcon className="size-3" />
          Deny
        </Button>
      </div>
    </div>
  );
};
