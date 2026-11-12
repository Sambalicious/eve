import { describe, expect, it } from "vitest"

import { type BlockedEmailInput, type ConfirmedEmailInput, type CostPauseEmailInput, type DailySummaryInput, formatWat, renderBlocked, renderConfirmed, renderCostPause, renderDailySummary, untrusted } from "./email-content.js"

const BASE = "https://dashboard.test"
const ID = "6f1c2a4e-0000-4000-8000-000000000001"

const confirmed = (overrides: Partial<ConfirmedEmailInput> = {}): ConfirmedEmailInput => ({
  applicationId: ID,
  role: "Senior Frontend Engineer",
  company: "Acme Payments",
  requisitionId: "R-1042",
  submittedAt: new Date("2026-10-20T09:15:00Z"),
  evidence: { kind: "confirmation_page", text: "Thank you for applying" },
  sentAs: "automatic",
  employmentType: "direct",
  unverified: [],
  coverLetterStatus: "uploaded",
  automaticToday: 2,
  ...overrides,
})

const blocked = (overrides: Partial<BlockedEmailInput> = {}): BlockedEmailInput => ({
  applicationId: ID,
  role: "Frontend Lead",
  company: "Northwind Health",
  requisitionId: "NW-55",
  reason: "login",
  subReason: null,
  detail: "The form needs you to sign in to an account. The assistant doesn't sign in or create accounts.",
  ...overrides,
})

describe("formatWat", () => {
  it("prints the design's date format in WAT", () => {
    expect(formatWat(new Date("2026-10-20T09:15:00Z"))).toBe("20 Oct 2026, 10:15 WAT")
  })
})

describe("E1 Confirmed Submission (AC 7.1, 7.4)", () => {
  it("names company, role and requisition ID, and links to the exact documents and answers behind sign-in", () => {
    const email = renderConfirmed(confirmed(), BASE)
    expect(email.subject).toBe("Applied: Senior Frontend Engineer at Acme Payments (R-1042)")
    expect(email.preheader).toBe("Confirmed by the confirmation page on 20 Oct 2026, 10:15 WAT.")
    for (const line of ["Role: Senior Frontend Engineer", "Company: Acme Payments", "Requisition ID: R-1042", "Submitted: 20 Oct 2026, 10:15 WAT", "Confirmed by: Confirmation page", "Sent: Automatically", "Employment type: Direct employment", "Automatic submissions today: 2 of 5."]) {
      expect(email.text).toContain(line)
    }
    for (const anchor of ["#resume", "#cover-letter", "#answers"]) {
      expect(email.text).toContain(`${BASE}/applications/${ID}${anchor}`)
      expect(email.html).toContain(`href="${BASE}/applications/${ID}${anchor}"`)
    }
    expect(email.text).toContain("Links open your Eve dashboard and ask you to sign in.")
    expect(email.text).not.toContain("Unverified:")
  })

  it("an application ID, a sample, unverified rules and no cover letter field change the lines", () => {
    const email = renderConfirmed(confirmed({ evidence: { kind: "application_id", text: "GH-889201" }, sentAs: "sample", unverified: ["location", "pay"], coverLetterStatus: "no_field", employmentType: null }), BASE)
    expect(email.text).toContain("Confirmed by: Application ID GH-889201")
    expect(email.text).toContain("Sent: As an approved sample")
    expect(email.text).toContain("Unverified: location, pay")
    expect(email.text).toContain("Cover letter: not uploaded, the form had no cover letter field.")
    expect(email.text).toContain("View the stored cover letter")
    expect(email.text).not.toContain("Automatic submissions today")
    expect(email.text).not.toContain("Employment type:")
  })

  it("the Candidate's mark reads as such", () => {
    expect(renderConfirmed(confirmed({ evidence: { kind: "marked_confirmed", text: null } }), BASE).text).toContain("Confirmed by: Marked confirmed by you")
  })

  it("escapes page-sourced text in the HTML part and has no images or attachments", () => {
    const email = renderConfirmed(confirmed({ company: "<b>Acme</b>", evidence: { kind: "application_id", text: "<img src=x>1" } }), BASE)
    expect(email.html).not.toContain("<b>Acme</b>")
    expect(email.html).toContain("&lt;b&gt;Acme&lt;/b&gt;")
    expect(email.html).not.toMatch(/<img/i)
  })
})

