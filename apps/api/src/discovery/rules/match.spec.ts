import { describe, expect, it } from "vitest"

import { matchVerdict } from "./job-criteria.js"
import { type MatchInput, evaluateMatch } from "./match.js"
import { classifyRoleFamily, rankPostings } from "./ranking.js"

const FACTS = new Set(["F1", "F2", "F3", "F4"])

function items(total: number, covered: number) {
  return Array.from({ length: total }, (_, index) => ({ text: `Responsibility ${index + 1}`, factId: index < covered ? "F1" : null }))
}

/** Match evidence plus the verdict under a minimum core Match (EPIC-0004: the Candidate's, default 70). */
function match(partial: Partial<MatchInput>, minCoreMatchPercent = 70) {
  const outcome = evaluateMatch({ core: [], mandatory: [], niceToHave: [], ...partial }, FACTS)
  const counts = { coveredCount: outcome.coveredCount, totalCount: outcome.totalCount, unmetMandatoryCount: outcome.unmetMandatory.length }
  return { ...outcome, ...matchVerdict(counts, minCoreMatchPercent) }
}

describe("strong core Match (AC 4.10, 4.11)", () => {
  it.each([
    [10, 7, "strong"],
    [10, 6, "weak"],
    [3, 2, "weak"],
    [3, 3, "strong"],
    [1, 1, "strong"],
    [7, 5, "strong"],
  ])("%i core responsibilities with %i covered is %s", (total, covered, verdict) => {
    expect(match({ core: items(total, covered) }).verdict).toBe(verdict)
  })

  it("reports covered, total and the coverage reason", () => {
    const result = match({ core: items(3, 2) })
    expect(result).toMatchObject({ coveredCount: 2, totalCount: 3, weakReason: "coverage_below_threshold" })
  })

  it("one uncovered mandatory prerequisite fails the Match even at 100% coverage", () => {
    const result = match({ core: items(5, 5), mandatory: [{ text: "Professional Kotlin Android experience", factId: null }] })
    expect(result.verdict).toBe("weak")
    expect(result.weakReason).toBe("unmet_mandatory")
    expect(result.unmetMandatory).toEqual(["Professional Kotlin Android experience"])
  })

  it.each([
    [3, 0, "strong"],
    [3, 1, "weak"],
    [0, 1, "weak"],
  ])("%i covered and %i uncovered mandatory prerequisites", (covered, uncovered, verdict) => {
    const mandatory = [...items(covered, covered), ...Array.from({ length: uncovered }, () => ({ text: "Clearance", factId: null }))]
    expect(match({ core: items(1, 1), mandatory }).verdict).toBe(verdict)
  })

  it("the unmet-mandatory reason wins when coverage is also low", () => {
    expect(match({ core: items(3, 1), mandatory: [{ text: "Clearance", factId: null }] }).weakReason).toBe("unmet_mandatory")
  })

  it("no identifiable core responsibilities is weak", () => {
    const result = match({ core: [] })
    expect(result.verdict).toBe("weak")
    expect(result.weakReason).toBe("no_core_responsibilities")
  })

  it("missing nice-to-have skills never weaken the Match", () => {
    expect(match({ core: items(2, 2), niceToHave: [{ text: "GraphQL", factId: null }] }).verdict).toBe("strong")
  })

  it("a fact ID that is not in the approved Career Profile counts as not covered", () => {
    const result = match({ core: [{ text: "Build React features", factId: "F99" }] })
    expect(result.core[0]?.factId).toBeNull()
    expect(result.verdict).toBe("weak")
  })

  it("the threshold is the Candidate's minimum core Match: 6 of 10 is strong at 60%", () => {
    expect(match({ core: items(10, 6) }, 60).verdict).toBe("strong")
  })

  it("never rounds: 69.99% fails a 70% threshold", () => {
    const core = items(10_000, 6_999)
    expect(match({ core }).verdict).toBe("weak")
  })
})

