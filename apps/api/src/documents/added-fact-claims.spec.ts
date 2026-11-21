import { describe, expect, it } from "vitest"

import { addedFactFailure, aspirationPhraseIn, citedAddedIds, keepBulletsUnderTheirRole, stripMisplacedSkillOnly } from "./added-fact-claims.js"
import type { CoverLetterContent, ResumeContent } from "./document-model.js"

const A1 = "added:s:00000000-0000-4000-8000-0000000000a1"
const A2 = "added:o:00000000-0000-4000-8000-0000000000a2"
const FACTS = new Map([
  ["F1", "Built a React dashboard at Brightwave Ltd"],
  [A1, "Figma"],
  [A2, "Set up GitHub Actions CI/CD pipelines at Acme"],
])

function resume(line: { text: string; factIds: string[] }, skills: Array<{ text: string; factIds: string[] }> = []): ResumeContent {
  return { kind: "resume", summary: [], experience: [{ heading: { text: "Senior Engineer, Brightwave Ltd", factIds: ["F1"] }, bullets: [line] }], skills, education: [] }
}

function letter(paragraphs: Array<{ text: string; factIds: string[] }>): CoverLetterContent {
  return { kind: "cover_letter", greeting: "Dear team,", opening: null, paragraphs, closingLine: null, closing: "Regards," }
}

describe("FEAT-0017 placement rule", () => {
  it.each(["summary", "experience_bullet", "education"] as const)("a %s line citing a skill-only fact is a hard fail", (kind) => {
    expect(addedFactFailure({ text: "Worked with Figma at Brightwave Ltd", factIds: [A1] }, kind, FACTS)).toMatchObject({ hardFail: "skill_only_in_bullet" })
  })

  it("a Skills line may cite a skill-only fact with a profile fact", () => {
    expect(addedFactFailure({ text: "React, TypeScript, Figma", factIds: ["F1", A1] }, "skills", FACTS)).toBeNull()
  })

  it("a letter paragraph citing skill-only facts only is allowed when it says nothing else", () => {
    expect(addedFactFailure({ text: "I also work in Figma.", factIds: [A1] }, "letter_paragraph", FACTS)).toBeNull()
  })

  it("a mixed letter paragraph citing a skill with another fact is a hard fail", () => {
    expect(addedFactFailure({ text: "At Brightwave Ltd I built a React dashboard and used Figma.", factIds: ["F1", A1] }, "letter_paragraph", FACTS)).toMatchObject({ hardFail: "skill_only_in_bullet" })
  })

  it.each(["I cut design review time with Figma.", "I am an expert in Figma.", "I used Figma at Brightwave Ltd."])("a skill-only letter paragraph that adds a claim is a hard fail: %s", (text) => {
    expect(addedFactFailure({ text, factIds: [A1] }, "letter_paragraph", FACTS)).toMatchObject({ hardFail: "skill_only_in_bullet" })
  })

  it("a hedged added fact is a hard fail no judge releases", () => {
    expect(addedFactFailure({ text: "I am familiar with Figma.", factIds: [A1] }, "letter_paragraph", FACTS)).toMatchObject({ hardFail: "added_fact_hedge" })
    expect(addedFactFailure({ text: "Exposure to GitHub Actions CI/CD pipelines at Acme", factIds: [A2] }, "letter_paragraph", FACTS)).toMatchObject({ hardFail: "added_fact_hedge" })
  })

  it("hedge wording a cited fact states is allowed", () => {
    const facts = new Map([[A1, "Familiar with Figma from design reviews"]])
    expect(addedFactFailure({ text: "Familiar with Figma", factIds: [A1] }, "skills", facts)).toBeNull()
  })

  it("a line with no added id never reaches the added-fact rules", () => {
    expect(addedFactFailure({ text: "Familiar with Figma", factIds: ["F1"] }, "skills", new Map([["F1", "Familiar with Figma"]], ) as ReadonlyMap<string, string>)).toBeNull()
  })
})

describe("FEAT-0017 aspiration phrases", () => {
  it.each([["Learning Terraform at Acme", "learning"], ["I want to learn Storybook", "want to learn"], ["Plan to set up CI", "plan to"], ["Built a learning platform", "learning"]])("%j holds %j", (text, phrase) => {
    expect(aspirationPhraseIn(text)).toBe(phrase)
  })
  it("learned and studied pass", () => {
    expect(aspirationPhraseIn("Learned Go at Acme")).toBeNull()
    expect(aspirationPhraseIn("Studied distributed systems")).toBeNull()
  })
})

describe("FEAT-0017 strip repair", () => {
  it("removes a skill-only id from a bullet, and drops the bullet when nothing is left", () => {
    const result = stripMisplacedSkillOnly(resume({ text: "Worked with Figma at Brightwave Ltd", factIds: [A1] }), letter([{ text: "I also work in Figma.", factIds: [A1] }]))
    expect(result.resume.experience[0]!.bullets).toEqual([])
    expect(result.stripped).toBe(1)
    expect(result.letter.paragraphs).toHaveLength(1)
  })

  it("keeps a Skills line citation", () => {
    const result = stripMisplacedSkillOnly(resume({ text: "Built a React dashboard", factIds: ["F1"] }, [{ text: "Figma", factIds: [A1] }]), letter([]))
    expect(result.resume.skills).toEqual([{ text: "Figma", factIds: [A1] }])
    expect(result.stripped).toBe(0)
  })

  it("removes a skill-only id from a mixed letter paragraph and keeps the paragraph", () => {
    const result = stripMisplacedSkillOnly(resume({ text: "Built a React dashboard", factIds: ["F1"] }), letter([{ text: "I built a React dashboard and used Figma.", factIds: ["F1", A1] }]))
    expect(result.letter.paragraphs).toEqual([{ text: "I built a React dashboard and used Figma.", factIds: ["F1"] }])
  })
})

describe("FEAT-0017 role placement and citations", () => {
  it("drops a bullet citing another role's one-liner and keeps its own", () => {
    const sections = [
      { id: "sec-1", facts: [{ id: "F1" }] },
      { id: "sec-2", facts: [{ id: "F2" }] },
    ]
    const content: ResumeContent = {
      kind: "resume",
      summary: [],
      experience: [
        { heading: { text: "Brightwave", factIds: ["F1"] }, bullets: [{ text: "Owned CI/CD", factIds: [A2] }] },
        { heading: { text: "Acme", factIds: ["F2"] }, bullets: [{ text: "Owned CI/CD", factIds: [A2] }] },
      ],
      skills: [],
      education: [],
    }
    const repaired = keepBulletsUnderTheirRole(content, [{ id: "00000000-0000-4000-8000-0000000000a2", kind: "one_liner", roleSectionId: "sec-2" }], sections)
    expect(repaired.experience[0]!.bullets).toEqual([])
    expect(repaired.experience[1]!.bullets).toHaveLength(1)
  })

  it("cites added row ids once, in line order", () => {
    expect(citedAddedIds(resume({ text: "Figma and CI/CD", factIds: [A1, "F1", A2] }, [{ text: "Figma", factIds: [A1] }]))).toEqual(["00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000a2"])
  })
})
