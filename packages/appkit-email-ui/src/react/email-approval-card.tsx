import { Button, cn } from "@databricks/appkit-ui/react";
import type { EmailMessage } from "@dbx-tools/appkit-email-shared";
import { CheckIcon, MailIcon, XIcon } from "lucide-react";
import { Streamdown } from "streamdown";

// Presentational pieces for an outbound email awaiting a human Approve /
// Deny: the field preview (To / Subject / Body, body rendered as
// markdown) and a self-contained approval card wrapping it. State and
// the resolve transport belong to the caller; these components only
// render and report intent.

/** A partially-filled email, as it streams in from a tool call. */
export type EmailDraft = Partial<EmailMessage>;

/** Compact, muted markdown renderer for the email body preview. */
const EmailBody = ({ children }: { children: string }) => (
  <Streamdown
    controls={false}
    className={cn(
      "prose prose-sm dark:prose-invert max-w-none break-words",
      "text-[11px] leading-snug text-muted-foreground",
      "[&_strong]:text-foreground [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_ul]:pl-4 [&_ol]:pl-4",
    )}
  >
    {children}
  </Streamdown>
);

/** Props for {@link EmailPreview}. */
export interface EmailPreviewProps {
  email: EmailDraft;
}

/**
 * Render an email draft as a labelled `To` / `Subject` / `Body` list.
 * The body is markdown so links, lists, and emphasis render rather than
 * showing raw syntax. Fields that are empty are omitted.
 */
export const EmailPreview = ({ email }: EmailPreviewProps) => (
  <dl className="space-y-1 text-xs">
    {email.to && (
      <div className="flex gap-2">
        <dt className="w-16 shrink-0 text-muted-foreground">To</dt>
        <dd className="truncate">{email.to}</dd>
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
  </dl>
);

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