describe("E2 Blocked Application (AC 7.2)", () => {
  it.each([
    ["missing_approved_answer", "Missing Approved Answer", "Add the answer in your dashboard."],
    ["login", "Login", "Apply yourself on the employer site with the prepared documents, then mark it completed manually."],
    ["email_verification", "Email verification", "Apply yourself"],
    ["captcha", "CAPTCHA", "Apply yourself"],
    ["assessment", "Assessment", "Apply yourself"],
    ["same_company_review", "Same-company review", "Approve it to submit under the normal rules"],
    ["declaration", "Declaration", "Apply yourself"],
    ["personal_data_request", "Personal data request", "Apply yourself"],
    ["automation_incomplete", "Automation couldn't complete the form", "The assistant won't try this form again."],
  ] as const)("%s: subject, reason line, what-to-do line and dashboard link", (reason, label, todo) => {
    const email = renderBlocked(blocked({ reason, detail: null }), BASE)
    expect(email.subject).toBe(`Needs you: Frontend Lead at Northwind Health (${label})`)
    expect(email.text).toContain(`Reason: ${label}`)
    expect(email.text).toMatch(/^What you can do: /m)
    expect(email.text).toContain(todo)
    expect(email.text).toContain(`Open this Blocked Application: ${BASE}/applications/${ID}`)
    expect(email.text).toContain("It doesn't count toward today's cap.")
  })

  it("carries the stored detail line", () => {
    expect(renderBlocked(blocked(), BASE).text).toContain("The form needs you to sign in to an account.")
  })

  it.each([
    ["budget", "It used up its time or effort limit for this form before every field was filled."],
    ["redirect", "The form sent the browser to apply.thirdparty-forms.example, which isn't the employer's application site."],
    ["submit_attempt", "Something on the page tried to submit the form early. The assistant stopped it."],
    ["value_mismatch", 'The "LinkedIn profile" field didn\'t hold the value the assistant set, so it didn\'t submit.'],
  ] as const)("seventh reason, sub-reason %s", (subReason, line) => {
    const email = renderBlocked(blocked({ reason: "automation_incomplete", subReason, detail: line }), BASE)
    expect(email.preheader).toBe("Nothing was submitted. Please apply to this one yourself.")
    expect(email.text).toContain(line)
    expect(email.text).toContain("The assistant stopped before the submit button, so the employer received nothing.")
    expect(email.text).toContain(
      "What you can do: Apply yourself on the employer site with the prepared documents, then mark it completed manually. The assistant won't try this form again."
    )
  })

  it("other reasons use the general preheader", () => {
    expect(renderBlocked(blocked(), BASE).preheader).toBe("Nothing was submitted. Here's what the assistant needs.")
  })
})

const summary = (overrides: Partial<DailySummaryInput> = {}): DailySummaryInput => ({
  watDay: "2026-10-20",
  automaticToday: 0,
  submitted: [],
  blockedCount: 0,
  uncertainCount: 0,
  uncertain: [],
  failures: [],
  skipped: [],
  globalPaused: false,
  costPaused: false,
  costResumedToday: false,
  spend: null,
  ...overrides,
})

