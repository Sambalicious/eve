import { describe, expect, it } from "vitest"

import type { ApplicationDetail, ApplicationOverride } from "./application"
import { dropLine, overrideFactValue, overrideInactiveBody, showsOverrideInactive } from "./override-view"

const override = (o: Partial<ApplicationOverride> = {}): ApplicationOverride => ({
  createdAt: "2026-10-29T09:00:00.000Z",
  status: "skipped",
  skipReason: "weak_core_match",
  skipDetail: null,
  violatedRules: [],
  applies: false,
  notAppliesReason: "decision_changed",
  ...o,
})

const app = (o: Partial<ApplicationDetail> = {}): ApplicationDetail =>
  ({ detailsDeletedAt: null, override: override(), posting: { status: "excluded", hidden: false }, latestDrop: null, ...o }) as ApplicationDetail

describe("overrideFactValue (C-AA-17, C-AA-18, C-AA-19)", () => {
  it.each([
    [override(), "Chosen on 29 Oct 2026 despite your profile backing too few of the core responsibilities"],
    [override({ skipReason: "no_core_responsibilities" }), "Chosen on 29 Oct 2026 despite no core responsibilities found"],
    [override({ skipReason: "uncovered_mandatory_prerequisite", skipDetail: "Active security clearance" }), 'Chosen on 29 Oct 2026 despite your profile not showing a required prerequisite "Active security clearance"'],
    [override({ status: "excluded", skipReason: "violated_rule", skipDetail: "industry", violatedRules: ["industry"] }), "Chosen on 29 Oct 2026 despite the posting not fitting your industry rule"],
    [override({ status: null, skipReason: null, skipDetail: null, violatedRules: null }), "Chosen on 29 Oct 2026. The reason wasn't recorded."],
  ])("%#", (o, text) => expect(overrideFactValue(o, "29 Oct 2026")).toBe(text))
})

describe("showsOverrideInactive (AA-4.5 r1)", () => {
  it("shows for a non-applying override, not-ranked posting, state none or queued, details present", () => {
    expect(showsOverrideInactive(app(), { state: null })).toBe(true)
    expect(showsOverrideInactive(app(), { state: "queued" })).toBe(true)
  })
  it.each(["confirmed", "uncertain", "blocked", "manual", "declined", "submitting", "submit_claimed", "not_submitted"] as const)("not past the queue: %s", (state) => {
    expect(showsOverrideInactive(app(), { state })).toBe(false)
  })
  it("not when it applies, the posting is ranked or unknown, no override, or details deleted", () => {
    expect(showsOverrideInactive(app({ override: override({ applies: true, notAppliesReason: null }) }), { state: null })).toBe(false)
    expect(showsOverrideInactive(app({ posting: { status: "ranked", hidden: false } }), { state: null })).toBe(false)
    expect(showsOverrideInactive(app({ posting: null }), { state: null })).toBe(false)
    expect(showsOverrideInactive(app({ override: null }), { state: null })).toBe(false)
    expect(showsOverrideInactive(app({ detailsDeletedAt: "2026-10-29T09:00:00.000Z" }), { state: null })).toBe(false)
  })
})

describe("overrideInactiveBody", () => {
  it.each([
    ["decision_changed", "The posting's decision changed after you chose this, so Eve won't send it automatically. Decide again from the posting."],
    ["hidden", "The posting is now hidden from your board, so Eve won't send this Application automatically."],
    ["legacy_no_decision", "You chose this before Eve recorded reasons, so Eve won't send it automatically. Decide again from the posting to confirm the current reason."],
    [null, "The posting's decision changed after you chose this, so Eve won't send it automatically. Decide again from the posting."],
  ] as const)("%s", (reason, text) => expect(overrideInactiveBody(override({ notAppliesReason: reason }))).toBe(text))
})

describe("dropLine (B3a)", () => {
  const dropped = (reason: "closed" | "not_submittable") => app({ override: null, latestDrop: { at: "2026-10-29T09:00:00.000Z", reason } })
  it("C-AA-40 for a closed posting, C-AA-41 otherwise", () => {
    expect(dropLine(dropped("closed"), { state: null }, "29 Oct 2026")).toBe("Left the automatic queue on 29 Oct 2026 because the posting closed. Nothing was sent, and its documents are kept.")
    expect(dropLine(dropped("not_submittable"), { state: null }, "29 Oct 2026")).toBe("Left the automatic queue on 29 Oct 2026 because the posting no longer qualifies. Nothing was sent, and its documents are kept.")
  })
  it("never with the alert, and not once queued again", () => {
    expect(dropLine({ ...app(), latestDrop: { at: "2026-10-29T09:00:00.000Z", reason: "not_submittable" } }, { state: null }, "29 Oct 2026")).toBeNull()
    expect(dropLine(dropped("closed"), { state: "queued" }, "29 Oct 2026")).toBeNull()
  })
})
