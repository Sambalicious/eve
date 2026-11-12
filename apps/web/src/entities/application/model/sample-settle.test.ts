import { describe, expect, it } from "vitest"

import { isSampleSubmitting, settledSampleResult, type Submission } from "./submission"

const base: Submission = {
  state: null,
  kind: "sample",
  attemptNumber: 0,
  submittedAt: null,
  submittedWatDay: null,
  evidence: null,
  captchaAfterSubmit: false,
  blocked: null,
  queuedForWatDay: null,
  sample: { state: "approved", rejectReason: null, counts: false },
  declinedReason: null,
  declinedAt: null,
  markedNotSubmittedAt: null,
  manualCompletedAt: null,
  override: null,
}
const sub = (o: Partial<Submission>): Submission => ({ ...base, ...o })
const awaiting = { state: "awaiting_review", rejectReason: null, counts: false } as const

describe("isSampleSubmitting (v1.8.0 pending)", () => {
  it("is true for an approved sample with no state, and while claimed or submitting", () => {
    expect(isSampleSubmitting(sub({}))).toBe(true)
    expect(isSampleSubmitting(sub({ state: "submit_claimed" }))).toBe(true)
    expect(isSampleSubmitting(sub({ state: "submitting" }))).toBe(true)
  })
  it("is false for an awaiting sample, a non-sample, or a finished one", () => {
    expect(isSampleSubmitting(sub({ sample: awaiting }))).toBe(false)
    expect(isSampleSubmitting(sub({ sample: null, kind: null }))).toBe(false)
    expect(isSampleSubmitting(sub({ state: "confirmed" }))).toBe(false)
  })
})

describe("settledSampleResult", () => {
  it("is null while the worker hasn't finished", () => {
    for (const state of [null, "submit_claimed", "submitting"] as const) expect(settledSampleResult(sub({ state }))).toBeNull()
  })
  it("maps the worker's outcome", () => {
    expect(settledSampleResult(sub({ state: "confirmed" }))).toBe("confirmed")
    expect(settledSampleResult(sub({ state: "uncertain" }))).toBe("uncertain")
    const blocked = (reason: "login" | "same_company_review") => ({ reason, subReason: null, detail: null, question: null, at: null })
    expect(settledSampleResult(sub({ state: "blocked", blocked: blocked("login") }))).toBe("blocked")
    expect(settledSampleResult(sub({ state: "blocked", blocked: blocked("same_company_review") }))).toBe("held")
  })
  it("an approved sample ended not_submitted was refused as a duplicate (C-SAMPLE-4)", () => {
    expect(settledSampleResult(sub({ state: "not_submitted" }))).toBe("duplicate")
  })
  it("back in awaiting review means nothing was sent (C-SAMPLE-13)", () => {
    expect(settledSampleResult(sub({ sample: awaiting }))).toBe("not_submitted")
  })
})
