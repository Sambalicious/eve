import { describe, expect, it } from "vitest"

import { type OverrideColumns, type PostingDecisionState, applicationOverride, decisionOf, dropDetail, overrideReasonShort, storedDecision } from "./override.js"

/** api-contract.md v1.24.0 "Apply anyway: bounds and consent", Terms; Gherkin apply-anyway.feature. */
const KOTLIN = "Professional Kotlin Android experience"
const stored = (decision: Partial<OverrideColumns> = {}): OverrideColumns => ({
  candidate_override_at: null,
  override_created_at: new Date("2026-10-29T09:00:00Z"),
  override_status: "skipped",
  override_skip_reason: "uncovered_mandatory_prerequisite",
  override_skip_detail: KOTLIN,
  override_violated_rules: [],
  details_deleted_at: null,
  ...decision,
})
const LEGACY: OverrideColumns = { ...stored(), override_created_at: null, candidate_override_at: new Date("2026-10-28T11:00:00Z"), override_status: null, override_skip_reason: null, override_skip_detail: null, override_violated_rules: null }
const posting = (state: Partial<PostingDecisionState>): PostingDecisionState => ({
  decision: { status: "skipped", skipReason: "uncovered_mandatory_prerequisite", skipDetail: KOTLIN, violatedRules: [] },
  hidden: false,
  evaluationFailure: null,
  ...state,
})

describe("decisionOf: violated rules (apply-anyway.feature:78, :110)", () => {
  it("counts violated rules only, unverified and met are not violations, in the server order", () => {
    const rules = [
      { rule: "industry", result: "violated", quote: null },
      { rule: "pay", result: "unverified", quote: null },
      { rule: "location", result: "met", quote: null },
    ]
    expect(decisionOf({ status: "excluded", skip_reason: "violated_rule", skip_detail: "industry" }, rules)).toEqual({ status: "excluded", skipReason: "violated_rule", skipDetail: "industry", violatedRules: ["industry"] })
  })

  it("keeps an unknown stored rule (commute) and sorts known rules first", () => {
    const rules = [
      { rule: "commute", result: "violated", quote: null },
      { rule: "industry", result: "violated", quote: null },
      { rule: "location", result: "violated", quote: null },
    ]
    expect(decisionOf({ status: "excluded", skip_reason: "violated_rule", skip_detail: "location" }, rules).violatedRules).toEqual(["location", "industry", "commute"])
  })

  it("no Eligibility result is []; an unknown skip reason reads as null", () => {
    expect(decisionOf({ status: "skipped", skip_reason: "weak_core_match", skip_detail: null }, null).violatedRules).toEqual([])
    expect(decisionOf({ status: "skipped", skip_reason: "not_a_reason", skip_detail: null }, null).skipReason).toBeNull()
  })
})

describe("applicationOverride: applies and notAppliesReason (apply-anyway.feature:283 outline)", () => {
  const read = (state: Partial<PostingDecisionState> | null) => applicationOverride(stored(), state === null ? null : posting(state))
  it.each([
    ["same decision", {}, true, null],
    ["visible and ranked", { decision: { status: "ranked", skipReason: null, skipDetail: null, violatedRules: [] } }, true, null],
    ["another prerequisite", { decision: { status: "skipped", skipReason: "uncovered_mandatory_prerequisite", skipDetail: "Active security clearance", violatedRules: [] } }, false, "decision_changed"],
    ["weak core Match", { decision: { status: "skipped", skipReason: "weak_core_match", skipDetail: null, violatedRules: [] } }, false, "decision_changed"],
    ["excluded location", { decision: { status: "excluded", skipReason: "violated_rule", skipDetail: "location", violatedRules: ["location"] } }, false, "decision_changed"],
    ["evaluation_failed", { decision: { status: "evaluation_failed", skipReason: null, skipDetail: null, violatedRules: [] } }, false, "decision_changed"],
    ["checking", { decision: { status: "checking", skipReason: null, skipDetail: null, violatedRules: [] } }, false, "decision_changed"],
    ["waiting_to_be_checked", { decision: { status: "waiting_to_be_checked", skipReason: null, skipDetail: null, violatedRules: [] } }, false, "decision_changed"],
    ["not_checked", { decision: { status: "not_checked", skipReason: null, skipDetail: null, violatedRules: [] } }, false, "decision_changed"],
    ["hidden, same decision", { hidden: true }, false, "hidden"],
    ["hidden and ranked", { hidden: true, decision: { status: "ranked", skipReason: null, skipDetail: null, violatedRules: [] } }, false, "hidden"],
    ["hidden and excluded location", { hidden: true, decision: { status: "excluded", skipReason: "violated_rule", skipDetail: "location", violatedRules: ["location"] } }, false, "hidden"],
  ] as const)("%s: applies %s, reason %s", (_name, state, applies, reason) => {
    expect(read(state as Partial<PostingDecisionState>)).toMatchObject({ applies, notAppliesReason: reason })
  })

  it("a posting the Candidate no longer holds is decision_changed", () => {
    expect(read(null)).toMatchObject({ applies: false, notAppliesReason: "decision_changed" })
  })

  it("echoes the stored decision and createdAt", () => {
    expect(read({})).toEqual({ createdAt: "2026-10-29T09:00:00.000Z", status: "skipped", skipReason: "uncovered_mandatory_prerequisite", skipDetail: KOTLIN, violatedRules: [], applies: true, notAppliesReason: null })
  })

  it("no override recorded, or details deleted: null (apply-anyway.feature:712, :821)", () => {
    expect(applicationOverride({ ...LEGACY, candidate_override_at: null }, posting({}))).toBeNull()
    expect(applicationOverride({ ...stored(), details_deleted_at: new Date() }, posting({}))).toBeNull()
  })

  it("legacy: no decision, never applies (:471); hidden first (:480); applies on a visible ranked posting (:488, N1)", () => {
    expect(applicationOverride(LEGACY, posting({ decision: { status: "skipped", skipReason: "weak_core_match", skipDetail: null, violatedRules: [] } }))).toEqual({
      createdAt: "2026-10-28T11:00:00.000Z",
      status: null,
      skipReason: null,
      skipDetail: null,
      violatedRules: null,
      applies: false,
      notAppliesReason: "legacy_no_decision",
    })
    expect(applicationOverride(LEGACY, posting({ hidden: true }))).toMatchObject({ applies: false, notAppliesReason: "hidden" })
    expect(applicationOverride(LEGACY, posting({ decision: { status: "ranked", skipReason: null, skipDetail: null, violatedRules: [] } }))).toMatchObject({ applies: true, notAppliesReason: null })
  })

  it("TM-F-03: a stored decision that is not overridable never applies, even when it equals the current one", () => {
    const location = stored({ override_status: "excluded", override_skip_reason: "violated_rule", override_skip_detail: "location", override_violated_rules: ["location"] })
    expect(applicationOverride(location, posting({ decision: { status: "excluded", skipReason: "violated_rule", skipDetail: "location", violatedRules: ["location"] } }))).toMatchObject({ applies: false, notAppliesReason: "decision_changed" })
  })

  it("violated rules compare as sets (:237, :354)", () => {
    const industry = stored({ override_status: "excluded", override_skip_reason: "violated_rule", override_skip_detail: "industry", override_violated_rules: ["industry"] })
    expect(applicationOverride(industry, posting({ decision: { status: "excluded", skipReason: "violated_rule", skipDetail: "industry", violatedRules: ["industry"] } }))?.applies).toBe(true)
    expect(applicationOverride(industry, posting({ decision: { status: "excluded", skipReason: "violated_rule", skipDetail: "industry", violatedRules: ["location", "industry"] } }))?.applies).toBe(false)
  })
})

