import { describe, expect, it } from "vitest"

import { atsFit, atsKeywords, containsKeyword, normaliseForAts, scoreAts } from "./ats-score.js"

describe("ATS keyword matching", () => {
  it("forgives case, punctuation inside names, aliases and plurals", () => {
    expect(normaliseForAts("Next.js, Node.js & CI/CD")).toBe("nextjs nodejs cicd")
    expect(containsKeyword(normaliseForAts("Built apps in NextJS"), "Next.js")).toBe(true)
    expect(containsKeyword(normaliseForAts("Used Postgres daily"), "PostgreSQL")).toBe(true)
    expect(containsKeyword(normaliseForAts("Owned the design systems"), "design system")).toBe(true)
    expect(containsKeyword(normaliseForAts("Wrote JavaScript"), "JS")).toBe(true)
  })

  it("never matches a keyword inside another word or an everyday word", () => {
    expect(containsKeyword(normaliseForAts("The next release"), "Next.js")).toBe(false)
    expect(containsKeyword(normaliseForAts("Reactive streams"), "React")).toBe(false)
  })
})

describe("ATS keywords and score", () => {
  const keywords = atsKeywords(
    [{ name: "React" }, { name: "TypeScript" }, { name: "Vue" }, { name: "GitLab" }, { name: "react" }],
    [{ name: "accessibility" }, { name: "design systems" }],
    "GitLab"
  )

  it("dedupes keywords and leaves out the employer's own name", () => {
    expect(keywords.map((k) => k.keyword)).toEqual(["React", "TypeScript", "Vue", "accessibility", "design systems"])
  })

  it("tells matched, missing (in the profile) and gaps (not in the profile) apart", () => {
    const score = scoreAts(keywords, "Built React and TypeScript apps with a focus on accessibility.", "React TypeScript accessibility design systems")
    expect(score).toEqual({ score: 60, total: 5, matched: ["React", "TypeScript", "accessibility"], missing: ["design systems"], gaps: ["Vue"] })
  })

  it("a list of alternatives is one requirement that any of them meets", () => {
    const listed = atsKeywords(
      [
        { name: "Vue", quote: "Vue, React, or Angular" },
        { name: "React", quote: "Vue, React, or Angular" },
        { name: "Angular", quote: "Vue, React, or Angular" },
        { name: "Docker", quote: "Docker or Kubernetes" },
        { name: "Kubernetes", quote: "Docker or Kubernetes" },
        { name: "TypeScript", quote: "strong TypeScript" },
      ],
      null,
      null
    )
    const score = scoreAts(listed, "React and TypeScript", "React TypeScript")
    expect(score).toEqual({ score: 67, total: 3, matched: ["React", "TypeScript"], missing: [], gaps: ["Docker / Kubernetes"] })
    expect(atsFit(listed, "React TypeScript")).toBe(67)
  })

  it("ATS fit is the share of keywords the profile states", () => {
    expect(atsFit(keywords, "React TypeScript accessibility design systems")).toBe(80)
    expect(atsFit([], "anything")).toBe(0)
  })
})
