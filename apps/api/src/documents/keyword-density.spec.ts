import { describe, expect, it } from "vitest"

import type { AtsKeyword } from "../ats/ats-score.js"
import type { DocumentLine, ResumeContent } from "./document-model.js"
import { KEYWORD_LINE_LIMIT, LINE_KEYWORD_LIMIT, keywordDensity, repairDenseLines, resumeLineRefs } from "./keyword-density.js"

const keyword = (name: string): AtsKeyword => ({ keyword: name, kind: "technology", group: `one:${name.toLowerCase()}` })
const REACT = keyword("React")

function line(text: string, factIds: readonly string[] = ["F1"]): DocumentLine {
  return { text, factIds }
}

function resume(bullets: readonly DocumentLine[], summary: readonly DocumentLine[] = [], skills: readonly DocumentLine[] = []): ResumeContent {
  return {
    kind: "resume",
    summary,
    experience: [{ heading: line("Senior Frontend Engineer, Brightwave Ltd, 2021–2024", ["F2"]), bullets }],
    skills,
    education: [],
  }
}

describe("keyword density (EPIC-0012 rule 3)", () => {
  it("keeps the caps explicit", () => {
    expect(KEYWORD_LINE_LIMIT).toBe(2)
    expect(LINE_KEYWORD_LIMIT).toBe(4)
  })

  it.each([
    ["no mention", []],
    ["one mention", ["Built a React dashboard."]],
    ["two mentions", ["Built a React dashboard.", "Shipped a React dashboard."]],
  ])("%s of a keyword needs no repair", (_name, texts) => {
    const content = resume(texts.map((text) => line(text)))
    expect(keywordDensity(resumeLineRefs(content), [REACT])).toEqual({ lineIds: [], repeated: [], crowdedLineIds: [] })
  })

  it("three lines holding one keyword repair the third, keeping the first two mentions", () => {
    const content = resume([line("Built a React dashboard."), line("Shipped a React dashboard."), line("Tested a React dashboard.")])
    expect(keywordDensity(resumeLineRefs(content), [REACT])).toEqual({
      lineIds: ["experience:0:bullet:2"],
      repeated: [{ keyword: "React", count: 3 }],
      crowdedLineIds: [],
    })
  })

  it("four lines holding one keyword repair the third and fourth", () => {
    const content = resume([line("Built a React dashboard."), line("Shipped a React dashboard."), line("Tested a React dashboard."), line("Owned a React dashboard.")])
    expect(keywordDensity(resumeLineRefs(content), [REACT]).lineIds).toEqual(["experience:0:bullet:2", "experience:0:bullet:3"])
  })

  it("counts a keyword by whole words, the way the ATS score does", () => {
    const content = resume([line("Built a Reactive dashboard."), line("Shipped a React dashboard.")])
    expect(keywordDensity(resumeLineRefs(content), [REACT]).repeated).toEqual([])
  })

  it("flags a bullet holding four distinct keywords", () => {
    const content = resume([line("React, TypeScript, Node.js, AWS")])
    const keywords = [REACT, keyword("TypeScript"), keyword("Node.js"), keyword("AWS")]
    expect(keywordDensity(resumeLineRefs(content), keywords)).toEqual({
      lineIds: ["experience:0:bullet:0"],
      repeated: [],
      crowdedLineIds: ["experience:0:bullet:0"],
    })
  })

  it("three distinct keywords in a bullet are not a dump", () => {
    const content = resume([line("React, TypeScript, Node.js")])
    const keywords = [REACT, keyword("TypeScript"), keyword("Node.js"), keyword("AWS")]
    expect(keywordDensity(resumeLineRefs(content), keywords).lineIds).toEqual([])
  })

  it("a skills line with five keywords is untouched", () => {
    const content = resume([], [], [line("React, TypeScript, Node.js, AWS, Docker")])
    const keywords = [REACT, keyword("TypeScript"), keyword("Node.js"), keyword("AWS"), keyword("Docker")]
    expect(resumeLineRefs(content).map(({ id }) => id)).toEqual([])
    expect(keywordDensity(resumeLineRefs(content), keywords)).toEqual({ lineIds: [], repeated: [], crowdedLineIds: [] })
  })

  it("a keyword in a skills line plus two body lines is fine", () => {
    const content = resume([line("Built a React dashboard."), line("Shipped a React dashboard.")], [], [line("React, TypeScript")])
    expect(keywordDensity(resumeLineRefs(content), [REACT])).toEqual({ lineIds: [], repeated: [], crowdedLineIds: [] })
  })

  it("counts a keyword once when two entries share its normalised form", () => {
    const content = resume([line("React"), line("React"), line("React")])
    expect(keywordDensity(resumeLineRefs(content), [REACT, keyword("react")]).repeated).toEqual([{ keyword: "React", count: 3 }])
  })

  it("names summary and bullet lines, but never a skills line", () => {
    const content = resume([line("Built a React dashboard."), line("Shipped a React dashboard.")], [line("React engineer.")], [line("React")])
    expect(resumeLineRefs(content).map(({ id }) => id)).toEqual(["summary:0", "experience:0:bullet:0", "experience:0:bullet:1"])
    expect(keywordDensity(resumeLineRefs(content), [REACT])).toEqual({
      lineIds: ["experience:0:bullet:1"],
      repeated: [{ keyword: "React", count: 3 }],
      crowdedLineIds: [],
    })
  })
})