describe("total-experience prerequisites, decided on the profile's tenure (no model arithmetic)", () => {
  const years = [{ text: "5+ years of overall software engineering experience", factId: null }]

  it("is covered when the profile's months reach the number", () => {
    const outcome = evaluateMatch({ core: items(1, 1), mandatory: years, niceToHave: [] }, FACTS, 63)
    expect(outcome.unmetMandatory).toEqual([])
    expect(outcome.mandatory[0]).toMatchObject({ factId: null, byTenure: true })
  })

  it("stays unmet one month short", () => {
    const outcome = evaluateMatch({ core: items(1, 1), mandatory: years, niceToHave: [] }, FACTS, 59)
    expect(outcome.unmetMandatory).toEqual(["5+ years of overall software engineering experience"])
  })

  it("is unmet when tenure is unknown (0), as before this rule", () => {
    expect(evaluateMatch({ core: items(1, 1), mandatory: years, niceToHave: [] }, FACTS).unmetMandatory).toHaveLength(1)
  })

  it("never answers a qualified requirement from tenure", () => {
    const qualified = [
      "8+ years of software engineering experience, including 3+ years at Staff, Principal level",
      "5+ years of experience with C++",
      "6+ years of software engineering experience, including 3+ years in cloud computing",
    ]
    const outcome = evaluateMatch(
      { core: items(1, 1), mandatory: qualified.map((text) => ({ text, factId: null })), niceToHave: [] },
      FACTS,
      240
    )
    expect(outcome.unmetMandatory).toEqual(qualified)
  })

  it("leaves a fact-covered prerequisite exactly as it was", () => {
    const outcome = evaluateMatch({ core: items(1, 1), mandatory: [{ text: "5+ years of experience", factId: "F1" }], niceToHave: [] }, FACTS, 0)
    expect(outcome.unmetMandatory).toEqual([])
    expect(outcome.mandatory[0]?.byTenure).toBeUndefined()
  })
})

describe("Role Preference ranking (AC 4.11, 4.12)", () => {
  it.each([
    ["Senior Frontend Engineer", [], "senior_frontend"],
    ["Frontend Tech Lead", ["Lead the frontend team", "Write production React code"], "technical_lead"],
    ["Fullstack Engineer", [], "fullstack"],
    ["Product Engineer", [], "product_engineering"],
    ["Staff Software Engineer, Frontend", [], "senior_frontend"],
  ])("%s is %s", (title, core, family) => {
    expect(classifyRoleFamily(title, core)).toBe(family)
  })

  it("a people-management role is never a hands-on technical lead", () => {
    const family = classifyRoleFamily("Engineering Manager", ["hiring, performance reviews, and line management of 12 engineers"])
    expect(family).toBe("people_management")
  })

  it("ranks senior frontend and technical lead above fullstack and product engineering, keeping all of them", () => {
    const ranked = rankPostings([
      { id: "umbrella", family: "product_engineering", coverage: 0.9, discoveredAt: new Date("2026-10-20T07:00:00Z"), fromEmployerBoard: false },
      { id: "initech", family: "fullstack", coverage: 0.9, discoveredAt: new Date("2026-10-20T07:00:00Z"), fromEmployerBoard: false },
      { id: "acme", family: "senior_frontend", coverage: 0.7, discoveredAt: new Date("2026-10-20T07:00:00Z"), fromEmployerBoard: false },
      { id: "globex", family: "technical_lead", coverage: 0.8, discoveredAt: new Date("2026-10-20T07:00:00Z"), fromEmployerBoard: false },
    ])
    expect(ranked.slice(0, 2).sort()).toEqual(["acme", "globex"])
    expect(ranked.slice(2).sort()).toEqual(["initech", "umbrella"])
  })

  it("slice 5 prework: an employer-board posting ranks above an equally matched remote-board posting", () => {
    const at = new Date("2026-10-20T07:00:00Z")
    const ranked = rankPostings([
      { id: "a-remote", family: "senior_frontend", coverage: 0.8, discoveredAt: new Date("2026-10-20T06:00:00Z"), fromEmployerBoard: false },
      { id: "z-employer", family: "senior_frontend", coverage: 0.8, discoveredAt: at, fromEmployerBoard: true },
    ])
    expect(ranked).toEqual(["z-employer", "a-remote"])
  })

  it("source never outranks Role Preference or a better Match", () => {
    const at = new Date("2026-10-20T07:00:00Z")
    const ranked = rankPostings([
      { id: "employer-fullstack", family: "fullstack", coverage: 0.9, discoveredAt: at, fromEmployerBoard: true },
      { id: "employer-weaker", family: "senior_frontend", coverage: 0.6, discoveredAt: at, fromEmployerBoard: true },
      { id: "remote-stronger", family: "senior_frontend", coverage: 0.9, discoveredAt: at, fromEmployerBoard: false },
    ])
    expect(ranked).toEqual(["remote-stronger", "employer-weaker", "employer-fullstack"])
  })

  it("an empty list ranks to an empty list", () => {
    expect(rankPostings([])).toEqual([])
  })
})
