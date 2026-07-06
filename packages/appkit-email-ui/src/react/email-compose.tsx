import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  cn,
} from "@databricks/appkit-ui/react";
import type { EmailAttachment, EmailMessage } from "@dbx-tools/appkit-email-shared";
import { EyeIcon, PaperclipIcon, PencilIcon, SendIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { EmailBody } from "./email-body.js";
import { joinAddresses, parseAddresses, type EmailDraft } from "./fields.js";

// A standard, editable email compose form usable outside a chat bubble
// (a settings page, a standalone "send" view, etc.). It shares the
// address / attachment helpers (`./fields`) and the Markdown body
// renderer (`./email-body`) with the read-only `EmailPreview`, so the
// two surfaces stay visually and semantically in sync.
//
// The component is presentational and self-contained: it owns the draft
// as local state (seeded from `defaultValue`), emits changes via
// `onChange`, and hands the assembled `EmailMessage` (plus the chosen
// `From`, when a sender list is provided) to `onSend`. Wiring the actual
// dispatch - and fetching the `senders` list from the plugin's
// `GET /senders` route - is the caller's job.

/** Props for {@link EmailComposeView}. */
export interface EmailComposeProps {
  /** Initial draft to seed the form (uncontrolled thereafter). */
  defaultValue?: EmailDraft;
  /** Called on every edit with the current assembled message. */
  onChange?: (message: EmailMessage) => void;
  /** Called when the user submits; receives the message and chosen `From`. */
  onSend?: (message: EmailMessage, from?: string) => void | Promise<void>;
  /** Called when the user cancels. Omit to hide the Cancel button. */
  onCancel?: () => void;
  /**
   * Permitted `From` addresses (e.g. from the plugin's `GET /senders`).
   * When non-empty a `From` dropdown is shown and its value is passed to
   * `onSend`; omit for a server-resolved sender (no dropdown).
   */
  senders?: string[];
  /** Preselected `From`. Defaults to the first {@link senders} entry. */
  defaultFrom?: string;
  /** Disable actions while a send is in flight. */
  pending?: boolean;
  /** Disable all actions regardless of pending state. */
  disabled?: boolean;
  /** Show the attachment control. Defaults to `true`. */
  allowAttachments?: boolean;
  /** Card header label. Defaults to "New message". */
  title?: string;
  /** Submit button label. Defaults to "Send". */
  sendLabel?: string;
}

/** Read a `File` into a base64 {@link EmailAttachment}. */
async function fileToAttachment(file: File): Promise<EmailAttachment> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  // A data URL is `data:<mime>;base64,<payload>`; keep only the payload.
  const content = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return {
    filename: file.name,
    content,
    encoding: "base64",
    ...(file.type ? { contentType: file.type } : {}),
  };
}

