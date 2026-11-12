import { describe, expect, it } from "vitest"

import { EXTRACTION_SYSTEM_PROMPT, buildVerifiedSections } from "./career-profile-draft.js"
import { normaliseForQuote } from "./source-quote.js"

const resumeText = normaliseForQuote(
  "Brightwave Ltd, Senior Frontend Engineer, 2021-2024\nLed a team of 4 frontend engineers at Brightwave Ltd, 2021-2024\nSkills: React, TypeScript"
)
let counter = 0
const newId = () => `id-${++counter}`

describe("buildVerifiedSections", () => {
  it("keeps facts whose quotes appear in the resume and stores the quote", () => {
    counter = 0
    const result = buildVerifiedSections(
      {
        sections: [
          {
            kind: "experience",
            title: "Senior Frontend Engineer",
            organization: "Brightwave Ltd",
            period: "2021-2024",
            sourceQuote: "Brightwave Ltd, Senior Frontend Engineer, 2021-2024",
            // The quote must contain the dates the fact states (claim check, CR2-02).
            facts: [{ text: "Led a team of 4 frontend engineers at Brightwave Ltd, 2021-2024", sourceQuote: "Led a team of 4 frontend engineers at Brightwave Ltd, 2021-2024" }],
          },
        ],
      },
      resumeText,
      newId
    )
    expect(result.rejectedFacts).toBe(0)
    expect(result.sections).toEqual([
      {
        id: "id-1",
        kind: "experience",
        title: "Senior Frontend Engineer",
        organization: "Brightwave Ltd",
        period: "2021-2024",
        sourceQuote: "Brightwave Ltd, Senior Frontend Engineer, 2021-2024",
        facts: [{ id: "id-2", text: "Led a team of 4 frontend engineers at Brightwave Ltd, 2021-2024", sourceQuote: "Led a team of 4 frontend engineers at Brightwave Ltd, 2021-2024" }],
      },
    ])
  })

  it("drops a fact whose quote is not in the resume, and counts it", () => {
    const result = buildVerifiedSections(
      {
        sections: [
          {
            kind: "skills",
            title: "Skills",
            organization: null,
            period: null,
            sourceQuote: "Skills: React, TypeScript",
            facts: [
              { text: "React", sourceQuote: "Skills: React" },
              { text: "Kubernetes", sourceQuote: "Skills: Kubernetes" },
            ],
          },
        ],
      },
      resumeText,
      newId
    )
    expect(result.rejectedFacts).toBe(1)
    expect(result.sections[0]?.facts.map((fact) => fact.text)).toEqual(["React"])
  })

  it("drops a whole section whose own quote is invented, counting its facts", () => {
    const result = buildVerifiedSections(
      {
        sections: [
          {
            kind: "experience",
            title: "Staff Engineer",
            organization: "Google",
            period: "2024-2025",
            sourceQuote: "Google, Staff Engineer, 2024-2025",
            facts: [{ text: "Led a team of 4 frontend engineers", sourceQuote: "Led a team of 4 frontend engineers" }],
          },
        ],
      },
      resumeText,
      newId
    )
    expect(result.sections).toEqual([])
    expect(result.rejectedFacts).toBe(1)
  })

  it("drops a section left with no verified facts", () => {
    const result = buildVerifiedSections(
      {
        sections: [
          {
            kind: "skills",
            title: "Skills",
            organization: null,
            period: null,
            sourceQuote: "Skills: React, TypeScript",
            facts: [{ text: "Rust", sourceQuote: "Rust expert" }],
          },
        ],
      },
      resumeText,
      newId
    )
    expect(result.sections).toEqual([])
    expect(result.rejectedFacts).toBe(1)
  })
})

// CR2-02 / SEC-203: a fact or heading must not claim more than its quote.
describe("buildVerifiedSections claim check", () => {
  const resume = normaliseForQuote(
    "Brightwave Ltd, Senior Frontend Engineer, 2021-2024\nLed a team of 4 frontend engineers at Brightwave Ltd, 2021-2024\nCut checkout page load time by 38%\nUniversity of Lagos, BSc Computer Science, 2017"
  )
  const brightwave = (facts: { text: string; sourceQuote: string }[], heading: Partial<{ title: string; organization: string; period: string }> = {}) => ({
    kind: "experience" as const,
    title: heading.title ?? "Senior Frontend Engineer",
    organization: heading.organization ?? "Brightwave Ltd",
    period: heading.period ?? "2021–2024",
    sourceQuote: "Brightwave Ltd, Senior Frontend Engineer, 2021-2024",
    facts,
  })
  const kept = { text: "Led 4 frontend engineers at Brightwave Ltd from 2021 to 2024", sourceQuote: "Led a team of 4 frontend engineers at Brightwave Ltd, 2021-2024" }

  it("drops a fact whose text names a number its real quote does not, and counts it", () => {
    const result = buildVerifiedSections(
      { sections: [brightwave([kept, { text: "Led a team of 12 frontend engineers at Brightwave Ltd", sourceQuote: "Led a team of 4 frontend engineers at Brightwave Ltd, 2021-2024" }])] },
      resume,
      newId
    )
    expect(result.rejectedFacts).toBe(1)
    expect(result.sections[0]?.facts.map((fact) => fact.text)).toEqual([kept.text])
  })

  it("drops a heading whose title the section quote does not support, with every fact, each counted", () => {
    const result = buildVerifiedSections(
      { sections: [brightwave([kept, kept, kept], { title: "Engineering Manager" })] },
      resume,
      newId
    )
    expect(result.sections).toEqual([])
    expect(result.rejectedFacts).toBe(3)
  })

  it("counts quote-not-found and claim-unsupported drops together", () => {
    const result = buildVerifiedSections(
      {
        sections: [
          brightwave([
            kept,
            { text: "Managed a budget of USD 2 million", sourceQuote: "Managed a budget of USD 2 million across three product lines" },
            { text: "Holds a PhD from MIT", sourceQuote: "Cut checkout page load time by 38%" },
          ]),
        ],
      },
      resume,
      newId
    )
    expect(result.rejectedFacts).toBe(2)
    expect(result.sections[0]?.facts).toHaveLength(1)
  })

  it("keeps the section quote on a kept section", () => {
    const result = buildVerifiedSections({ sections: [brightwave([kept])] }, resume, newId)
    expect(result.sections[0]?.sourceQuote).toBe("Brightwave Ltd, Senior Frontend Engineer, 2021-2024")
  })
})

describe("QA-2B-05: the drafting prompt asks the model to keep the resume's opening verb", () => {
  it("names the rule", () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/keep the resume's own opening verb/i)
  })
})
