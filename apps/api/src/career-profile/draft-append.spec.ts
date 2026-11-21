import { describe, expect, it } from "vitest"

import type { StoredSection } from "../db/schema.js"
import { ADDED_FACTS_TITLE, ADDED_SKILLS_TITLE, DraftAppendError, appendFactsToSections, factKeys } from "./draft-append.js"

let next = 0
const newId = () => `id-${++next}`

const experience = (facts: number): StoredSection => ({
  id: "sec-exp",
  kind: "experience",
  title: "Senior Engineer",
  organization: "Brightwave Ltd",
  period: "2021 to 2024",
  sourceQuote: null,
  facts: Array.from({ length: facts }, (_, index) => ({ id: `f${index}`, text: `Fact ${index}`, sourceQuote: null })),
})

describe("FEAT-0017 appendFactsToSections", () => {
  it("creates the skills home for a skill-only fact, with no source quote", () => {
    next = 0
    const { sections } = appendFactsToSections([experience(1)], [{ kind: "skill_only", text: "Figma" }], newId, { sections: 50, factsPerSection: 50 })
    expect(sections).toHaveLength(2)
    expect(sections[1]).toMatchObject({ kind: "skills", title: ADDED_SKILLS_TITLE, organization: null, period: null, sourceQuote: null, facts: [{ text: "Figma", sourceQuote: null }] })
  })

  it("creates the other home for a one-liner", () => {
    const { sections } = appendFactsToSections([], [{ kind: "one_liner", text: "Set up CI/CD at Acme" }], newId, { sections: 50, factsPerSection: 50 })
    expect(sections[0]).toMatchObject({ kind: "other", title: ADDED_FACTS_TITLE })
  })

  it("appends to an existing home and keeps the other edits", () => {
    const base: StoredSection[] = [experience(2), { id: "sec-skills", kind: "skills", title: ADDED_SKILLS_TITLE, organization: null, period: null, sourceQuote: null, facts: [{ id: "s1", text: "Existing", sourceQuote: null }] }]
    const { sections, appended } = appendFactsToSections(base, [{ kind: "skill_only", text: "Figma" }], newId, { sections: 50, factsPerSection: 50 })
    expect(appended).toBe(1)
    expect(sections[1]!.facts.map((fact) => fact.text)).toEqual(["Existing", "Figma"])
    expect(sections[0]!.facts).toHaveLength(2)
  })

  it("refuses past the section limit and past the facts-per-section limit", () => {
    const full = Array.from({ length: 2 }, () => experience(0))
    expect(() => appendFactsToSections(full, [{ kind: "skill_only", text: "Figma" }], newId, { sections: 2, factsPerSection: 50 })).toThrow(DraftAppendError)
    const fullSection: StoredSection[] = [{ id: "sec-skills", kind: "skills", title: ADDED_SKILLS_TITLE, organization: null, period: null, sourceQuote: null, facts: [{ id: "s", text: "a", sourceQuote: null }] }]
    expect(() => appendFactsToSections(fullSection, [{ kind: "skill_only", text: "Figma" }], newId, { sections: 50, factsPerSection: 1 })).toThrow(DraftAppendError)
  })

  it("throws a plain error for a malformed section list, so the caller reports failed", () => {
    expect(() => appendFactsToSections({ not: "an array" } as unknown as StoredSection[], [{ kind: "skill_only", text: "Figma" }], newId, { sections: 50, factsPerSection: 50 })).toThrow(/not a list/)
  })

  it("keys facts by trimmed, lower-cased text for the duplicate rule", () => {
    expect(factKeys([{ ...experience(0), facts: [{ id: "f", text: "  FIGMA ", sourceQuote: null }] }])).toEqual(new Set(["figma"]))
  })
})