describe("dropDetail: the three checks (contract 'Automatic submission', drop detail table)", () => {
  const ranked: PostingDecisionState["decision"] = { status: "ranked", skipReason: null, skipDetail: null, violatedRules: [] }
  it("submittable: visible ranked with no override, a legacy override or a stale override (N1)", () => {
    expect(dropDetail(null, posting({ decision: ranked }))).toBeNull()
    expect(dropDetail(LEGACY, posting({ decision: ranked }))).toBeNull()
    expect(dropDetail(stored({ override_skip_reason: "weak_core_match", override_skip_detail: null }), posting({ decision: ranked }))).toBeNull()
  })

  it("submittable: a stored decision equal to the current one", () => {
    expect(dropDetail(stored(), posting({}))).toBeNull()
  })

  it("closed: evaluation_failed with posting_unavailable, override or not", () => {
    const closed = posting({ decision: { status: "evaluation_failed", skipReason: null, skipDetail: null, violatedRules: [] }, evaluationFailure: "posting_unavailable" })
    expect(dropDetail(null, closed)).toBe("closed")
    expect(dropDetail(stored(), closed)).toBe("closed")
  })

  it("hidden before override_mismatch and not_ranked", () => {
    expect(dropDetail(stored(), posting({ hidden: true }))).toBe("hidden")
    expect(dropDetail(null, posting({ hidden: true, decision: ranked }))).toBe("hidden")
  })

  it("override_mismatch for a recorded override (legacy included) that doesn't apply; not_ranked without one", () => {
    const changed = posting({ decision: { status: "skipped", skipReason: "weak_core_match", skipDetail: null, violatedRules: [] } })
    expect(dropDetail(stored(), changed)).toBe("override_mismatch")
    expect(dropDetail(LEGACY, changed)).toBe("override_mismatch")
    expect(dropDetail(null, changed)).toBe("not_ranked")
    expect(dropDetail(null, posting({ decision: { status: "checking", skipReason: null, skipDetail: null, violatedRules: [] } }))).toBe("not_ranked")
  })

  it("a posting the Candidate no longer holds is not submittable", () => {
    expect(dropDetail(null, null)).toBe("not_ranked")
    expect(dropDetail(stored(), null)).toBe("override_mismatch")
  })
})

describe("storedDecision and overrideReasonShort (copy deck reason mapping, C-AA-32)", () => {
  it("a legacy override has no stored decision", () => {
    expect(storedDecision(LEGACY)).toBeNull()
  })

  it.each([
    [{ override_skip_reason: "weak_core_match", override_skip_detail: null }, "your profile backing too few of the core responsibilities"],
    [{ override_skip_reason: "no_core_responsibilities", override_skip_detail: null }, "no core responsibilities found"],
    [{ override_skip_reason: "uncovered_mandatory_prerequisite", override_skip_detail: "Active security clearance" }, 'your profile not showing a required prerequisite "Active security clearance"'],
    [{ override_status: "excluded", override_skip_reason: "violated_rule", override_skip_detail: "industry", override_violated_rules: ["industry"] }, "the posting not fitting your industry rule"],
  ] as const)("%o reads as %s", (columns, reason) => {
    expect(overrideReasonShort(storedDecision(stored(columns as Partial<OverrideColumns>))!)).toBe(reason)
  })
})
