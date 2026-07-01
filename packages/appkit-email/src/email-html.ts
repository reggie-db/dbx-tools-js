/**
 * Email HTML assembly: render a markdown body into a branded, responsive
 * email layout and inline the stylesheet with `juice`.
 *
 * The layout is the classic email-safe pattern (a centered 600px
 * table-based container with a header band, content card, and optional
 * footer) - the same shape MJML emits, hand-built here because MJML's
 * toolchain pulls fast-moving browser-data deps (caniuse-lite,
 * baseline-browser-mapping) that are awkward to install behind a
 * locked-down registry. Inlining matters because real clients (Gmail,
 * Outlook) strip `<style>` blocks and ignore class selectors; the same
 * renderer feeds both the local outbox preview and the SMTP HTML part,
 * so a browser and an inbox show the same thing.
 */

import { stringUtils } from "@dbx-tools/shared";
import juice from "juice";
import { markdownToHtml } from "./markdown.js";

/** Accent color for the header band and links. */
const ACCENT = "#0b6bcb";

/** Escape HTML-significant characters (re-exported from `@dbx-tools/shared`). */
export const escapeHtml = stringUtils.escapeHtml;

/**
 * Content stylesheet inlined onto the markdown body (juice maps these
 * onto elements). Outer layout styling is written inline directly so it
 * survives even if inlining is skipped; the `@media` rule is preserved
 * by juice for clients that honor it.
 */
const CONTENT_CSS = `
    .email-body { font-size: 15px; line-height: 1.55; color: #1a1a1a; }
    .email-body p { margin: 0 0 1rem; }
    .email-body a { color: ${ACCENT}; }
    .email-body h1, .email-body h2, .email-body h3 { margin: 1.4rem 0 0.6rem; line-height: 1.25; }
    .email-body ul, .email-body ol { margin: 0 0 1rem; padding-left: 1.4rem; }
    .email-body table { border-collapse: collapse; margin: 1rem 0; width: 100%; font-size: 14px; }
    .email-body th, .email-body td { border: 1px solid #d0d7de; padding: 6px 10px; text-align: left; }
    .email-body th { background: #f6f8fa; font-weight: 600; }
    .email-body code { background: #f1f3f5; padding: 2px 5px; border-radius: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
    .email-body pre { background: #f1f3f5; padding: 12px; border-radius: 6px; overflow-x: auto; }
    .email-body pre code { background: none; padding: 0; }
    .email-body blockquote { margin: 1rem 0; padding: 0 1rem; color: #57606a; border-left: 3px solid #d0d7de; }
    .email-body img { max-width: 100%; height: auto; }
    .meta { border-collapse: collapse; font-size: 13px; margin-bottom: 4px; }
    .meta th { text-align: left; padding: 2px 12px 2px 0; vertical-align: top; color: #6b7280; font-weight: 600; white-space: nowrap; }
    .meta td { padding: 2px 0; color: #374151; }
    @media only screen and (max-width: 620px) {
      .container { width: 100% !important; }
      .gutter { padding-left: 20px !important; padding-right: 20px !important; }
    }`;

/** Options for {@link renderEmailHtml}. */
export interface EmailHtmlOptions {
  /** Markdown body. Rendered to HTML, then wrapped in the layout. */
  body: string;
  /** Header-band title and document `<title>`. Defaults to "Message". */
  subject?: string;
  /**
   * Optional `[label, value]` envelope rows shown above the body (used
   * by the outbox preview; omitted for SMTP sends, where the mail client
   * shows the envelope itself).
   */
  headers?: ReadonlyArray<readonly [string, string]>;
  /** Optional small-print footer line. Omitted when unset. */
  footer?: string;
}

/** Render the optional envelope-header table block. */
function metaBlock(headers: EmailHtmlOptions["headers"]): string {
  if (!headers || headers.length === 0) return "";
  const rows = headers
    .map(
      ([label, value]) =>
        `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`,
    )
    .join("");
  return `<table role="presentation" class="meta"><tbody>${rows}</tbody></table>`;
}

/** Render the optional footer row. */
function footerRow(footer: string | undefined): string {
  if (!footer) return "";
  return `
          <tr>
            <td class="gutter" style="padding: 16px 32px; border-top: 1px solid #eaecef; color: #9aa0a6; font-size: 12px; line-height: 1.5;">
              ${escapeHtml(footer)}
            </td>
          </tr>`;
}

/**
 * Render `body` (markdown) into a complete, style-inlined email document
 * using the branded responsive layout.
 */
export function renderEmailHtml(opts: EmailHtmlOptions): string {
  const title = opts.subject?.trim() || "Message";
  const doc = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light only" />
    <title>${escapeHtml(title)}</title>
    <style>${CONTENT_CSS}
    </style>
  </head>
  <body style="margin: 0; padding: 0; background-color: #f4f5f7; -webkit-text-size-adjust: 100%;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f5f7;">
      <tr>
        <td align="center" style="padding: 24px 12px;">
          <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" style="width: 600px; max-width: 100%; background-color: #ffffff; border-radius: 10px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;">
            <tr>
              <td class="gutter" style="padding: 20px 32px; background-color: ${ACCENT};">
                <span style="color: #ffffff; font-size: 18px; font-weight: 700; line-height: 1.3;">${escapeHtml(title)}</span>
              </td>
            </tr>
            <tr>
              <td class="gutter" style="padding: 24px 32px 8px;">
                ${metaBlock(opts.headers)}
                <div class="email-body">${markdownToHtml(opts.body)}</div>
              </td>
            </tr>${footerRow(opts.footer)}
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;
  return juice(doc);
}
