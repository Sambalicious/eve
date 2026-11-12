import { describe, expect, it } from "vitest"

import type { Match } from "@/entities/job-posting"
import { matchLines } from "./match-lines"

const base: Match = {
  verdict: "weak",
  weakReason: null,
  covered: 0,
  total: 0,
  thresholdPercent: 70,
  careerProfileVersion: 1,
  coreResponsibilities: [],
  mandatoryPrerequisites: [],
  niceToHave: [],
}
const RULE_70 =
  "A strong core Match needs at least 70% of the core responsibilities backed by a fact in your Career Profile, and no unmet mandatory requirement."

describe("matchLines (C-MATCH-1 to C-MATCH-5)", () => {
  it("strong: coverage and rule, no reason", () => {
    expect(matchLines({ ...base, verdict: "strong", covered: 7, total: 10 })).toEqual({
      coverage: "7 of 10 core responsibilities backed by a fact (70%).",
      reason: null,
      rule: RULE_70,
    })
  })

  it("rounds coverage down, so 2 of 3 reads 66% and 69.9% never reads as 70%", () => {
    const lines = matchLines({ ...base, weakReason: "coverage_below_threshold", covered: 2, total: 3 })
    expect(lines.reason).toBe("Weak because only 66% of the core responsibilities are backed by a fact. It needs 70%.")
    expect(lines.coverage).toBeNull()
    expect(matchLines({ ...base, verdict: "strong", covered: 699, total: 1000 }).coverage).toContain("(69%)")
  })

  it("unmet mandatory: names the first unmet requirement, singular and plural", () => {
    const one = matchLines({
      ...base,
      weakReason: "unmet_mandatory",
      covered: 5,
      total: 5,
      mandatoryPrerequisites: [
        { text: "5+ years TypeScript", factId: "F1", factText: "x" },
        { text: "Professional Kotlin Android experience", factId: null, factText: null },
      ],
    })
    expect(one.reason).toBe(
      'Weak because a mandatory requirement isn\'t met: "Professional Kotlin Android experience". No fact in your Career Profile covers it.'
    )
    expect(one.coverage).toBe("5 of 5 core responsibilities backed by a fact (100%).")
    const two = matchLines({
      ...base,
      weakReason: "unmet_mandatory",
      mandatoryPrerequisites: [
        { text: "Active security clearance", factId: null, factText: null },
        { text: "Kotlin", factId: null, factText: null },
      ],
    })
    expect(two.reason).toBe(
      'Weak because 2 mandatory requirements aren\'t met, starting with "Active security clearance". No fact in your Career Profile covers them.'
    )
  })

  it("no core responsibilities: C-MATCH-5 and the rule only", () => {
    expect(matchLines({ ...base, weakReason: "no_core_responsibilities" })).toEqual({
      coverage: null,
      reason: "Weak because the assistant couldn't find any core responsibilities in this posting, so there's nothing to match against.",
      rule: RULE_70,
    })
  })

  it("prints the threshold the backend reports", () => {
    expect(matchLines({ ...base, verdict: "strong", thresholdPercent: 60, covered: 6, total: 10 }).rule).toContain("at least 60%")
  })
})
