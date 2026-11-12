import { describe, expect, it } from "vitest"

import {
  APPLY_ANYWAY_ERROR_MESSAGES,
  apiErrorCodeSchema,
  applicationDetailSchema,
  applicationOverrideSchema,
  applicationSummarySchema,
  applyAnywaySchema,
  createApplicationRequestSchema,
  isOverridableDecision,
  jobPostingStatusSchema,
  latestDropReasonOf,
  type OverrideDecision,
  overrideDecisionSchema,
  overrideDecisionsEqual,
  queuedPostingDroppedDetailSchema,
  removeFromQueuePath,
  sampleResultSchema,
  skipReasonSchema,
  sortViolatedRules,
  submissionSchema,
} from "./index.js"

const decision = (over: Partial<OverrideDecision>): OverrideDecision => ({ status: "skipped", skipReason: "weak_core_match", skipDetail: null, violatedRules: [], ...over })
const excluded = (rules: string[]): OverrideDecision => ({ status: "excluded", skipReason: "violated_rule", skipDetail: rules[0] ?? null, violatedRules: rules })

describe("v1.24.0 isOverridableDecision (AA-1.1, AA-1.2)", () => {
  it.each([
    ["weak_core_match", null],
    ["uncovered_mandatory_prerequisite", "Professional Kotlin Android experience"],
    ["no_core_responsibilities", null],
  ] as const)("a weak-Match skip %s is overridable (D1)", (skipReason, skipDetail) => {
    expect(isOverridableDecision(decision({ skipReason, skipDetail }))).toBe(true)
  })

  it("an exclusion whose only violated rule is industry is overridable (D2)", () => {
    expect(isOverridableDecision(excluded(["industry"]))).toBe(true)
  })

  it.each(["technology_mismatch", "not_software_role", "violated_rule"] as const)("a skip for %s is not overridable (D7, P1)", (skipReason) => {
    expect(isOverridableDecision(decision({ skipReason }))).toBe(false)
  })

  it("v1.28.0 (owner decision 2026-11-10): a skip for unsupported_application_system is overridable, as a manual application", () => {
    // D7 excluded it while "apply anyway" meant "override a weak Match". The manual lane reuses the
    // same consent path for a different reason: Eve prepares documents, the Candidate applies by hand.
    // The posting's applyMode stays manual, so the submission layer still refuses to queue or send it.
    expect(isOverridableDecision(decision({ skipReason: "unsupported_application_system" }))).toBe(true)
    expect(isOverridableDecision({ status: "skipped", skipReason: "unsupported_application_system", skipDetail: "We Work Remotely", violatedRules: ["location"] })).toBe(false)
  })

  it("a skipped decision with no reason, or with a violated rule, is not overridable", () => {
    expect(isOverridableDecision(decision({ skipReason: null }))).toBe(false)
    expect(isOverridableDecision(decision({ violatedRules: ["industry"] }))).toBe(false)
  })

  it.each([["location"], ["sponsorship"], ["pay"], ["hours"], ["seniority"], ["employment_type"], ["commute"]])("an exclusion for %s alone is not overridable", (rule) => {
    expect(isOverridableDecision(excluded([rule]))).toBe(false)
  })

  it.each([["location"], ["sponsorship"], ["pay"], ["hours"], ["commute"]])("industry together with %s is not overridable", (rule) => {
    expect(isOverridableDecision(excluded(["industry", rule]))).toBe(false)
    expect(isOverridableDecision(excluded([rule, "industry"]))).toBe(false)
  })

  it("an exclusion with no violated rule, or not for violated_rule, is not overridable", () => {
    expect(isOverridableDecision(excluded([]))).toBe(false)
    expect(isOverridableDecision({ status: "excluded", skipReason: null, skipDetail: "industry", violatedRules: ["industry"] })).toBe(false)
  })

  it("every status other than skipped and excluded is not overridable", () => {
    for (const status of jobPostingStatusSchema.options.filter((s) => s !== "skipped" && s !== "excluded")) {
      expect(isOverridableDecision(decision({ status }))).toBe(false)
      expect(isOverridableDecision({ status, skipReason: "violated_rule", skipDetail: "industry", violatedRules: ["industry"] })).toBe(false)
    }
  })

  it("exactly four skip reasons are overridable", () => {
    expect(skipReasonSchema.options.filter((skipReason) => isOverridableDecision(decision({ skipReason })))).toEqual([
      "unsupported_application_system",
      "uncovered_mandatory_prerequisite",
      "weak_core_match",
      "no_core_responsibilities",
    ])
  })
})

