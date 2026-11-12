import { describe, expect, it } from "vitest"

import type { StoredSection } from "../db/schema.js"
import { applyDraftEdits } from "./draft-edits.js"

const base: StoredSection[] = [
  {
    id: "s1",
    kind: "experience",
    title: "Senior Frontend Engineer",
    organization: "Brightwave Ltd",
    period: "2021-2024",
    sourceQuote: "Brightwave Ltd, Senior Frontend Engineer, 2021-2024",
    facts: [
      { id: "f1", text: "Led a team of 4 frontend engineers at Brightwave Ltd, 2021-2024", sourceQuote: "Led a team of 4 frontend engineers" },
      { id: "f2", text: "Cut checkout page load time by 38%", sourceQuote: "Cut checkout page load time by 38%" },
    ],
  },
]
let n = 0
const newId = () => `new-${++n}`
const heading = { kind: "experience" as const, title: "Senior Frontend Engineer", organization: "Brightwave Ltd", period: "2021-2024" }

describe("applyDraftEdits", () => {
  it("keeps ids and quotes of unchanged facts and drops the quote of an edited fact", () => {
    n = 0
    const sections = applyDraftEdits(
      base,
      { sections: [{ id: "s1", ...heading, facts: [{ id: "f1", text: "Led a team of 5 frontend engineers at Brightwave Ltd, 2021-2024" }, { id: "f2", text: "Cut checkout page load time by 38%" }] }] },
      newId
    )
    expect(sections[0]?.sourceQuote).toBe("Brightwave Ltd, Senior Frontend Engineer, 2021-2024")
    expect(sections[0]?.facts).toEqual([
      { id: "f1", text: "Led a team of 5 frontend engineers at Brightwave Ltd, 2021-2024", sourceQuote: null },
      { id: "f2", text: "Cut checkout page load time by 38%", sourceQuote: "Cut checkout page load time by 38%" },
    ])
  })

  it("gives new ids to added facts and to ids the base does not have", () => {
    n = 0
    const sections = applyDraftEdits(base, { sections: [{ id: "s1", ...heading, facts: [{ text: "Mentored two juniors" }, { id: "forged", text: "x" }] }] }, newId)
    expect(sections[0]?.facts.map((fact) => [fact.id, fact.sourceQuote])).toEqual([
      ["new-1", null],
      ["new-2", null],
    ])
  })

  it("drops the section quote when its heading changes, and removes omitted facts", () => {
    const sections = applyDraftEdits(base, { sections: [{ id: "s1", ...heading, title: "Lead Engineer", facts: [] }] }, newId)
    expect(sections[0]).toMatchObject({ id: "s1", title: "Lead Engineer", sourceQuote: null, facts: [] })
  })

  it("keeps an empty fact so approval can point at it", () => {
    const sections = applyDraftEdits(base, { sections: [{ id: "s1", ...heading, facts: [{ id: "f1", text: "  " }] }] }, newId)
    expect(sections[0]?.facts[0]).toEqual({ id: "f1", text: "", sourceQuote: null })
  })
})
