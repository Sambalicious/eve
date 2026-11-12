import { createTransport } from "nodemailer"

import type { NotificationError } from "../db/schema.js"
import type { RenderedEmail } from "./email-content.js"
import type { MailerConfig } from "./mailer-config.js"

/** Architecture r1: the sender talks to email through this port only. */
export interface Mailer {
  /** Resolves when the server accepted the message; throws `MailerError` otherwise. */
  send(email: RenderedEmail): Promise<void>
}

export const MAILER = Symbol("MAILER")

/**
 * A failed send, reduced to a code. The message is fixed text: SMTP replies and
 * library errors can echo credentials or addresses, so they are never kept
 * (AC 7.7, notifications.feature "The app password never appears").
 */
export class MailerError extends Error {
  constructor(readonly code: Exclude<NotificationError, "interrupted">) {
    super(`email send failed: ${code}`)
    this.name = "MailerError"
  }
}

/** Fixed per-step timeouts so a stalled server can't hold the sender (notifications.feature: "times out"). */
export const SMTP_TIMEOUTS = { connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000 } as const

/** Maps a nodemailer failure to a code, reading only its `code` and `responseCode`. */
export function classifySmtpError(error: unknown): MailerError["code"] {
  const fields = typeof error === "object" && error !== null ? (error as { code?: unknown; responseCode?: unknown }) : {}
  if (fields.code === "EAUTH") return "auth_failed"
  if (fields.code === "ETIMEDOUT") return "timeout"
  if (fields.code === "EENVELOPE" || fields.code === "EMESSAGE" || (typeof fields.responseCode === "number" && fields.responseCode >= 400)) return "send_refused"
  if (fields.code === "ECONNECTION" || fields.code === "ESOCKET" || fields.code === "EDNS" || fields.code === "ETLS") return "connection_failed"
  return "unknown"
}

/**
 * Gmail SMTP with an app password (AC 7.5): signs in as the Candidate's Gmail
 * account, sends from it with the From name "Eve", to the notification address.
 * One connection per message, no pooling; nodemailer's own logger is off.
 */
export class GmailSmtpMailer implements Mailer {
  constructor(
    private readonly config: MailerConfig,
    private readonly timeouts: Readonly<{ connectionTimeout: number; greetingTimeout: number; socketTimeout: number }> = SMTP_TIMEOUTS
  ) {}

  async send(email: RenderedEmail): Promise<void> {
    const transport = createTransport({
      host: this.config.transport.host,
      port: this.config.transport.port,
      secure: this.config.transport.secure,
      ignoreTLS: this.config.transport.ignoreTLS ?? false,
      requireTLS: !this.config.transport.ignoreTLS,
      auth: { user: this.config.user, pass: this.config.readAppPassword() },
      logger: false,
      debug: false,
      ...this.timeouts,
    })
    try {
      await transport.sendMail({
        from: { name: "Eve", address: this.config.user },
        to: this.config.to,
        subject: email.subject,
        text: email.text,
        ...(email.html === undefined ? {} : { html: email.html }),
        // EPIC-0003: the visitor's allow-listed address; `to` is always NOTIFY_TO.
        ...(email.replyTo === undefined ? {} : { replyTo: email.replyTo }),
        disableFileAccess: true,
        disableUrlAccess: true,
      })
    } catch (error) {
      throw new MailerError(classifySmtpError(error))
    } finally {
      transport.close()
    }
  }
}

/** The sender with no Gmail settings: never called, because the sender is off. */
export const unconfiguredMailer: Mailer = {
  send: () => Promise.reject(new MailerError("unknown")),
}
