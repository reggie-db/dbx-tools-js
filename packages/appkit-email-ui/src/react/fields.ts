// Shared, presentational helpers for the email field UIs (the read-only
// approval preview and the editable compose view). Keeping the address
// and attachment formatting here lets both surfaces agree on how a draft
// is displayed and how free-text address input is normalized.

import type { EmailAttachment, EmailMessage } from "@dbx-tools/appkit-email-shared";
import { netUtils } from "@dbx-tools/shared";

/** A partially-filled email, as it streams in from a tool call or a form. */
export type EmailDraft = Partial<EmailMessage>;

/** Render an address array as a single comma-separated display string. */
export const joinAddresses = (addresses: string[] | undefined): string =>
  (addresses ?? []).map((a) => a.trim()).filter(Boolean).join(", ");

/**
 * Split a free-text address field (comma / semicolon / whitespace
 * separated) into a trimmed, de-duplicated address array - the inverse
 * of {@link joinAddresses} for compose inputs. Delegates to the shared
 * {@link netUtils.parseEmails} so the UI reads addresses the same way the
 * server does.
 */
export const parseAddresses = (raw: string): string[] => netUtils.parseEmails(raw);

/** Comma-separated list of attachment filenames for a compact display. */
export const attachmentNames = (
  attachments: EmailAttachment[] | undefined,
): string =>
  (attachments ?? []).map((a) => a.filename).filter(Boolean).join(", ");
