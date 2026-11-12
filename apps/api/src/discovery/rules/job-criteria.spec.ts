import { describe, expect, it } from "vitest"

import { canonicalEntries, decideJobCriteria, decisionCriteria } from "./job-criteria.js"

function criteria(minCoreMatchPercent: number, frameworks: string[] = [], technologies: string[] = []) {
  return decisionCriteria({ minCoreMatchPercent, frameworks, technologies })
}

const decide = (covered: number, total: number, names: string[] | null, c = criteria(70)) =>
  decideJobCriteria({ coveredCount: covered, totalCount: total, technologyNames: names }, c)

// criteria-decision.feature "A posting meets the Match criterion when covered ÷ total ≥ minimum ÷ 100, without rounding"
describe("minimum core Match (AC 2.4, 2.5)", () => {
  it.each([
    [70, 7, 10, "ranked"],
    [70, 6, 9, "weak_core_match"],
    [70, 6, 10, "weak_core_match"],
    [70, 7, 9, "ranked"],
    [67, 2, 3, "weak_core_match"],
    [66, 2, 3, "ranked"],
    [100, 10, 10, "ranked"],
    [100, 9, 10, "weak_core_match"],
    [100, 1, 1, "ranked"],
    [1, 1, 100, "ranked"],
    [1, 0, 5, "weak_core_match"],
    [50, 1, 2, "ranked"],
    [34, 1, 3, "weak_core_match"],
    [33, 1, 3, "ranked"],
    [60, 6, 10, "ranked"],
    [80, 7, 10, "weak_core_match"],
    [90, 8, 10, "weak_core_match"],
  ])("minimum %i with core Match %i of %i is %s", (minimum, covered, total, expected) => {
    const result = decide(covered, total, null, criteria(minimum))
    expect(result.skipReason ?? result.status).toBe(expected)
  })

  it("a weak core Match stores the coverage reason; a technology mismatch keeps the Match strong", () => {
    expect(decide(5, 10, ["PHP"], criteria(70, ["React"])).match).toEqual({ verdict: "weak", weakReason: "coverage_below_threshold" })
    expect(decide(8, 10, ["PHP"], criteria(70, ["React"]))).toEqual({ status: "skipped", skipReason: "technology_mismatch", match: { verdict: "strong", weakReason: null } })
  })
})

describe("technology criterion (AC 3.4 to 3.6, 4.5, 5.1)", () => {
  it("ranks a posting that mentions a listed framework", () => {
    expect(decide(8, 10, ["React", "Redux", "Jest"], criteria(70, ["React"])).status).toBe("ranked")
  })

  it("needs any one entry from either list", () => {
    expect(decide(8, 10, ["Python", "PostgreSQL"], criteria(70, ["Vue", "Angular"], ["Go", "PostgreSQL"])).status).toBe("ranked")
  })

  it.each([["frameworks"], ["technologies"]])("%s behave the same in matching", (list) => {
    const c = list === "frameworks" ? criteria(70, ["TypeScript"]) : criteria(70, [], ["TypeScript"])
    expect(decide(8, 10, ["TypeScript", "Node.js"], c).status).toBe("ranked")
  })

  it("skips a posting that mentions no listed entry", () => {
    expect(decide(8, 10, ["PHP", "Laravel", "MySQL"], criteria(70, ["React", "Next.js"], ["TypeScript"])).skipReason).toBe("technology_mismatch")
  })

  it.each([
    ["React", "React.js"], ["React.js", "ReactJS"], ["react", "REACT"], ["Vue", "Vue.js"], ["VueJS", "Vue"], ["Next.js", "NextJS"],
    ["Next", "Next.js"], ["Nuxt", "Nuxt.js"], ["Node.js", "Node"], ["NodeJS", "Node.js"], ["Express", "Express.js"], ["TypeScript", "TS"],
    ["JavaScript", "JS"], ["JavaScript", "ECMAScript"], ["Go", "Golang"], ["PostgreSQL", "Postgres"], ["Kubernetes", "K8s"],
    ["Tailwind", "Tailwind CSS"], ["TailwindCSS", "Tailwind"], ["React Native", "RN"], ["GraphQL", "GQL"], ["AWS", "Amazon Web Services"],
    ["GCP", "Google Cloud"], ["GCP", "Google Cloud Platform"], ["Ruby on Rails", "Ruby-on-Rails"], ["CI/CD", "CI/CD"], ["C#", "c#"],
    ["C++", "C++"], ["Material_UI", "Material UI"],
  ])("entry %j matches the posting technology %j", (entry, name) => {
    expect(decide(8, 10, [name], criteria(70, [entry])).status).toBe("ranked")
  })

  it.each([
    ["Java", "JavaScript"], ["JavaScript", "Java"], ["React", "React Native"], ["React", "Preact"], ["Angular", "AngularJS"],
    ["AngularJS", "Angular"], ["C", "C#"], ["C", "C++"], ["C#", "C++"], ["Go", "Google Cloud"], ["Node.js", "Deno"], ["TypeScript", "JavaScript"],
  ])("entry %j does not match %j", (entry, name) => {
    expect(decide(8, 10, [name], criteria(70, [entry])).skipReason).toBe("technology_mismatch")
  })

  it("with both lists empty nothing is skipped for technology, even with zero technologies", () => {
    expect(decide(8, 10, ["PHP", "Laravel"]).status).toBe("ranked")
    expect(decide(8, 10, []).status).toBe("ranked")
  })

  it("zero verified technologies counts as mentioning none when the criterion is on", () => {
    expect(decide(8, 10, [], criteria(70, ["React"])).skipReason).toBe("technology_mismatch")
  })

  it("no technology data is never skipped for technology, but keeps the Match rule", () => {
    expect(decide(8, 10, null, criteria(70, ["React"])).status).toBe("ranked")
    expect(decide(8, 10, null, criteria(90, ["React"])).skipReason).toBe("weak_core_match")
  })

  it("a weak core Match is the stored reason when both criteria fail", () => {
    expect(decide(5, 10, ["PHP"], criteria(70, ["React"])).skipReason).toBe("weak_core_match")
  })
})

describe("canonicalEntries (AC 5.7)", () => {
  it("stores the normalised entries of both lists", () => {
    expect(canonicalEntries(["React.js", "Next.js"], ["TypeScript"])).toEqual(["react", "nextjs", "typescript"])
    expect(canonicalEntries([], ["Vue.js", "Go"])).toEqual(["vue", "go"])
  })
})
