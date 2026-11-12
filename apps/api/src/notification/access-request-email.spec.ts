import { describe, expect, it } from "vitest"

import { renderAccessRequest, renderAccessRequestCap } from "./email-content.js"
import { MailerError } from "./mailer.js"

const at = (iso: string) => new Date(iso)
const FOOTER = "You get this because your server's NOTIFY_TO setting points to this address."

describe("access request email (copy-deck r2 email.access_request.*)", () => {
  it("single request: exact plain-text body, subject and Reply-To, no HTML", () => {
    const email = renderAccessRequest({ email: "ada@example.com", requests: [{ note: "Met you at DevFest Lagos", createdAt: at("2026-10-21T09:15:00Z") }] })
    expect(email.subject).toBe("Eve access request from ada@example.com")
    expect(email.replyTo).toBe("ada@example.com")
    expect(email.html).toBeUndefined()
    expect(email.text).toBe(
      [
        "ada@example.com asked for access to Eve.",
        "Note\nMet you at DevFest Lagos",
        "Received 21 Oct 2026, 10:15 WAT",
        "Eve hasn't emailed ada@example.com. Replying to this message goes to them.",
        FOOTER,
      ].join("\n\n") + "\n"
    )
  })

  it("an empty note shows No note.", () => {
    const email = renderAccessRequest({ email: "ada@example.com", requests: [{ note: "", createdAt: at("2026-10-21T09:15:00Z") }] })
    expect(email.text).toContain("Note\nNo note.\n")
  })

  it("coalesced: count line, numbered notes oldest first with WAT times", () => {
    const email = renderAccessRequest({
      email: "ada@example.com",
      requests: [
        { note: "First note", createdAt: at("2026-10-21T13:05:00Z") },
        { note: "", createdAt: at("2026-10-21T15:40:00Z") },
        { note: "Third", createdAt: at("2026-10-22T08:12:00Z") },
      ],
    })
    expect(email.subject).toBe("Eve access request from ada@example.com")
    expect(email.text).toBe(
      [
        "ada@example.com asked for access to Eve.",
        "3 requests from this address in 24 hours. Notes are below, oldest first.",
        "1. 21 Oct 2026, 14:05 WAT\nFirst note",
        "2. 21 Oct 2026, 16:40 WAT\nNo note.",
        "3. 22 Oct 2026, 09:12 WAT\nThird",
        "Eve hasn't emailed ada@example.com. Replying to this message goes to them.",
        FOOTER,
      ].join("\n\n") + "\n"
    )
  })

  it("6 requests: count 6, the first 5 notes, then the capped line", () => {
    const requests = Array.from({ length: 6 }, (_, i) => ({ note: `n${i + 1}`, createdAt: at(`2026-10-21T10:${String(i * 10).padStart(2, "0")}:00Z`) }))
    const email = renderAccessRequest({ email: "ada@example.com", requests })
    expect(email.text).toContain("6 requests from this address in 24 hours.")
    expect(email.text).toMatch(/n1[\s\S]*n2[\s\S]*n3[\s\S]*n4[\s\S]*n5/)
    expect(email.text).not.toContain("n6")
    expect(email.text).toContain("5. 21 Oct 2026, 11:40 WAT\nn5\n\nOnly the first 5 notes are included.\n\nEve hasn't emailed")
  })

  it("keeps markup literally and puts header-looking note text only in the body", () => {
    const email = renderAccessRequest({ email: "ada@example.com", requests: [{ note: "<b>hi</b><script>alert(1)</script>\nBcc: victim@example.net\nSubject: Win", createdAt: at("2026-10-21T09:15:00Z") }] })
    expect(email.text).toContain("<b>hi</b><script>alert(1)</script>\nBcc: victim@example.net\nSubject: Win")
    expect(email.subject).toBe("Eve access request from ada@example.com")
    expect(email.replyTo).toBe("ada@example.com")
  })

  it("defangs links in a note without truncating a 500-code-point note (SEC-602)", () => {
    const email = renderAccessRequest({ email: "ada@example.com", requests: [{ note: "see https://evil.example and www.evil.example", createdAt: at("2026-10-21T09:15:00Z") }] })
    expect(email.text).toContain("see https[:]//evil.example and www[.]evil.example")
    const long = renderAccessRequest({ email: "ada@example.com", requests: [{ note: "😀".repeat(500), createdAt: at("2026-10-21T09:15:00Z") }] })
    expect(long.text).toContain("😀".repeat(500))
    expect(long.text).not.toContain("…")
  })

  it("contains no link and no IP", () => {
    const email = renderAccessRequest({ email: "ada@example.com", requests: [{ note: "Hi", createdAt: at("2026-10-21T09:15:00Z") }] })
    expect(email.text).not.toMatch(/https?:\/\//)
    expect(email.text).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/)
  })

  it.each(["ada@example.com\r\nBcc: victim@example.net", "Ada <ada@example.com>", "ada@example.com, bob@example.com", " ada@example.com"])(
    "refuses to render a stored email that fails the allow-list: %j",
    (bad) => {
      expect(() => renderAccessRequest({ email: bad, requests: [{ note: "", createdAt: at("2026-10-21T09:15:00Z") }] })).toThrow(MailerError)
      try {
        renderAccessRequest({ email: bad, requests: [{ note: "", createdAt: at("2026-10-21T09:15:00Z") }] })
      } catch (error) {
        expect((error as MailerError).code).toBe("send_refused")
      }
    }
  )
})

describe("daily cap email (copy-deck r2 email.access_request_cap.*)", () => {
  it("renders the exact plain-text body, no Reply-To, no HTML, no visitor data", () => {
    const email = renderAccessRequestCap({ day: "2026-10-21", accepted: 50 })
    expect(email.subject).toBe("Eve reached its daily limit of access requests on 21 Oct 2026")
    expect(email.replyTo).toBeUndefined()
    expect(email.html).toBeUndefined()
    expect(email.text).toBe(
      [
        "Eve accepted 50 access requests on 21 Oct 2026 (UTC), the most it takes in one day.",
        'Further requests that day were refused. Those visitors saw "Eve can\'t take more requests today. Try again tomorrow."',
        "The 50 accepted requests are stored and reach you as usual. Refused requests were not stored.",
        "Requests open again at 01:00 WAT (00:00 UTC).",
        "You don't need to do anything.",
        FOOTER,
      ].join("\n\n") + "\n"
    )
    expect(email.text).not.toContain("@")
  })
})
