import { describe, expect, it } from "vitest"

import { decisionCriteria } from "../discovery/rules/job-criteria.js"
import { type StoredDecision, redecide } from "./redecide.js"

const REACT = decisionCriteria({ minCoreMatchPercent: 70, frameworks: ["React"], technologies: [] })
const OFF = decisionCriteria({ minCoreMatchPercent: 70, frameworks: [], technologies: [] })

function row(technologyNames: readonly unknown[] | null, overrides: Partial<StoredDecision> = {}): StoredDecision {
  return { id: "p1", status: "ranked", skipReason: null, verdict: "strong", coveredCount: 8, totalCount: 10, technologyNames, ...overrides }
}

// SEC-008, prd.r3 AC 5.11: a malformed stored technology entry is ignored (not mentioned) and never fails re-decision.
describe("malformed stored technology names (SEC-008, AC 5.11)", () => {
  const malformed: [string, unknown][] = [
    ["null (missing or null name, or a non-object entry)", null],
    ["undefined", undefined],
    ["a number", 42],
    ["an object", { react: true }],
    ["an array", ["React"]],
    ["a boolean", true],
  ]

  it.each(malformed)("a name that is %s counts as not mentioned", (_label, name) => {
    expect(() => redecide([row([name])], REACT)).not.toThrow()
    expect(redecide([row([name])], REACT).changed).toEqual([
      { id: "p1", status: "skipped", skipReason: "technology_mismatch", verdict: "strong", weakReason: null, previousStatus: "ranked" },
    ])
  })

  it.each(malformed)("next to a malformed name (%s), a valid listed name still matches", (_label, name) => {
    const result = redecide([row([name, "ReactJS"], { status: "skipped", skipReason: "technology_mismatch" })], REACT)
    expect(result.changed.map((change) => change.status)).toEqual(["ranked"])
  })

  it("only malformed names with the criterion off: no change", () => {
    expect(redecide([row([null, 42])], OFF)).toEqual({ considered: 1, changed: [] })
  })

  it("only malformed names is technology data with none mentioned, not 'not checked'", () => {
    expect(redecide([row([null])], REACT).changed[0]?.skipReason).toBe("technology_mismatch")
    expect(redecide([row(null)], REACT).changed).toEqual([])
  })

  it("a malformed row does not affect the other rows of the same re-decision", () => {
    const rows = [row([null], { id: "bad" }), row(["React"], { id: "good" }), row(["PHP"], { id: "php" })]
    const { considered, changed } = redecide(rows, REACT)
    expect(considered).toBe(3)
    expect(changed.map((change) => [change.id, change.skipReason])).toEqual([
      ["bad", "technology_mismatch"],
      ["php", "technology_mismatch"],
    ])
  })
})
