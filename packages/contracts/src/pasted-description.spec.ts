import { describe, expect, it } from "vitest"

import {
  PASTE_DESCRIPTION_ERROR_MESSAGES,
  PASTE_FIELD_MESSAGES,
  PASTED_DESCRIPTION_MAX_LENGTH,
  PASTED_DESCRIPTION_MIN_LENGTH,
  PASTED_DESCRIPTION_RAW_MAX_LENGTH,
  PASTED_NAME_MAX_LENGTH,
  PASTED_NAME_RAW_MAX_LENGTH,
  apiErrorCodeSchema,
  apiErrorResponseSchema,
  applicationSummarySchema,
  cleanPastedName,
  documentsListRowSchema,
  jobPostingDetailSchema,
  jobPostingSummarySchema,
  minimalRecordSchema,
  normalisePastedDescription,
  pasteDescriptionOutcomeSchema,
  pasteFieldErrorCode,
  pasteFieldErrors,
  pasteJobLinkRequestSchema,
  pasteJobLinkResponseSchema,
} from "./index.js"

const POSTING_ID = "11111111-1111-4111-8111-111111111111"
const APPLICATION_ID = "22222222-2222-4222-8222-222222222222"
const DESC = "a".repeat(1240)

const pastedSummary = {
  id: POSTING_ID,
  title: "Senior Frontend Engineer",
  company: "Paystack",
  applicationUrl: null,
  requisitionId: `pasted:${POSTING_ID}`,
  applicationSystem: "none",
  applyUrl: null,
  applyMode: "manual",
  origin: "pasted_description",
  attribution: null,
  status: "checking",
  skipReason: null,
  skipDetail: null,
  evaluationFailure: null,
  roleFamily: "senior_frontend",
  rank: null,
  unverifiedLabels: [],
  match: null,
  technologiesNotChecked: false,
  discoveredAt: "2026-11-02T09:00:00Z",
  postedAt: null,
  postedOn: null,
  postedDateKind: null,
  ageDays: null,
  hiddenReason: null,
}

describe("v1.27.0 POST /v1/job-postings/links request (EPIC-0010 PD-1)", () => {
  it("a link-only body is still exactly { url }", () => {
    expect(pasteJobLinkRequestSchema.parse({ url: "https://jobs.lever.co/acme/1" })).toEqual({ url: "https://jobs.lever.co/acme/1" })
  })

  it("accepts description only, link plus description, and the names", () => {
    expect(pasteJobLinkRequestSchema.safeParse({ description: DESC, title: "T", company: "C" }).success).toBe(true)
    expect(pasteJobLinkRequestSchema.safeParse({ url: "https://x.example/j", description: DESC }).success).toBe(true)
  })

  it("refuses {} and a body with only names (400 as today)", () => {
    expect(pasteJobLinkRequestSchema.safeParse({}).success).toBe(false)
    expect(pasteJobLinkRequestSchema.safeParse({ title: "T", company: "C" }).success).toBe(false)
  })

  it("refuses unknown keys, non-strings and null", () => {
    expect(pasteJobLinkRequestSchema.safeParse({ url: "https://x.example", extra: 1 }).success).toBe(false)
    expect(pasteJobLinkRequestSchema.safeParse({ description: 5 }).success).toBe(false)
    expect(pasteJobLinkRequestSchema.safeParse({ description: null }).success).toBe(false)
    expect(pasteJobLinkRequestSchema.safeParse({ url: null, description: DESC }).success).toBe(false)
  })

  it("raw caps: url 2048, description 65,536, names 1,000", () => {
    expect(pasteJobLinkRequestSchema.safeParse({ url: "h".repeat(2049) }).success).toBe(false)
    expect(pasteJobLinkRequestSchema.safeParse({ description: "a".repeat(PASTED_DESCRIPTION_RAW_MAX_LENGTH) }).success).toBe(true)
    expect(pasteJobLinkRequestSchema.safeParse({ description: "a".repeat(PASTED_DESCRIPTION_RAW_MAX_LENGTH + 1) }).success).toBe(false)
    expect(pasteJobLinkRequestSchema.safeParse({ description: DESC, title: "t".repeat(PASTED_NAME_RAW_MAX_LENGTH + 1) }).success).toBe(false)
    // 45,000 characters passes the schema so it is refused by name (PD:167), not as a plain 400.
    expect(pasteJobLinkRequestSchema.safeParse({ description: "a".repeat(45_000) }).success).toBe(true)
  })
})

