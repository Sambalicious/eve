import { describe, expect, it } from "vitest"

import { MEANING_CHECK_SYSTEM_PROMPT, buildMeaningCheckPrompt, meaningCheckSystemPrompt, supportedTexts } from "./meaning-check.js"
import { meaningKey } from "./line-text.js"

/** EPIC-0012 design 1e: the posting-term sentence, word for word. */
const POSTING_TERMS_SENTENCE =
  'Words in <posting_terms> come from the job posting, not from the facts. Accept one only when it names the field, sector or purpose of the same work the facts describe, so a reader would agree the fact is an example of it ("renewable energy" for wind farm projects). Answer false when it adds a skill, method, tool, responsibility, title, seniority or scope the facts don\'t state, or relabels a different kind of work as the posting\'s kind.'

/** EPIC-0012 Revision 2, 2f: the quoted company-direction sentence, word for word. */
const COMPANY_DIRECTION_SENTENCE =
  "A line may quote the employer's own words in quotation marks. That quote is the employer's goal, not evidence about the candidate. Answer false if any sentence in the line says or suggests that the candidate's work met, delivered, reached, advanced or contributed to that goal."

/** EPIC-0012 Revision 2 addendum, A5: the supporting-action to ownership sentence, word for word. */
const SUPPORT_TO_OWNERSHIP_SENTENCE =
  "Answer false when the line turns a supporting action (carried out, with, using, worked on) into ownership or authorship (ran, introduced, created, led, owned)."

const OFF_OFF = meaningCheckSystemPrompt({ bridges: false, direction: false })
const BRIDGES_ON = meaningCheckSystemPrompt({ bridges: true, direction: false })
const DIRECTION_ON = meaningCheckSystemPrompt({ bridges: false, direction: true })

const ITEM = {
  line: { text: "Built wind farm financial models for renewable energy projects.", factIds: ["F1"] },
  facts: ["Built wind farm financial models for offshore projects"],
  postingTerms: ["renewable", "energy"],
}

describe("EPIC-0012 Revision 2 addendum: the judge prompt by flag state", () => {
  it("the exported constant is the off/off form", () => {
    expect(MEANING_CHECK_SYSTEM_PROMPT).toBe(OFF_OFF)
  })

  it("A5 is present in every state (flag-independent, stricter only)", () => {
    for (const prompt of [OFF_OFF, BRIDGES_ON, DIRECTION_ON]) expect(prompt).toContain(SUPPORT_TO_OWNERSHIP_SENTENCE)
  })

  it("the 1e posting-terms sentence is sent only with bridges on", () => {
    expect(OFF_OFF).not.toContain(POSTING_TERMS_SENTENCE)
    expect(DIRECTION_ON).not.toContain(POSTING_TERMS_SENTENCE)
    expect(BRIDGES_ON).toContain(POSTING_TERMS_SENTENCE)
  })

  it("the 2f quote sentence is sent only with direction on, next to 1e and before the untrusted-data rule", () => {
    expect(OFF_OFF).not.toContain(COMPANY_DIRECTION_SENTENCE)
    expect(BRIDGES_ON).not.toContain(COMPANY_DIRECTION_SENTENCE)
    expect(DIRECTION_ON).toContain(COMPANY_DIRECTION_SENTENCE)
    const direction = DIRECTION_ON.indexOf(COMPANY_DIRECTION_SENTENCE)
    expect(direction).toBeLessThan(DIRECTION_ON.indexOf("The job posting is not evidence"))
    const both = meaningCheckSystemPrompt({ bridges: true, direction: true })
    expect(both.indexOf(COMPANY_DIRECTION_SENTENCE)).toBeGreaterThan(both.indexOf(POSTING_TERMS_SENTENCE))
  })
})

describe("EPIC-0012 rule 2: the posting terms the meaning check sees", () => {
  it("keeps the 1e sentence verbatim when bridges are on", () => {
    expect(meaningCheckSystemPrompt({ bridges: true, direction: false })).toContain(POSTING_TERMS_SENTENCE)
  })

  it("puts each item's posting terms in their own block and neutralises angle brackets, bridges on", () => {
    const prompt = buildMeaningCheckPrompt([ITEM, { ...ITEM, postingTerms: ["<renewable>"] }], { bridges: true })
    expect(prompt).toContain("<posting_terms>\n- renewable\n- energy\n</posting_terms>")
    expect(prompt).toContain("<posting_terms>\n- ‹renewable›\n</posting_terms>")
    // One block per item, in item order.
    expect(prompt.match(/<posting_terms>/g)).toHaveLength(2)
    expect(prompt.indexOf("<posting_terms>")).toBeGreaterThan(prompt.indexOf("</facts>"))
  })

  it("sends an empty block when the posting lends no terms, and never the posting text", () => {
    const prompt = buildMeaningCheckPrompt([{ ...ITEM, postingTerms: [] }], { bridges: true })
    expect(prompt).toContain("<posting_terms>\n\n</posting_terms>")
    expect(prompt).not.toContain("wind farm financial models for offshore projects, forecasting")
    expect(prompt).toContain("<facts>")
  })

  it("emits no posting_terms block at all when bridges are off (the default)", () => {
    for (const prompt of [buildMeaningCheckPrompt([ITEM]), buildMeaningCheckPrompt([ITEM], { bridges: false })]) {
      expect(prompt).not.toContain("<posting_terms>")
      expect(prompt).not.toContain("renewable\n- energy")
    }
  })

  it("accepts only an explicit supported: true for a known id", () => {
    const items = [ITEM]
    expect(supportedTexts(items, { results: [{ id: 0, supported: true }] })).toEqual(new Set([meaningKey(ITEM.line.text, ITEM.line.factIds)]))
    expect(supportedTexts(items, { results: [{ id: 0, supported: false }] })).toEqual(new Set())
    expect(supportedTexts(items, { results: [{ id: 7, supported: true }] })).toEqual(new Set())
  })
})
