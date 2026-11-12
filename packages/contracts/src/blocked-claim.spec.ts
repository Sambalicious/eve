import { describe, expect, it } from "vitest"

import {
  BLOCKED_CLAIM_CAUSES,
  BLOCKED_CLAIM_TERMS_CAUSES,
  BLOCKED_CLAIM_TERMS_LIMIT,
  BLOCKED_CLAIM_TERM_MAX,
  applicationDetailSchema,
  applicationListItemSchema,
  applicationSummarySchema,
  blockedClaimCauseSchema,
  createApplicationResponseSchema,
  sampleRowSchema,
  submissionListRowSchema,
} from "./index.js"

const ID = "90090000-0000-4000-8000-000000000001"
const POSTING = "10000000-0000-4000-8000-000000000901"

const summary = {
  id: ID,
  jobPostingId: POSTING,
  company: "Reddit",
  roleTitle: "Frontend Engineer, Ads",
  requisitionId: "R-9001",
  applicationUrl: "https://boards.greenhouse.io/reddit/jobs/9001",
  pastedDescription: false,
  manualOnly: false,
  state: "documents_blocked",
  careerProfileVersion: 1,
  blockedDocument: "cover_letter",
  blockedClaim: "I work well in remote teams.",
  failure: null,
  coverLetterStatus: "not_submitted",
  createdAt: "2026-11-10T09:00:00.000Z",
  updatedAt: "2026-11-10T09:04:12.000Z",
  detailsDeletedAt: null,
  expiresOn: "2027-11-10",
  override: null,
}

const reddit = { blockedClaimCause: "unsupported_terms", blockedClaimTerms: ["remote"], blockedClaimMoreTerms: 0 }
const zeta = Array.from({ length: 20 }, (_, i) => `Zeta${i}word`)

describe("blocked claim fields (v1.30.0, EPIC-0009)", () => {
  it("lists exactly the seven stored causes, in order, and the three terms causes", () => {
    expect(blockedClaimCauseSchema.options).toEqual([
      "unsupported_terms",
      "number_order",
      "no_fact",
      "contact_detail",
      "names_target",
      "unknown_fact",
      "not_confirmed",
    ])
    expect([...BLOCKED_CLAIM_CAUSES]).toEqual(blockedClaimCauseSchema.options)
    expect([...BLOCKED_CLAIM_TERMS_CAUSES]).toEqual(["unsupported_terms", "number_order", "no_fact"])
    expect(BLOCKED_CLAIM_TERMS_LIMIT).toBe(20)
    expect(BLOCKED_CLAIM_TERM_MAX).toBe(120)
  })

  it.each([
    ["no keys", {}],
    ["all three null", { blockedClaimCause: null, blockedClaimTerms: null, blockedClaimMoreTerms: null }],
    ["the Reddit case", reddit],
    ["20 terms with a count", { blockedClaimCause: "unsupported_terms", blockedClaimTerms: zeta, blockedClaimMoreTerms: 6 }],
    ["a cause with no terms keys", { blockedClaimCause: "not_confirmed" }],
    ["a cause this build does not know", { blockedClaimCause: "some_future_kind", blockedClaimTerms: ["Zorvex"], blockedClaimMoreTerms: 2 }],
    ["terms on a no-terms cause (no cross-field refine)", { blockedClaimCause: "not_confirmed", blockedClaimTerms: ["led", "Zorvex"], blockedClaimMoreTerms: 3 }],
    ["an empty list with a count", { blockedClaimCause: "unsupported_terms", blockedClaimTerms: [], blockedClaimMoreTerms: 1 }],
    ["a 120-unit term", { blockedClaimCause: "unsupported_terms", blockedClaimTerms: ["x".repeat(120)], blockedClaimMoreTerms: 0 }],
    ["a 40-character cause", { blockedClaimCause: `a${"_".repeat(39)}` }],
  ])("accepts %s", (_name, extra) => {
    expect(applicationSummarySchema.safeParse({ ...summary, ...extra }).success).toBe(true)
  })

  it.each([
    ["21 terms", { blockedClaimTerms: [...zeta, "extra"], blockedClaimMoreTerms: 0 }],
    ["an empty string term", { blockedClaimTerms: [""], blockedClaimMoreTerms: 0 }],
    ["a 121-unit term", { blockedClaimTerms: ["x".repeat(121)], blockedClaimMoreTerms: 0 }],
    ["a negative count", { blockedClaimMoreTerms: -1 }],
    ["a fractional count", { blockedClaimMoreTerms: 1.5 }],
    ["an upper-case cause", { blockedClaimCause: "Unsupported" }],
    ["an empty cause", { blockedClaimCause: "" }],
    ["a hyphenated cause", { blockedClaimCause: "a-b" }],
    ["a 41-character cause", { blockedClaimCause: `a${"_".repeat(40)}` }],
    ["a cause starting with an underscore", { blockedClaimCause: "_a" }],
    ["an unknown key", { blockedClaimHardFail: "gap" }],
  ])("rejects %s", (_name, extra) => {
    expect(applicationSummarySchema.safeParse({ ...summary, ...extra }).success).toBe(false)
  })

  it("still accepts a summary written before v1.30.0", () => {
    expect(applicationSummarySchema.safeParse(summary).success).toBe(true)
  })

  it("is accepted on every schema that embeds the summary", () => {
    const withFields = { ...summary, ...reddit }
    expect(applicationDetailSchema.safeParse({ ...withFields, documents: [], posting: { status: "ranked", hidden: false }, latestDrop: null }).success).toBe(true)
    expect(createApplicationResponseSchema.safeParse({ created: false, application: withFields }).success).toBe(true)
    expect(applicationListItemSchema.shape.blockedClaimCause).toBe(applicationSummarySchema.shape.blockedClaimCause)
    expect(applicationListItemSchema.shape.blockedClaimTerms).toBe(applicationSummarySchema.shape.blockedClaimTerms)
    expect(applicationListItemSchema.shape.blockedClaimMoreTerms).toBe(applicationSummarySchema.shape.blockedClaimMoreTerms)
    expect(submissionListRowSchema.shape.application).toBe(applicationSummarySchema)
    expect(sampleRowSchema.shape.application).toBe(applicationSummarySchema)
  })
})
