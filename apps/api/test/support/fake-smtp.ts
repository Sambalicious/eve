import type { AddressInfo } from "node:net"

import { SMTPServer } from "smtp-server"

export type FakeSmtpMode = "accept" | "refuse_auth" | "refuse_send" | "hang"

export type ReceivedEmail = Readonly<{ authUser: string | undefined; from: string | undefined; to: readonly string[]; raw: string }>

/**
 * An in-process SMTP server on 127.0.0.1 (smtp-server, MIT-0). No TLS, no
 * relay: it only records what it receives. Never a real mail server.
 */
export class FakeSmtp {
  readonly received: ReceivedEmail[] = []
  /** Every AUTH attempt, accepted or not, with the password seen. */
  readonly authAttempts: { user: string | undefined; password: string | undefined }[] = []
  mode: FakeSmtpMode = "accept"
  private server: SMTPServer | null = null
  private hung: (() => void)[] = []

  constructor(
    private readonly user: string,
    private readonly password: string
  ) {}

  get port(): number {
    return (this.server!.server.address() as AddressInfo).port
  }

  async start(): Promise<void> {
    this.server = new SMTPServer({
      secure: false,
      disabledCommands: ["STARTTLS"],
      allowInsecureAuth: true,
      authMethods: ["PLAIN", "LOGIN"],
      closeTimeout: 100,
      logger: false,
      onAuth: (auth, _session, callback) => {
        this.authAttempts.push({ user: auth.username, password: auth.password ?? undefined })
        if (this.mode === "refuse_auth" || auth.username !== this.user || auth.password !== this.password) {
          callback(Object.assign(new Error("Username and Password not accepted"), { responseCode: 535 }))
          return
        }
        callback(null, { user: auth.username })
      },
      onData: (stream, session, callback) => {
        const chunks: Buffer[] = []
        stream.on("data", (chunk: Buffer) => chunks.push(chunk))
        stream.on("end", () => {
          if (this.mode === "hang") {
            this.hung.push(() => callback(null))
            return
          }
          if (this.mode === "refuse_send") {
            callback(Object.assign(new Error("Message rejected"), { responseCode: 550 }))
            return
          }
          this.received.push({
            authUser: typeof session.user === "string" ? session.user : undefined,
            from: session.envelope.mailFrom ? session.envelope.mailFrom.address : undefined,
            to: session.envelope.rcptTo.map((rcpt) => rcpt.address),
            raw: Buffer.concat(chunks).toString("utf8"),
          })
          callback(null)
        })
      },
    })
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve))
  }

  reset(mode: FakeSmtpMode = "accept"): void {
    this.received.length = 0
    this.authAttempts.length = 0
    this.releaseHung()
    this.mode = mode
  }

  async stop(): Promise<void> {
    this.releaseHung()
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve())
  }

  private releaseHung(): void {
    for (const release of this.hung.splice(0)) release()
  }
}

/** The decoded plain-text part of a received message (quoted-printable soft breaks removed). */
export function plainText(raw: string): string {
  const match = /Content-Type: text\/plain[^\r\n]*\r\n(?:[^\r\n]+\r\n)*\r\n([\s\S]*?)\r\n--/i.exec(raw)
  const body = match?.[1] ?? raw
  return body
    .replace(/=\r\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}

/** A decoded header value (RFC 2047 encoded words in UTF-8). */
export function header(raw: string, name: string): string | undefined {
  const head = raw.split("\r\n\r\n")[0] ?? ""
  const match = new RegExp(`^${name}: ((?:.*)(?:\\r\\n[ \\t].*)*)`, "im").exec(head)
  if (!match) return undefined
  return match[1]!
    .replace(/\r\n[ \t]/g, " ")
    .replace(/=\?utf-8\?([QB])\?([^?]*)\?=\s?/gi, (_, encoding: string, text: string) =>
      encoding.toUpperCase() === "B"
        ? Buffer.from(text, "base64").toString("utf8")
        : text.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (__, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    )
    .trim()
}
