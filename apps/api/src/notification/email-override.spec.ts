import { describe, expect, it } from "vitest"

import { renderAccessRequest, renderAccessRequestCap, renderBlocked, renderConfirmed, renderCostPause, renderDailySummary } from "./email-content.js"
import { droppedReason } from "./notification-sender.js"

/**
 * v1.24.0 (AA-4.6, AA-4.7): the Override fact line C-AA-32 in E1 and E2, the
 * marker C-AA-34 on daily-summary lines, and the dropped-override reason C-AA-35.
 * apply-anyway.feature:829, :844, :857, :865, :877.
 */
const BASE = "https://dashboard.test"
const ID = "6f1c2a4e-0000-4000-8000-000000000001"
const confirmed = {
  applicationId: ID,
  role: "Senior Frontend Engineer",
  company: "Acme Payments",
  requisitionId: "R-4312",
  submittedAt: new Date("2026-10-29T09:15:00Z"),
  evidence: { kind: "confirmation_page", text: null },
  sentAs: "automatic",
  employmentType: null,
  unverified: [],
  coverLetterStatus: "uploaded",
  automaticToday: 1,
} as const
const blocked = { applicationId: ID, role: "Frontend Lead", company: "Acme Payments", requisitionId: "R-4312", reason: "missing_approved_answer", subReason: null, detail: null } as const
const lines = (text: string) => text.split(/\r?\n/)

describe("E1 and E2 Override fact line (C-AA-32)", () => {
  it.each([
    ["weak core Match"],
    ["no core responsibilities found"],
    ['uncovered mandatory prerequisite "Active security clearance"'],
  ])("Confirmed: after Sent:, %s, in the HTML and text parts", (reason) => {
    const email = renderConfirmed({ ...confirmed, override: { reason } }, BASE)
    const text = lines(email.text)
    const sent = text.indexOf("Sent: Automatically")
    expect(text[sent + 1]).toBe(`Override: you chose to apply despite ${reason}`)
    expect(email.html).toContain(`Override: you chose to apply despite ${reason.replaceAll('"', "&quot;")}`)
  })

  it("Blocked: after Reason:, violated industry rule", () => {
    const email = renderBlocked({ ...blocked, override: { reason: "violated industry rule" } }, BASE)
    const text = lines(email.text)
    expect(text[text.indexOf("Reason: Missing Approved Answer") + 1]).toBe("Override: you chose to apply despite violated industry rule")
    expect(email.html).toContain("Override: you chose to apply despite violated industry rule")
  })

  it("an untrusted prerequisite is escaped in the HTML part", () => {
    const email = renderConfirmed({ ...confirmed, override: { reason: 'uncovered mandatory prerequisite "<b>x</b>"' } }, BASE)
    expect(email.html).not.toContain("<b>x</b>")
  })

  it("no override: no line (:877)", () => {
    expect(renderConfirmed({ ...confirmed, override: null }, BASE).text).not.toContain("Override")
    expect(renderBlocked({ ...blocked, override: null }, BASE).text).not.toContain("Override")
  })
})

describe("E3 daily summary marker (C-AA-34) and dropped override (C-AA-35)", () => {
  const summary = renderDailySummary(
    {
      watDay: "2026-10-29",
      automaticToday: 1,
      submitted: [{ role: "Senior Frontend Engineer", company: "Acme Payments", requisitionId: "R-4312", override: true }, { role: "Engineer", company: "Globex", requisitionId: "L-79" }],
      blockedCount: 0,
      uncertainCount: 1,
      uncertain: [{ role: "Frontend Engineer", company: "Lucky Odds Ltd", submittedAt: new Date("2026-10-29T10:00:00Z"), captchaAfterSubmit: false, override: true }],
      failures: [{ role: "Frontend Lead", company: "Initech", reason: "documents not generated", override: true }],
      skipped: [
        { role: "Mobile Engineer", company: "Globex", reason: "weak core Match", manualPossible: false, override: true },
        { role: "Frontend Engineer", company: "Lucky Odds Ltd", reason: "posting no longer matches your override", manualPossible: false, override: true },
      ],
      globalPaused: false,
      costPaused: false,
      costResumedToday: false,
      spend: null,
    },
    BASE
  )

  it("appends the marker to each override line in both parts", () => {
    for (const line of [
      "Senior Frontend Engineer at Acme Payments (R-4312) [Override]",
      "Frontend Engineer at Lucky Odds Ltd, submitted 11:00 WAT. No confirmation seen; it won't be retried. [Override]",
      "Frontend Lead at Initech: documents not generated [Override]",
      "Mobile Engineer at Globex: weak core Match [Override]",
      "Frontend Engineer at Lucky Odds Ltd: posting no longer matches your override [Override]",
    ]) {
      expect(summary.text).toContain(line)
      expect(summary.html).toContain(line.replaceAll("'", "&#39;"))
    }
  })

  it("no marker on a line without an override (:877)", () => {
    expect(summary.text).toContain("Engineer at Globex (L-79)\n")
  })
})

describe("emails naming no Application are unchanged (:865)", () => {
  it("cost-pause, access-request and access-request cap emails carry no marker", () => {
    const cost = renderCostPause({ month: "2026-10-01", spentMicros: 1, ceilingMicros: 2, action: null, estimateMicros: null, pausedAt: new Date("2026-10-29T09:00:00Z"), globalPaused: false }, BASE)
    const access = renderAccessRequest({ email: "a@example.com", requests: [{ note: "hi", createdAt: new Date() }] })
    const cap = renderAccessRequestCap({ day: "2026-10-29", accepted: 3 })
    for (const email of [cost, access, cap]) expect(email.text).not.toMatch(/Override/)
  })
})

describe("droppedReason: daily summary Not a match reason by drop detail (contract drop table)", () => {
  it.each([
    ["closed", false, "posting closed"],
    ["closed", true, "posting closed"],
    ["hidden", false, "posting closed"],
    ["hidden", true, "the posting changed after you chose to prepare it anyway"],
    ["override_mismatch", true, "the posting changed after you chose to prepare it anyway"],
    ["not_ranked", false, "posting closed"],
    [null, false, "posting closed"],
  ] as const)("%s with override %s is %s", (detail, override, reason) => {
    expect(droppedReason(detail, override)).toBe(reason)
  })
})
