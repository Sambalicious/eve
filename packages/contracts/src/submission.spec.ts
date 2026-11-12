import { describe, expect, it } from "vitest"

import { formAnswerSchema, formAnswersPath, sampleResultSchema, samplesPath, submissionSummarySchema } from "./index.js"

describe("v1.7.0 sample and summary schemas", () => {
  it("a redacted form answer carries no value; unknown sources are refused", () => {
    expect(formAnswerSchema.safeParse({ question: "Veteran?", source: "approved_answer_sensitive", value: null, redacted: true, blockedReason: null }).success).toBe(true)
    expect(formAnswerSchema.safeParse({ question: "Q", source: "model_guess", value: "x", redacted: false, blockedReason: null }).success).toBe(false)
  })

  it("the summary is strict and counts are non-negative integers", () => {
    const ok = { samples: { awaitingReview: 1, approved: 2, rejected: 0 }, blocked: 0, held: 0, uncertain: 3 }
    expect(submissionSummarySchema.safeParse(ok).success).toBe(true)
    expect(submissionSummarySchema.safeParse({ ...ok, blocked: -1 }).success).toBe(false)
    expect(submissionSummarySchema.safeParse({ ...ok, extra: 1 }).success).toBe(false)
  })

  it("builds the paths", () => {
    expect(samplesPath("awaiting_review")).toBe("/v1/samples?state=awaiting_review")
    expect(formAnswersPath("abc")).toBe("/v1/applications/abc/form-answers")
  })
})

describe("v1.8.0 sample approval hand-off", () => {
  it("a fresh approval may answer pending; unknown results are refused", () => {
    const base = { alreadyDone: false, countingSamples: 0, gatePassedAt: null }
    expect(sampleResultSchema.safeParse({ ...base, result: "pending" }).success).toBe(true)
    expect(sampleResultSchema.safeParse({ ...base, result: "queued" }).success).toBe(false)
  })
})
