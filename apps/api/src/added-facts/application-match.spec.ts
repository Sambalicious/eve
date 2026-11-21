import { describe, expect, it } from "vitest"

import { decisionCriteria } from "../discovery/rules/job-criteria.js"
import { applicationMatch, type ApplicationMatchInput, type AddedFactForMatch, type MatchItemLike } from "./application-match.js"

const ITEMS: MatchItemLike[] = [
  { group: "core", text: "Build design systems with React", factId: "f1" },
  { group: "core", text: "Own the CI/CD pipelines", factId: null },
  { group: "core", text: "Own the design process end to end", factId: null },
  { group: "core", text: "Mentor junior engineers", factId: "f3" },
  { group: "core", text: "Ship weekly with TypeScript", factId: "f1" },
  { group: "core", text: "Review pull requests", factId: null },
  { group: "core", text: "Write frontend tests", factId: null },
  { group: "core", text: "Work with product", factId: null },
  { group: "core", text: "Maintain a component library", factId: null },
  { group: "core", text: "Run releases", factId: null },
  { group: "mandatory", text: "Experience with React", factId: "f1" },
]

function input(overrides: Partial<ApplicationMatchInput> = {}): ApplicationMatchInput {
  return {
    profileVersion: 1,
    addedFactsVersion: 4,
    criteriaVersion: 1,
    items: ITEMS,
    approvedFactIds: new Set(["f1", "f3"]),
    tenureMonths: 48,
    criteria: decisionCriteria({ minCoreMatchPercent: 70, frameworks: [], technologies: [] }),
    technologyNames: null,
    postingStatus: "skipped",
    skipReason: "weak_core_match",
    violatedRules: [],
    manualOnly: false,
    addedFacts: [],
    ...overrides,
  }
}

const oneLiner = (id: string, text: string, extra: Partial<AddedFactForMatch> = {}): AddedFactForMatch => ({ id, kind: "one_liner", text, term: null, roleInProfile: true, ...extra })
const skillOnly = (id: string, text: string): AddedFactForMatch => ({ id, kind: "skill_only", text, term: text, roleInProfile: true })