describe("E3 daily summary (AC 7.3)", () => {
  it("an empty day still has every section with its none line", () => {
    const email = renderDailySummary(summary(), BASE)
    expect(email.subject).toBe("Eve, 20 Oct 2026: 0 submitted, 0 need you")
    expect(email.preheader).toBe("0 not a match, 0 failed, 0 unsure.")
    for (const line of ["No Applications were submitted today.", "Nothing needs you.", "No unsure sends.", "Nothing failed.", "No jobs were ruled out."]) expect(email.text).toContain(line)
    expect(email.text).toContain(`Open your dashboard: ${BASE}/dashboard`)
  })

  it("lists submitted, uncertain (with the CAPTCHA variant), failures and skipped roles with reasons", () => {
    const email = renderDailySummary(
      summary({
        automaticToday: 1,
        submitted: [{ role: "Senior Frontend Engineer", company: "Acme Payments", requisitionId: "R-1042" }],
        blockedCount: 2,
        uncertainCount: 2,
        uncertain: [
          { role: "Fullstack Engineer", company: "Umbrella", submittedAt: new Date("2026-10-20T09:15:00Z"), captchaAfterSubmit: true },
          { role: "Platform Engineer", company: "Soylent", submittedAt: new Date("2026-10-20T10:00:00Z"), captchaAfterSubmit: false },
        ],
        failures: [{ role: "Frontend Lead", company: "Initech", reason: "document validation blocked" }],
        skipped: [
          { role: "Product Designer", company: "Hooli", reason: "uncovered mandatory prerequisite", manualPossible: false },
          { role: "Frontend Engineer", company: "Contoso", reason: "unsupported Application System", manualPossible: true },
          { role: "Fullstack Engineer", company: "Initech", reason: "posting closed", manualPossible: false },
        ],
      }),
      BASE
    )
    expect(email.subject).toBe("Eve, 20 Oct 2026: 1 submitted, 4 need you")
    expect(email.preheader).toBe("3 not a match, 1 failed, 2 unsure.")
    expect(email.text).toContain("Automatic submissions: 1 of 5.")
    expect(email.text).toContain("Senior Frontend Engineer at Acme Payments (R-1042)")
    expect(email.text).toContain(`Blocked: 2 (${BASE}/blocked)`)
    expect(email.text).toContain(`Unsure sends: 2 (${BASE}/uncertain)`)
    expect(email.text).toContain("Fullstack Engineer at Umbrella, submitted 10:15 WAT. A CAPTCHA appeared after the submit click, so receipt can't be confirmed; it won't be retried.")
    expect(email.text).toContain("Platform Engineer at Soylent, submitted 11:00 WAT. No confirmation seen; it won't be retried.")
    expect(email.text).toContain("Frontend Lead at Initech: document validation blocked")
    expect(email.text).toContain("Product Designer at Hooli: uncovered mandatory prerequisite")
    expect(email.text).toContain("Frontend Engineer at Contoso: unsupported Application System. You can prepare it anyway, then apply on the employer's site.")
    expect(email.text).toContain("Fullstack Engineer at Initech: posting closed")
  })

  it("states the cost pause and when it ends", () => {
    expect(renderDailySummary(summary({ costPaused: true }), BASE).text).toContain(
      "Paid automation is paused for the monthly cost ceiling. It resumes on 1 Nov 2026, or sooner if you raise this month's ceiling."
    )
    expect(renderDailySummary(summary({ globalPaused: true }), BASE).text).toContain("Automation is paused.")
  })
})

describe("E3 slice 7 additions", () => {
  it("has the Spend section with this month's ceiling (CR6-05)", () => {
    const email = renderDailySummary(summary({ spend: { spentMicros: 23_400_000, ceilingMicros: 50_000_000 } }), BASE)
    expect(email.text).toContain("Spend\n\nUSD 23.40 of USD 50.00 this month.")
    expect(renderDailySummary(summary({ spend: { spentMicros: 61_000_000, ceilingMicros: 70_000_000 } }), BASE).text).toContain("USD 61.00 of USD 70.00 this month.")
  })

  it("says why paid automation resumed on the first summary after an automatic cost resume (C-COST-6)", () => {
    const email = renderDailySummary(summary({ watDay: "2026-11-01", costResumedToday: true }), BASE)
    expect(email.text).toContain("A new month started, so paid automation resumed.")
  })
})

const costPause = (overrides: Partial<CostPauseEmailInput> = {}): CostPauseEmailInput => ({
  month: "2026-10-01",
  spentMicros: 49_800_000,
  ceilingMicros: 50_000_000,
  action: "form filling",
  estimateMicros: 300_000,
  pausedAt: new Date("2026-10-25T09:00:00Z"),
  globalPaused: false,
  ...overrides,
})

