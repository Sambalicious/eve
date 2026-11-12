import { describe, expect, it } from "vitest"

import { criteriaNoteReason, type CriteriaNotePosting } from "./criteria-note"

const posting = (o: Partial<CriteriaNotePosting> = {}): CriteriaNotePosting => ({
  status: "skipped",
  skipReason: "weak_core_match",
  skipDetail: null,
  applicationSystem: "Greenhouse",
  coverage: { covered: 7, total: 10, thresholdPercent: 80 },
  ...o,
})

describe("criteriaNoteReason (g9 show rule, posting part)", () => {
  it("weak_core_match with numbers: C-JC-SKIP-WEAK", () => {
    expect(criteriaNoteReason(posting())).toBe("Your profile backs only 70% of the core responsibilities. Your minimum is 80%.")
  })

  it.each([null, { covered: 0, total: 0, thresholdPercent: 80 }])("weak_core_match with coverage %j: C-SKIP-4", (coverage) => {
    expect(criteriaNoteReason(posting({ coverage }))).toBe("Your profile doesn't back enough of the core responsibilities.")
  })

  it("technology_mismatch: C-JC-SKIP-TECH", () => {
    expect(criteriaNoteReason(posting({ skipReason: "technology_mismatch" }))).toBe("This job doesn't mention the technologies you told Eve to look for.")
  })

  it.each<Partial<CriteriaNotePosting>>([
    { status: "ranked", skipReason: null },
    { status: "excluded", skipReason: "violated_rule", skipDetail: "location" },
    { skipReason: "uncovered_mandatory_prerequisite", skipDetail: "Go" },
    { skipReason: "no_core_responsibilities" },
    { skipReason: "not_software_role" },
    { skipReason: "unsupported_application_system" },
    { skipReason: null },
    { status: "checking", skipReason: null },
    { status: "waiting_to_be_checked", skipReason: null },
    { status: "evaluation_failed", skipReason: null },
    // A non-skipped status never shows the note, even with a criteria reason left over.
    { status: "ranked", skipReason: "weak_core_match" },
  ])("no note for %j", (o) => {
    expect(criteriaNoteReason(posting(o))).toBeNull()
  })

  it("no note while the posting is not loaded", () => {
    expect(criteriaNoteReason(undefined)).toBeNull()
  })
})