describe("v1.27.0 normalisePastedDescription", () => {
  it("normalises line endings, strips controls and bidi characters, trims", () => {
    expect(normalisePastedDescription("  a\r\nb\rc\u0007d‮e⁦f\tg\u0085h  \n")).toBe("a\nb\ncdef\tgh")
  })

  it("keeps markup, case and inner whitespace as literal text", () => {
    expect(normalisePastedDescription("<script>alert('x')</script>  **Bold**")).toBe("<script>alert('x')</script>  **Bold**")
  })

  it("whitespace only is empty", () => {
    expect(normalisePastedDescription("   \n\n \t ")).toBe("")
  })
})

describe("v1.27.0 cleanPastedName (PD-1.4, I-2)", () => {
  it("cleans like cleanPostingName without cutting", () => {
    expect(cleanPastedName("  Senior\tFrontend\n Engineer  ")).toBe("Senior Frontend Engineer")
    expect(cleanPastedName("Pay\u0007stack  Ltd")).toBe("Pay stack Ltd")
    expect(cleanPastedName("​​")).toBe("")
    expect(cleanPastedName("x".repeat(250))).toHaveLength(250)
  })
})

describe("v1.27.0 pasteFieldErrors (PD-1.3, PD-1.4)", () => {
  const ok = { title: "Senior Frontend Engineer", company: "Paystack", namesRequired: true }

  it.each([200, 201, 29_999, 30_000])("accepts %d characters after trimming", (length) => {
    expect(pasteFieldErrors({ ...ok, description: "a".repeat(length) })).toEqual([])
  })

  it("bounds count after trimming", () => {
    expect(pasteFieldErrors({ ...ok, description: `${" ".repeat(50)}${"a".repeat(199)}${" ".repeat(50)}` })).toEqual([
      { field: "description", position: null, problem: "too_short" },
    ])
    expect(pasteFieldErrors({ ...ok, description: "a".repeat(PASTED_DESCRIPTION_MAX_LENGTH + 1) })).toEqual([
      { field: "description", position: null, problem: "too_long" },
    ])
    expect(pasteFieldErrors({ ...ok, description: "   \n\n  " })[0]?.problem).toBe("too_short")
    expect(PASTED_DESCRIPTION_MIN_LENGTH).toBe(200)
  })

  it("names: required only when namesRequired; too long always", () => {
    expect(pasteFieldErrors({ description: DESC, title: "  ", company: undefined, namesRequired: true })).toEqual([
      { field: "title", position: null, problem: "required" },
      { field: "company", position: null, problem: "required" },
    ])
    expect(pasteFieldErrors({ description: DESC, title: undefined, company: undefined, namesRequired: false })).toEqual([])
    expect(
      pasteFieldErrors({ description: DESC, title: "t".repeat(PASTED_NAME_MAX_LENGTH + 1), company: "c".repeat(250), namesRequired: false }),
    ).toEqual([
      { field: "title", position: null, problem: "too_long" },
      { field: "company", position: null, problem: "too_long" },
    ])
    expect(pasteFieldErrors({ ...ok, description: DESC, title: "t".repeat(200) })).toEqual([])
  })

  it("orders description, title, company and the top-level code is the first", () => {
    const errors = pasteFieldErrors({ description: "short", title: "", company: "", namesRequired: true })
    expect(errors.map((e) => e.field)).toEqual(["description", "title", "company"])
    expect(errors.map(pasteFieldErrorCode)).toEqual(["job_description_too_short", "job_title_required", "company_required"])
  })
})

describe("v1.27.0 paste response (descriptionOutcome, applicationId, waitingReason)", () => {
  const base = { created: true, posting: pastedSummary, descriptionOutcome: "stored", applicationId: null, waitingReason: null }

  it("has one outcome per result line", () => {
    expect(pasteDescriptionOutcomeSchema.options).toEqual([
      "stored",
      "stored_lookup_failed",
      "attached",
      "replaced",
      "already_pasted",
      "employer_page_used",
      "unchanged_has_application",
    ])
  })

  it("parses each outcome", () => {
    for (const outcome of pasteDescriptionOutcomeSchema.options) {
      const applicationId = outcome === "unchanged_has_application" ? APPLICATION_ID : null
      expect(pasteJobLinkResponseSchema.safeParse({ ...base, descriptionOutcome: outcome, applicationId }).success).toBe(true)
    }
  })

  it("link-only: descriptionOutcome null", () => {
    const linkOnly = { ...pastedSummary, origin: "pasted_link", applicationUrl: "https://x.example/j", applyUrl: "https://x.example/j", status: "skipped", skipReason: "unsupported_application_system" }
    expect(pasteJobLinkResponseSchema.safeParse({ ...base, posting: linkOnly, descriptionOutcome: null }).success).toBe(true)
  })

  it("applicationId is set exactly with unchanged_has_application", () => {
    expect(pasteJobLinkResponseSchema.safeParse({ ...base, applicationId: APPLICATION_ID }).success).toBe(false)
    expect(pasteJobLinkResponseSchema.safeParse({ ...base, descriptionOutcome: "unchanged_has_application" }).success).toBe(false)
  })

  it("waitingReason is set exactly when the posting waits", () => {
    const waiting = { ...pastedSummary, status: "waiting_to_be_checked" }
    expect(pasteJobLinkResponseSchema.safeParse({ ...base, posting: waiting, waitingReason: "cost_pause" }).success).toBe(true)
    expect(pasteJobLinkResponseSchema.safeParse({ ...base, posting: waiting, waitingReason: "checks_not_enabled" }).success).toBe(true)
    expect(pasteJobLinkResponseSchema.safeParse({ ...base, posting: waiting }).success).toBe(false)
    expect(pasteJobLinkResponseSchema.safeParse({ ...base, waitingReason: "cost_pause" }).success).toBe(false)
  })

  it("is strict", () => {
    expect(pasteJobLinkResponseSchema.safeParse({ ...base, extra: true }).success).toBe(false)
  })
})