describe("E4 cost ceiling pause (AC 10.2, design-spec r4 E4)", () => {
  it("has the subject, preheader and body facts", () => {
    const email = renderCostPause(costPause(), BASE)
    expect(email.subject).toBe("Paid automation paused: monthly cost ceiling")
    expect(email.preheader).toBe("Nothing paid runs until 1 Nov 2026, unless you raise this month's ceiling.")
    expect(email.text).toContain("Paid automation is paused. The next paid action would have taken this month's spend over USD 50.00, so the assistant stopped before running it.")
    expect(email.text).toContain("Spent this month: USD 49.80\nThis month's ceiling: USD 50.00\nNext paid action: form filling, estimated USD 0.30\nPaused at: 25 Oct 2026, 10:00 WAT")
    expect(email.text).toContain("What's stopped: every paid action, including discovery, document generation, Eligibility and Match checks, and the browser that fills and submits forms. Nothing is sent to employers while this pause is on.")
    expect(email.text).toContain("What still works: your dashboard. You can still paste job links. They're saved now, then checked for Eligibility and Match once the pause ends, because checking is a paid AI call.")
    expect(email.text).toContain("- On its own at 00:00 WAT on 1 Nov 2026, when a new month starts and the ceiling returns to USD 50.00.")
    expect(email.text).toContain("- Sooner, if you raise this month's ceiling to an amount that leaves room for the next paid action. You can raise it to at most USD 100.00, and the raise lasts until the end of October 2026.")
    expect(email.text).toContain("Your global pause is off. You don't need to do anything else.")
    expect(email.text).toContain(`Raise this month's ceiling: ${BASE}/settings#cost`)
    expect(email.text).toContain(`See this month's spend: ${BASE}/settings#cost`)
    expect(email.text).toContain("You'll get one email for this pause. The daily summary repeats the status until it ends.")
  })

  it("omits the next-action line when the backend has no action or estimate", () => {
    expect(renderCostPause(costPause({ action: null, estimateMicros: null }), BASE).text).not.toContain("Next paid action")
  })

  it("has the global-pause-on line", () => {
    expect(renderCostPause(costPause({ globalPaused: true }), BASE).text).toContain(
      "Your global pause is also on. Ending the cost pause won't resume automation until you also select Resume automation in the dashboard."
    )
  })

  it("at the USD 100.00 limit, says it can't be raised and drops the raise link", () => {
    const email = renderCostPause(costPause({ ceilingMicros: 100_000_000 }), BASE)
    expect(email.text).toContain("This month's ceiling is already at the USD 100.00 limit, so it can't be raised again.")
    expect(email.text).not.toContain("Raise this month's ceiling:")
    expect(email.text).toContain(`See this month's spend: ${BASE}/settings#cost`)
  })

  it("rolls December into January", () => {
    expect(renderCostPause(costPause({ month: "2026-12-01", pausedAt: new Date("2026-12-10T09:00:00Z") }), BASE).preheader).toBe("Nothing paid runs until 1 Jan 2027, unless you raise this month's ceiling.")
  })
})

describe("employer text in emails (SEC-602)", () => {
  it("caps a field at 120 characters with an ellipsis", () => {
    expect(untrusted("a".repeat(200))).toBe(`${"a".repeat(119)}…`)
  })

  it("defangs URL-like text so mail clients don't autolink it", () => {
    expect(untrusted("Apply at https://evil.example/x now")).toBe("Apply at https[:]//evil.example/x now")
    expect(untrusted("www.evil.example")).toBe("www[.]evil.example")
  })

  it("applies to role, company and the blocked detail in E2", () => {
    const email = renderBlocked(blocked({ role: "Engineer http://evil.example", company: "Evil Corp", detail: "Field \"Visit https://evil.example\" needs an answer" }), BASE)
    expect(email.text).not.toMatch(/https?:\/\/evil/)
    expect(email.subject).not.toMatch(/https?:\/\/evil/)
  })
})

describe("E3 daily summary retention line (automatic-expiry.feature E5.4, D-E7, C-RET-20)", () => {
  it("adds one Retention section with the count when that day's run deleted Applications, after Spend and before the status line", () => {
    const email = renderDailySummary(summary({ retentionDeleted: 3, spend: { spentMicros: 1_000_000, ceilingMicros: 30_000_000 }, globalPaused: true }), BASE)
    const line = "Detailed records of 3 Applications were deleted automatically today, after 12 months. Their minimal records stay."
    expect(email.text.split(line)).toHaveLength(2)
    expect(email.text).toContain(`${BASE}/privacy#records`)
    expect(email.text.indexOf("Spend")).toBeLessThan(email.text.indexOf(line))
    expect(email.text.indexOf(line)).toBeLessThan(email.text.indexOf("Automation is paused."))
    expect(email.html).toContain("Retention")
  })

  it("uses the singular form for one Application", () => {
    expect(renderDailySummary(summary({ retentionDeleted: 1 }), BASE).text).toContain("Detailed records of 1 Application were deleted automatically today, after 12 months. Its minimal record stays.")
  })

  it.each([[0], [undefined]])("has no retention line when the count is %j", (count) => {
    const email = renderDailySummary(summary(count === undefined ? {} : { retentionDeleted: count }), BASE)
    expect(email.text).not.toContain("deleted automatically")
    expect(email.text).not.toContain("privacy#records")
  })
})
