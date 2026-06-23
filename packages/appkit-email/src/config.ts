/**
 * SMTP configuration for the email plugin: the typed
 * {@link EmailPluginConfig} (the plugin's slice of AppKit config), the
 * JSON Schema the manifest publishes for it, and {@link resolveEmailConfig}
 * which layers that config over environment defaults into the concrete
 * {@link ResolvedEmailConfig} the runtime needs.
 *
 * Two modes fall out of the resolution. When SMTP credentials (host +
 * user + password) are present it resolves to `mode: "smtp"` and mail
 * is sent for real. When they are absent it resolves to `mode: "file"`
 * (an "outbox") and each message is written to disk as HTML instead of
 * sent - zero-config local testing of the approval flow.
 *
 * Precedence per field: explicit plugin config wins, then the matching
 * environment variable. Env names are unprefixed because the app talks
 * to a single SMTP server (e.g. SMTP2GO): `SMTP_HOST`, `SMTP_PORT`,
 * `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, plus `EMAIL_DOMAIN` for
 * the derived sender's domain, `EMAIL_FROM` for an explicit override,
 * and `EMAIL_OUTBOX_DIR` for the outbox directory.
 */

import type { BasePluginConfig } from "@databricks/appkit";
import type { JSONSchema7 } from "json-schema";
import { resolve } from "node:path";

/** SMTP connection + credentials. All fields fall back to env when unset. */
export interface SmtpConfig {
  /** SMTP server hostname (`SMTP_HOST`). */
  host?: string;
  /** SMTP server port (`SMTP_PORT`). Defaults to 587. */
  port?: number;
  /** Use a TLS-on-connect socket (`SMTP_SECURE`). Defaults to `port === 465`. */
  secure?: boolean;
  /** SMTP auth username (`SMTP_USER`). */
  user?: string;
  /** SMTP auth password / API key (`SMTP_PASSWORD`). */
  password?: string;
}

/** AppKit config accepted by the email plugin. */
export interface EmailPluginConfig extends BasePluginConfig {
  /** SMTP connection + credentials. Omit to run in file/outbox mode. */
  smtp?: SmtpConfig;
  /**
   * Domain used to build the sender address from the on-behalf-of user
   * (`<local-part>@<domain>`). Falls back to `EMAIL_DOMAIN`. Required in
   * SMTP mode unless {@link from} is set; optional in file mode (the
   * outbox falls back to the user's own email address).
   */
  domain?: string;
  /**
   * Explicit `From` address. When set, the sender is used verbatim and
   * the per-user derivation is skipped. Falls back to `EMAIL_FROM`.
   */
  from?: string;
  /**
   * Directory for the file/outbox fallback. Falls back to
   * `EMAIL_OUTBOX_DIR`, then `<cwd>/tmp`. Only used when SMTP
   * credentials are absent.
   */
  outDir?: string;
}

/** Sender source shared by both resolved modes. */
interface ResolvedSender {
  /** Sender domain; present whenever {@link from} is absent. */
  domain?: string;
  /** Explicit sender override; present skips per-user derivation. */
  from?: string;
}

/** Resolved config for real SMTP delivery. */
export interface ResolvedSmtpConfig extends ResolvedSender {
  mode: "smtp";
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
}

/** Resolved config for the file/outbox fallback (no SMTP credentials). */
export interface ResolvedFileConfig extends ResolvedSender {
  mode: "file";
  /** Absolute directory messages are written under. */
  outDir: string;
}

/** Concrete, validated config the runtime dispatches through. */
export type ResolvedEmailConfig = ResolvedSmtpConfig | ResolvedFileConfig;

/** JSON Schema published on the manifest's `config.schema`. */
export const EMAIL_CONFIG_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {
    smtp: {
      type: "object",
      description: "SMTP connection and credentials (env fallbacks: SMTP_*).",
      properties: {
        host: { type: "string", description: "SMTP server hostname." },
        port: { type: "number", description: "SMTP server port (default 587)." },
        secure: {
          type: "boolean",
          description: "TLS-on-connect socket (default: port === 465).",
        },
        user: { type: "string", description: "SMTP auth username." },
        password: { type: "string", description: "SMTP auth password / API key." },
      },
    },
    domain: {
      type: "string",
      description:
        "Domain for the derived sender address (<user-local-part>@<domain>). Falls back to EMAIL_DOMAIN.",
    },
    from: {
      type: "string",
      description:
        "Explicit From address; skips per-user derivation. Falls back to EMAIL_FROM.",
    },
    outDir: {
      type: "string",
      description:
        "Directory for the file/outbox fallback when SMTP is unconfigured. Falls back to EMAIL_OUTBOX_DIR, then <cwd>/tmp.",
    },
  },
};

/** Parse the `SMTP_SECURE` env / config flag, defaulting to `port === 465`. */
function resolveSecure(flag: boolean | undefined, port: number): boolean {
  if (typeof flag === "boolean") return flag;
  const env = process.env["SMTP_SECURE"];
  if (env !== undefined) return /^(1|true|yes)$/i.test(env.trim());
  return port === 465;
}

/**
 * Resolve plugin config over environment defaults.
 *
 * When SMTP host + user + password are all present, returns `mode:
 * "smtp"` for real delivery (and throws if no sender source - domain or
 * from - is configured, since SMTP can't derive one from nothing).
 * Otherwise returns `mode: "file"` so the runtime writes messages to the
 * outbox directory for local testing; in that mode a sender source is
 * optional (the outbox falls back to the OBO user's own address).
 */
export function resolveEmailConfig(config: EmailPluginConfig = {}): ResolvedEmailConfig {
  const smtp = config.smtp ?? {};
  const host = smtp.host ?? process.env["SMTP_HOST"];
  const user = smtp.user ?? process.env["SMTP_USER"];
  const pass = smtp.password ?? process.env["SMTP_PASSWORD"];
  const domain = config.domain ?? process.env["EMAIL_DOMAIN"];
  const from = config.from ?? process.env["EMAIL_FROM"];
  const sender: ResolvedSender = { ...(domain ? { domain } : {}), ...(from ? { from } : {}) };

  if (host && user && pass) {
    if (!domain && !from) {
      throw new Error(
        "email: SMTP is configured but no sender source - set EMAIL_DOMAIN (to derive <user>@<domain>) or EMAIL_FROM (a fixed address)",
      );
    }
    const portRaw = smtp.port ?? Number(process.env["SMTP_PORT"]);
    const port = Number.isFinite(portRaw) && portRaw ? Number(portRaw) : 587;
    return {
      mode: "smtp",
      host,
      port,
      secure: resolveSecure(smtp.secure, port),
      auth: { user, pass },
      ...sender,
    };
  }

  const outDir = resolve(
    config.outDir ?? process.env["EMAIL_OUTBOX_DIR"] ?? resolve(process.cwd(), "tmp"),
  );
  return { mode: "file", outDir, ...sender };
}