describe("v1.27.0 posting and Application shapes", () => {
  it("a description-only posting has null links and the pasted origin", () => {
    expect(jobPostingSummarySchema.safeParse(pastedSummary).success).toBe(true)
    expect(jobPostingSummarySchema.safeParse({ ...pastedSummary, origin: "pasted_text" }).success).toBe(false)
  })

  it("the detail requires pastedPrepareOffered", () => {
    const detail = {
      ...pastedSummary,
      status: "excluded",
      technologies: [],
      postingText: DESC,
      employmentType: null,
      eligibility: null,
      match: null,
      applyAnyway: null,
      applicationId: null,
    }
    expect(jobPostingDetailSchema.safeParse(detail).success).toBe(false)
    expect(jobPostingDetailSchema.safeParse({ ...detail, pastedPrepareOffered: true }).success).toBe(true)
  })

  it("ApplicationSummary requires pastedDescription and manualOnly; applicationUrl may be null", () => {
    const summary = {
      id: APPLICATION_ID,
      jobPostingId: POSTING_ID,
      company: "Paystack",
      roleTitle: "Senior Frontend Engineer",
      requisitionId: `pasted:${POSTING_ID}`,
      applicationUrl: null,
      pastedDescription: true,
      manualOnly: true,
      state: "documents_ready",
      careerProfileVersion: 4,
      blockedDocument: null,
      blockedClaim: null,
      failure: null,
      coverLetterStatus: "not_submitted",
      createdAt: "2026-11-02T09:00:00Z",
      updatedAt: "2026-11-02T09:00:00Z",
      override: null,
    }
    expect(applicationSummarySchema.safeParse(summary).success).toBe(true)
    const withoutManual: Record<string, unknown> = { ...summary }
    delete withoutManual.manualOnly
    expect(applicationSummarySchema.safeParse(withoutManual).success).toBe(false)
  })

  it("documents rows carry pastedDescription; minimal records allow a null link", () => {
    const row = { applicationId: APPLICATION_ID, company: null, roleTitle: null, requisitionId: "pasted:x", pastedDescription: true, coverLetterStatus: "not_submitted", resume: null, coverLetter: null }
    expect(documentsListRowSchema.safeParse(row).success).toBe(true)
    expect(minimalRecordSchema.shape.applicationUrl.safeParse(null).success).toBe(true)
  })
})

describe("v1.27.0 paste error codes and envelope", () => {
  it("adds the nine codes", () => {
    for (const code of Object.keys(PASTE_DESCRIPTION_ERROR_MESSAGES)) expect(apiErrorCodeSchema.safeParse(code).success).toBe(true)
    expect(Object.keys(PASTE_DESCRIPTION_ERROR_MESSAGES)).toHaveLength(9)
  })

  it("the envelope carries paste fieldErrors and never a value", () => {
    const body = {
      error: {
        code: "job_title_required",
        message: PASTE_DESCRIPTION_ERROR_MESSAGES.job_title_required,
        fieldErrors: [
          { field: "title", position: null, problem: "required" },
          { field: "company", position: null, problem: "required" },
        ],
      },
    }
    expect(apiErrorResponseSchema.safeParse(body).success).toBe(true)
    const withValue = { error: { ...body.error, fieldErrors: [{ field: "title", position: null, problem: "required", value: "x" }] } }
    expect(apiErrorResponseSchema.safeParse(withValue).success).toBe(false)
  })

  it("field messages reuse the code messages", () => {
    expect(PASTE_FIELD_MESSAGES.description.too_long).toBe("Over the 30,000-character limit. Shorten it to check this job.")
    expect(PASTE_FIELD_MESSAGES.company.too_long).toBe("Company is over 200 characters. Shorten it.")
  })
})