describe("v1.24.0 overrideDecisionsEqual (AA-2.1, AA-2.3)", () => {
  it("equal decisions are equal, and the violated rule set ignores order", () => {
    expect(overrideDecisionsEqual(excluded(["industry"]), excluded(["industry"]))).toBe(true)
    expect(overrideDecisionsEqual(excluded(["industry", "hours"]), { ...excluded(["hours", "industry"]), skipDetail: "industry" })).toBe(true)
  })

  it("a different status, skip reason or skip detail is not equal", () => {
    const base = decision({ skipReason: "uncovered_mandatory_prerequisite", skipDetail: "Professional Kotlin Android experience" })
    expect(overrideDecisionsEqual(base, { ...base, status: "excluded" })).toBe(false)
    expect(overrideDecisionsEqual(base, { ...base, skipReason: "weak_core_match" })).toBe(false)
    expect(overrideDecisionsEqual(base, { ...base, skipDetail: "Active security clearance" })).toBe(false)
    expect(overrideDecisionsEqual(base, { ...base, skipDetail: null })).toBe(false)
    expect(overrideDecisionsEqual(base, { ...base, skipDetail: "professional kotlin android experience" })).toBe(false)
  })

  it("an added, removed or replaced violated rule is not equal", () => {
    expect(overrideDecisionsEqual(excluded(["industry"]), excluded(["industry", "hours"]))).toBe(false)
    expect(overrideDecisionsEqual(excluded(["industry", "location"]), excluded(["industry"]))).toBe(false)
    expect(overrideDecisionsEqual({ ...excluded(["industry"]) }, { ...excluded(["location"]), skipDetail: "industry" })).toBe(false)
  })

  it("is symmetric and null equals only null", () => {
    const a = decision({ skipDetail: null })
    const b = decision({ skipDetail: "x" })
    expect(overrideDecisionsEqual(a, b)).toBe(overrideDecisionsEqual(b, a))
    expect(overrideDecisionsEqual(a, decision({ skipDetail: null }))).toBe(true)
  })
})