describe("FEAT-0017 Application Match", () => {
  it("with no added facts the with-added numbers equal the posting numbers", () => {
    const match = applicationMatch(input())
    expect(match.withAdded).toEqual(match.posting)
    expect(match.covers).toEqual([])
    expect(match.posting).toEqual({ covered: 3, total: 10, unmetMandatory: 0, verdict: "weak" })
  })

  it("a one-liner covers a core responsibility by its wording", () => {
    const match = applicationMatch(input({ addedFacts: [oneLiner("a1", "Owned the CI/CD pipelines at Acme")] }))
    expect(match.withAdded.covered).toBe(4)
    expect(match.covers).toEqual([{ group: "core", requirement: "Own the CI/CD pipelines", factId: "a1", kind: "one_liner" }])
  })

  it("Figma never covers a requirement that does not name it (OD-12)", () => {
    const match = applicationMatch(input({ addedFacts: [skillOnly("a1", "Figma")] }))
    expect(match.withAdded).toEqual(match.posting)
    expect(match.covers).toEqual([])
  })

  it("a skill-only term covers a requirement that names it (OD-19: a word inside a longer requirement)", () => {
    const match = applicationMatch(input({ addedFacts: [skillOnly("a1", "library")] }))
    expect(match.covers).toMatchObject([{ requirement: "Maintain a component library", factId: "a1", kind: "skill_only" }])
  })

  it("a fact matching nothing changes nothing", () => {
    const match = applicationMatch(input({ addedFacts: [oneLiner("a1", "Mentored 3 interns at Acme in a hackathon")] }))
    expect(match.withAdded.covered).toBe(3)
  })

  it("a profile-covered item is counted once and never listed", () => {
    const match = applicationMatch(input({ addedFacts: [oneLiner("a1", "Built a React design system at Acme")] }))
    expect(match.withAdded.covered).toBe(3)
    expect(match.covers).toEqual([])
  })

  it("a one-liner whose role is gone covers nothing", () => {
    const match = applicationMatch(input({ addedFacts: [oneLiner("a1", "Owned the CI/CD pipelines at Acme", { roleInProfile: false })] }))
    expect(match.withAdded.covered).toBe(3)
  })

  it("once per item: two facts covering one requirement count once, the first fact wins", () => {
    const match = applicationMatch(input({ addedFacts: [oneLiner("a1", "Owned the CI/CD pipelines at Acme"), skillOnly("a2", "CI/CD pipelines")] }))
    expect(match.withAdded.covered).toBe(4)
    expect(match.covers).toEqual([{ group: "core", requirement: "Own the CI/CD pipelines", factId: "a1", kind: "one_liner" }])
  })

  const NOT_LIFTABLE = [
    { case: "a violated rule", postingStatus: "skipped", skipReason: "weak_core_match", violatedRules: ["location"], manualOnly: false },
    { case: "a no-core-responsibilities skip", postingStatus: "skipped", skipReason: "no_core_responsibilities", violatedRules: [], manualOnly: false },
    { case: "a technology mismatch", postingStatus: "skipped", skipReason: "technology_mismatch", violatedRules: [], manualOnly: false },
    { case: "an excluded posting", postingStatus: "excluded", skipReason: "violated_rule", violatedRules: [], manualOnly: false },
    { case: "a manual-only Application", postingStatus: "skipped", skipReason: "weak_core_match", violatedRules: [], manualOnly: true },
  ] as const
  const LIFTING_FACTS = [
    oneLiner("a1", "Owned the CI/CD pipelines at Acme"),
    oneLiner("a2", "Owned the design process end to end at Acme"),
    oneLiner("a3", "Reviewed pull requests at Acme"),
    oneLiner("a4", "Wrote frontend testing notes at Acme"),
  ]

  for (const entry of NOT_LIFTABLE) {
    it(`is not lifted from ${entry.case}`, () => {
      const match = applicationMatch(input({ postingStatus: entry.postingStatus, skipReason: entry.skipReason, violatedRules: [...entry.violatedRules], manualOnly: entry.manualOnly, addedFacts: LIFTING_FACTS }))
      expect(match.withAdded).toMatchObject({ covered: 7, verdict: "strong" })
      expect(match.lifted).toBe(false)
    })
  }

  it("lifts a Match-only skip when the technology criterion still ranks the posting", () => {
    const match = applicationMatch(input({ addedFacts: LIFTING_FACTS, technologyNames: ["React"] }))
    expect(match).toMatchObject({ posting: { covered: 3, verdict: "weak" }, withAdded: { covered: 7, verdict: "strong" }, lifted: true })
  })

  it("does not lift when the technology criterion refuses", () => {
    const match = applicationMatch(input({ addedFacts: LIFTING_FACTS, technologyNames: ["COBOL"], criteria: decisionCriteria({ minCoreMatchPercent: 70, frameworks: [], technologies: ["React"] }) }))
    expect(match.lifted).toBe(false)
  })

  it("counts an uncovered mandatory item covered by a fact, and never counts nice-to-have", () => {
    const items: MatchItemLike[] = [...ITEMS.filter((item) => item.group === "core"), { group: "mandatory", text: "Production CI/CD pipeline work", factId: null }, { group: "nice_to_have", text: "Kubernetes", factId: null }]
    const without = applicationMatch(input({ items, addedFacts: [] }))
    expect(without.withAdded.unmetMandatory).toBe(1)
    const withFact = applicationMatch(input({ items, addedFacts: [skillOnly("a1", "CI/CD pipelines")] }))
    expect(withFact.withAdded.unmetMandatory).toBe(0)
    expect(withFact.withAdded.covered).toBe(4)
    expect(withFact.covers).toEqual(expect.arrayContaining([
      { group: "core", requirement: "Own the CI/CD pipelines", factId: "a1", kind: "skill_only" },
      { group: "mandatory", requirement: "Production CI/CD pipeline work", factId: "a1", kind: "skill_only" },
    ]))
  })

  it("recomputes tenure for a mandatory total-experience requirement", () => {
    const items: MatchItemLike[] = [...ITEMS.filter((item) => item.group === "core"), { group: "mandatory", text: "5+ years of experience", factId: null }]
    expect(applicationMatch(input({ items, tenureMonths: 48 })).withAdded.unmetMandatory).toBe(1)
    expect(applicationMatch(input({ items, tenureMonths: 60 })).withAdded.unmetMandatory).toBe(0)
  })
})