/** A labelled field row: label above its control. */
const Field = ({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) => (
  <div className="grid gap-1.5">
    <Label htmlFor={htmlFor} className="text-xs text-muted-foreground">
      {label}
    </Label>
    {children}
  </div>
);

/**
 * A standard, editable email compose form. Reuses the shared field and
 * body helpers so a drafted message renders the same here as in the
 * read-only approval preview.
 */
export const EmailComposeView = ({
  defaultValue,
  onChange,
  onSend,
  onCancel,
  senders,
  defaultFrom,
  pending,
  disabled,
  allowAttachments = true,
  title = "New message",
  sendLabel = "Send",
}: EmailComposeProps) => {
  const [to, setTo] = useState(joinAddresses(defaultValue?.to));
  const [cc, setCc] = useState(joinAddresses(defaultValue?.cc));
  const [bcc, setBcc] = useState(joinAddresses(defaultValue?.bcc));
  const [subject, setSubject] = useState(defaultValue?.subject ?? "");
  const [body, setBody] = useState(defaultValue?.body ?? "");
  const [attachments, setAttachments] = useState<EmailAttachment[]>(
    defaultValue?.attachments ?? [],
  );
  const [from, setFrom] = useState(defaultFrom ?? senders?.[0] ?? "");
  const [showPreview, setShowPreview] = useState(false);

  const fileInput = useRef<HTMLInputElement>(null);
  const ids = useId();
  const fieldId = (name: string) => `${ids}-${name}`;

  const hasSenderPicker = Boolean(senders && senders.length > 0);
  const blocked = Boolean(disabled) || Boolean(pending);
  const recipients = parseAddresses(to);
  const canSend = recipients.length > 0 && Boolean(onSend) && !blocked;

  // Assemble the current draft into a wire-format message, omitting empty
  // optional fields so the payload stays minimal.
  const buildMessage = useCallback((): EmailMessage => {
    const ccList = parseAddresses(cc);
    const bccList = parseAddresses(bcc);
    return {
      to: parseAddresses(to),
      subject,
      body,
      ...(ccList.length ? { cc: ccList } : {}),
      ...(bccList.length ? { bcc: bccList } : {}),
      ...(attachments.length ? { attachments } : {}),
    };
  }, [to, cc, bcc, subject, body, attachments]);

  useEffect(() => {
    onChange?.(buildMessage());
  }, [buildMessage, onChange]);

  const addFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const read = await Promise.all([...files].map(fileToAttachment));
    setAttachments((prev) => [...prev, ...read]);
  }, []);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const submit = useCallback(() => {
    if (!canSend) return;
    void onSend?.(buildMessage(), hasSenderPicker ? from : undefined);
  }, [canSend, onSend, buildMessage, hasSenderPicker, from]);

  return (
    <div className="not-prose flex flex-col gap-3 rounded-md border border-border bg-card p-4 text-sm">
      <div className="text-sm font-medium">{title}</div>

      {hasSenderPicker && (
        <Field label="From" htmlFor={fieldId("from")}>
          <Select value={from} onValueChange={setFrom} disabled={blocked}>
            <SelectTrigger id={fieldId("from")} className="h-8">
              <SelectValue placeholder="Select a sender" />
            </SelectTrigger>
            <SelectContent>
              {senders?.map((address) => (
                <SelectItem key={address} value={address}>
                  {address}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}

      <Field label="To" htmlFor={fieldId("to")}>
        <Input
          id={fieldId("to")}
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="alice@example.com, bob@example.com"
          disabled={blocked}
          className="h-8"
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Cc" htmlFor={fieldId("cc")}>
          <Input
            id={fieldId("cc")}
            value={cc}
            onChange={(e) => setCc(e.target.value)}
            placeholder="Optional"
            disabled={blocked}
            className="h-8"
          />
        </Field>
        <Field label="Bcc" htmlFor={fieldId("bcc")}>
          <Input
            id={fieldId("bcc")}
            value={bcc}
            onChange={(e) => setBcc(e.target.value)}
            placeholder="Optional"
            disabled={blocked}
            className="h-8"
          />
        </Field>
      </div>

      <Field label="Subject" htmlFor={fieldId("subject")}>
        <Input
          id={fieldId("subject")}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Subject"
          disabled={blocked}
          className="h-8"
        />
      </Field>

      <div className="grid gap-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor={fieldId("body")} className="text-xs text-muted-foreground">
            Body (Markdown)
          </Label>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            disabled={!body}
            onClick={() => setShowPreview((v) => !v)}
          >
            {showPreview ? (
              <>
                <PencilIcon className="size-3" /> Edit
              </>
            ) : (
              <>
                <EyeIcon className="size-3" /> Preview
              </>
            )}
          </Button>
        </div>
        {showPreview ? (
          <div className="min-h-32 rounded-md border border-border bg-background p-3">
            <EmailBody>{body || "_Nothing to preview yet._"}</EmailBody>
          </div>
        ) : (
          <Textarea
            id={fieldId("body")}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Write your message in Markdown..."
            disabled={blocked}
            className="min-h-32 font-mono text-xs"
          />
        )}
      </div>

      {allowAttachments && (
        <div className="grid gap-1.5">
          <div className="flex items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                void addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7"
              disabled={blocked}
              onClick={() => fileInput.current?.click()}
            >
              <PaperclipIcon className="size-3" /> Attach files
            </Button>
          </div>
          {attachments.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {attachments.map((att, index) => (
                <li
                  key={`${att.filename}-${index}`}
                  className="flex items-center gap-1 rounded bg-muted px-2 py-1 text-xs"
                >
                  <span className="max-w-40 truncate">{att.filename}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${att.filename}`}
                    className={cn(
                      "text-muted-foreground hover:text-foreground",
                      blocked && "pointer-events-none opacity-50",
                    )}
                    onClick={() => removeAttachment(index)}
                  >
                    <XIcon className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-1 flex items-center gap-2">
        <Button type="button" size="sm" disabled={!canSend} onClick={submit}>
          <SendIcon className="size-3" />
          {pending ? "Sending..." : sendLabel}
        </Button>
        {onCancel && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={blocked}
            onClick={() => onCancel()}
          >
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
};
