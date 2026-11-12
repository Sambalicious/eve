import { z } from "zod"

/**
 * Gmail SMTP settings (prd.r4.md AC 7.5, 7.6): read only from the server
 * environment, never from the database or the dashboard. The app password is
 * held in a closure, so JSON, `util.inspect` and logs see only `user` and `to`.
 */
export type SmtpTransportSettings = Readonly<{
  host: string
  port: number
  /** Implicit TLS (smtps). */
  secure: boolean
  /** Test seam only: the in-process fake SMTP server has no TLS. */
  ignoreTLS?: boolean
}>

export const GMAIL_SMTP: SmtpTransportSettings = Object.freeze({ host: "smtp.gmail.com", port: 465, secure: true })

export type MailerConfig = Readonly<{
  /** The Candidate's Gmail address: SMTP sign-in and sender. */
  user: string
  /** The Candidate's notification address. */
  to: string
  /** Origin every email link points to (the dashboard). */
  dashboardOrigin: string
  transport: SmtpTransportSettings
  readAppPassword(): string
}>

export const MAILER_ENV_KEYS = ["GMAIL_SMTP_USER", "GMAIL_SMTP_APP_PASSWORD", "NOTIFY_TO", "PUBLIC_ORIGIN"] as const

const blankIsUnset = (schema: z.ZodType) => z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? undefined : value), schema.optional())

const mailerEnvSchema = z.object({
  GMAIL_SMTP_USER: blankIsUnset(z.email()),
  GMAIL_SMTP_APP_PASSWORD: blankIsUnset(z.string().trim().min(1)),
  NOTIFY_TO: blankIsUnset(z.email()),
  PUBLIC_ORIGIN: blankIsUnset(z.url({ protocol: /^https?$/ })),
})

export function mailerConfig(settings: Readonly<{ user: string; to: string; dashboardOrigin: string; transport: SmtpTransportSettings; appPassword: string }>): MailerConfig {
  const appPassword = settings.appPassword
  const config = { user: settings.user, to: settings.to, dashboardOrigin: settings.dashboardOrigin, transport: settings.transport }
  return Object.freeze({ ...config, readAppPassword: () => appPassword, toJSON: () => config })
}

/**
 * `config: null` turns the sender off (rows stay pending, no crash). With no
 * key set the sender is simply not configured; with some keys set, the bad or
 * missing ones are named (never their values) so the worker can log them.
 */
export function parseMailerEnv(env: Readonly<Record<string, string | undefined>>): Readonly<{ config: MailerConfig | null; missing: readonly string[] }> {
  const anySet = MAILER_ENV_KEYS.slice(0, 3).some((key) => (env[key] ?? "").trim() !== "")
  if (!anySet) return { config: null, missing: [] }
  const raw = Object.fromEntries(MAILER_ENV_KEYS.map((key) => [key, env[key]]))
  const result = mailerEnvSchema.safeParse(raw)
  const invalid = new Set(result.success ? [] : result.error.issues.map((issue) => String(issue.path[0])))
  const missing = MAILER_ENV_KEYS.filter((key) => invalid.has(key) || (env[key] ?? "").trim() === "")
  if (missing.length > 0 || !result.success) return { config: null, missing }
  const data = result.data as Record<(typeof MAILER_ENV_KEYS)[number], string>
  return {
    config: mailerConfig({
      user: data.GMAIL_SMTP_USER,
      to: data.NOTIFY_TO,
      dashboardOrigin: new URL(data.PUBLIC_ORIGIN).origin,
      transport: GMAIL_SMTP,
      // Gmail shows the app password in groups of four characters.
      appPassword: data.GMAIL_SMTP_APP_PASSWORD.replace(/\s+/g, ""),
    }),
    missing: [],
  }
}
