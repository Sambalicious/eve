import { inspect } from "node:util"

import { describe, expect, it } from "vitest"

import { GMAIL_SMTP, parseMailerEnv } from "./mailer-config.js"

const FULL = {
  GMAIL_SMTP_USER: "ada.okafor@gmail.com",
  GMAIL_SMTP_APP_PASSWORD: "abcd efgh ijkl mnop",
  NOTIFY_TO: "ada.okafor@gmail.com",
  PUBLIC_ORIGIN: "https://jobs.example.com/",
}

describe("parseMailerEnv (AC 7.5, 7.6)", () => {
  it("is off with no keys, and names nothing missing", () => {
    expect(parseMailerEnv({})).toEqual({ config: null, missing: [] })
  })

  it("is off when any key is missing or blank, and names the keys only", () => {
    const result = parseMailerEnv({ ...FULL, GMAIL_SMTP_APP_PASSWORD: " " })
    expect(result.config).toBeNull()
    expect(result.missing).toEqual(["GMAIL_SMTP_APP_PASSWORD"])
    expect(JSON.stringify(result)).not.toContain("ada.okafor")
  })

  it("refuses an address that isn't an email, and an origin that isn't http(s)", () => {
    expect(parseMailerEnv({ ...FULL, NOTIFY_TO: "not-an-email", PUBLIC_ORIGIN: "file:///x" }).missing).toEqual(["NOTIFY_TO", "PUBLIC_ORIGIN"])
  })

  it("signs in to Gmail SMTP over implicit TLS as the sender, and sends to the notification address", () => {
    const { config } = parseMailerEnv(FULL)
    expect(config).not.toBeNull()
    expect(config!.user).toBe("ada.okafor@gmail.com")
    expect(config!.to).toBe("ada.okafor@gmail.com")
    expect(config!.dashboardOrigin).toBe("https://jobs.example.com")
    expect(config!.transport).toEqual(GMAIL_SMTP)
    expect(GMAIL_SMTP).toMatchObject({ host: "smtp.gmail.com", port: 465, secure: true })
    // Gmail shows app passwords in groups of four; spaces are not part of it.
    expect(config!.readAppPassword()).toBe("abcdefghijklmnop")
  })

  it("never reveals the app password through JSON, inspect or string conversion", () => {
    const { config } = parseMailerEnv(FULL)
    for (const shown of [JSON.stringify(config), inspect(config, { depth: 5, showHidden: true }), String(config), `${JSON.stringify({ config })}`]) {
      expect(shown).not.toContain("abcd efgh ijkl mnop")
      expect(shown).not.toContain("abcdefghijklmnop")
    }
  })
})