describe("v1.24.0 schemas", () => {
  it("the decision schema accepts unknown rule names but refuses duplicates and bad names", () => {
    expect(overrideDecisionSchema.safeParse(excluded(["industry", "commute"])).success).toBe(true)
    expect(overrideDecisionSchema.safeParse(excluded(["industry", "industry"])).success).toBe(false)
    expect(overrideDecisionSchema.safeParse(excluded(["Industry"])).success).toBe(false)
    expect(overrideDecisionSchema.safeParse({ ...excluded(["industry"]), extra: 1 }).success).toBe(false)
  })

  it("sorts violated rules in the server order, unknown names last and alphabetically", () => {
    expect(sortViolatedRules(["zeta", "industry", "commute", "location"])).toEqual(["location", "industry", "commute", "zeta"])
  })

  it("the create request takes an optional acknowledgement with confirmed: true", () => {
    const jobPostingId = "6f1c2a6e-8a1c-4c3b-9f3e-1b2c3d4e5f60"
    expect(createApplicationRequestSchema.safeParse({ jobPostingId }).success).toBe(true)
    expect(createApplicationRequestSchema.safeParse({ jobPostingId, acknowledgement: null }).success).toBe(true)
    expect(createApplicationRequestSchema.safeParse({ jobPostingId, acknowledgement: { confirmed: true, decision: excluded(["industry"]) } }).success).toBe(true)
    expect(createApplicationRequestSchema.safeParse({ jobPostingId, acknowledgement: { confirmed: false, decision: excluded(["industry"]) } }).success).toBe(false)
    expect(createApplicationRequestSchema.safeParse({ jobPostingId, acknowledgement: { confirmed: true, decision: { ...excluded(["industry"]), status: "closed" } } }).success).toBe(false)
  })

  it("applyAnyway is offered: true with a decision", () => {
    expect(applyAnywaySchema.safeParse({ offered: true, decision: decision({}) }).success).toBe(true)
    expect(applyAnywaySchema.safeParse({ offered: false, decision: decision({}) }).success).toBe(false)
  })

  const override = { createdAt: "2026-10-29T10:00:00+01:00", status: "excluded", skipReason: "violated_rule", skipDetail: "industry", violatedRules: ["industry"], applies: true, notAppliesReason: null }

  it("an override has notAppliesReason null exactly when applies is true; a legacy override has null stored fields", () => {
    expect(applicationOverrideSchema.safeParse(override).success).toBe(true)
    expect(applicationOverrideSchema.safeParse({ ...override, applies: false }).success).toBe(false)
    expect(applicationOverrideSchema.safeParse({ ...override, notAppliesReason: "hidden" }).success).toBe(false)
    expect(
      applicationOverrideSchema.safeParse({ ...override, status: null, skipReason: null, skipDetail: null, violatedRules: null, applies: false, notAppliesReason: "legacy_no_decision" }).success
    ).toBe(true)
    expect(applicationOverrideSchema.safeParse({ ...override, status: "ranked" }).success).toBe(false)
  })

  const summary = {
    id: "6f1c2a6e-8a1c-4c3b-9f3e-1b2c3d4e5f60",
    jobPostingId: "7f1c2a6e-8a1c-4c3b-9f3e-1b2c3d4e5f60",
    company: "Acme",
    roleTitle: "Engineer",
    requisitionId: "R-1",
    applicationUrl: "https://boards.greenhouse.io/acme/jobs/1",
    // v1.27.0 (EPIC-0010): required on every summary.
    pastedDescription: false,
    manualOnly: false,
    state: "documents_ready",
    careerProfileVersion: 1,
    blockedDocument: null,
    blockedClaim: null,
    failure: null,
    coverLetterStatus: "not_submitted",
    createdAt: "2026-10-29T10:00:00+01:00",
    updatedAt: "2026-10-29T10:00:00+01:00",
  }

  it("ApplicationSummary requires override (null or an object); the detail requires posting and latestDrop", () => {
    expect(applicationSummarySchema.safeParse(summary).success).toBe(false)
    expect(applicationSummarySchema.safeParse({ ...summary, override: null }).success).toBe(true)
    expect(applicationSummarySchema.safeParse({ ...summary, override }).success).toBe(true)
    const detail = { ...summary, override: null, documents: [], posting: { status: "skipped", hidden: false }, latestDrop: { at: "2026-10-29T09:00:00+01:00", reason: "closed" } }
    expect(applicationDetailSchema.safeParse(detail).success).toBe(true)
    expect(applicationDetailSchema.safeParse({ ...detail, posting: null, latestDrop: null }).success).toBe(true)
    expect(applicationDetailSchema.safeParse({ ...detail, latestDrop: { ...detail.latestDrop, reason: "hidden" } }).success).toBe(false)
  })

  it("Submission requires override", () => {
    const submission = {
      state: null, kind: null, attemptNumber: 0, submittedAt: null, submittedWatDay: null, evidence: null, captchaAfterSubmit: false, blockedReason: null, blockedSubReason: null,
      blockedDetail: null, blockedQuestion: null, blockedAt: null, queuedForWatDay: null, sample: null, declinedReason: null, declinedAt: null, markedNotSubmittedAt: null, manualCompletedAt: null,
    }
    expect(submissionSchema.safeParse(submission).success).toBe(false)
    expect(submissionSchema.safeParse({ ...submission, override: null }).success).toBe(true)
  })

  it("sample results gain not_ranked and not_allowed", () => {
    for (const result of ["not_ranked", "not_allowed"]) {
      expect(sampleResultSchema.safeParse({ result, alreadyDone: false, countingSamples: 2, gatePassedAt: null }).success).toBe(true)
    }
  })

  it("drop details map to the detail page reason", () => {
    expect(queuedPostingDroppedDetailSchema.options).toEqual(["closed", "hidden", "override_mismatch", "not_ranked"])
    expect(latestDropReasonOf("closed")).toBe("closed")
    for (const detail of ["hidden", "override_mismatch", "not_ranked", null] as const) expect(latestDropReasonOf(detail)).toBe("not_submittable")
  })

  it("the five new error codes exist with their copy-deck messages", () => {
    expect(Object.keys(APPLY_ANYWAY_ERROR_MESSAGES).every((code) => apiErrorCodeSchema.safeParse(code).success)).toBe(true)
    expect(APPLY_ANYWAY_ERROR_MESSAGES.override_not_allowed).toBe("This posting's reason can't be overridden. Nothing changed.")
    expect(removeFromQueuePath("abc")).toBe("/v1/applications/abc/remove-from-queue")
  })
})