describe("repairing dense lines never blocks", () => {
  const WORDING = new Map([
    ["F1", "Built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd"],
    ["F3", "Mentored 6 junior developers"],
    ["F4", "Cut release cycle from 2 weeks to 3 days"],
  ])
  const DASHBOARD = keyword("dashboard")
  const RELEASE = keyword("release cycle")

  it("falls back to the first cited fact's plain wording", () => {
    const content = resume([
      line("Built a React and TypeScript merchant dashboard from scratch to production, mentored 6 junior developers and cut the release cycle from 2 weeks to 3 days.", ["F1", "F3", "F4"]),
    ])
    const density = keywordDensity(resumeLineRefs(content), [REACT, keyword("TypeScript"), RELEASE, DASHBOARD])
    expect(density.crowdedLineIds).toEqual(["experience:0:bullet:0"])
    const repaired = repairDenseLines(content, density.lineIds, WORDING)
    expect(repaired.replaced).toBe(1)
    expect(repaired.resume.experience[0]?.bullets[0]).toEqual({
      text: "Built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd",
      factIds: ["F1"],
    })
  })

  it("leaves a line with no fact alone and counts no repair", () => {
    const content = resume([line("React, TypeScript, Node.js, AWS", [])])
    const repaired = repairDenseLines(content, ["experience:0:bullet:0"], WORDING)
    expect(repaired.replaced).toBe(0)
    expect(repaired.resume).toEqual(content)
  })

  it("never repairs a skills line, even if one is named", () => {
    const content = resume([], [], [line("React, TypeScript, Node.js, AWS")])
    const repaired = repairDenseLines(content, ["skills:0"], WORDING)
    expect(repaired.replaced).toBe(0)
    expect(repaired.resume.skills).toEqual(content.skills)
  })

  it("drops a repair that is the same printed line as one already kept (Revision 1, R6)", () => {
    const content = resume([
      line("built a  React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd", ["F1"]),
      line("Used React, TypeScript, Node.js, AWS", ["F1"]),
    ])
    const repaired = repairDenseLines(content, ["experience:0:bullet:1"], WORDING)
    expect(repaired.replaced).toBe(1)
    expect(repaired.resume.experience[0]?.bullets).toHaveLength(1)
  })

  it("never leaves a list empty, even when every repair repeats a kept line (Revision 1, R6)", () => {
    const content = resume([
      line("Built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd", ["F1"]),
      line("Used React, TypeScript, Node.js, AWS", ["F1"]),
    ])
    const repaired = repairDenseLines(content, ["experience:0:bullet:0", "experience:0:bullet:1"], WORDING)
    // Both repairs counted; only the first is kept.
    expect(repaired.replaced).toBe(2)
    expect(repaired.resume.experience[0]?.bullets).toHaveLength(1)
  })
})
