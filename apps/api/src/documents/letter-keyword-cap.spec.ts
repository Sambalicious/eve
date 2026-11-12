import { describe, expect, it } from "vitest"

import type { AtsKeyword } from "../ats/ats-score.js"
import type { CoverLetterContent, DocumentLine } from "./document-model.js"
import { LETTER_KEYWORD_LIMIT, capLetterKeywords } from "./letter-keyword-cap.js"

const REACT: AtsKeyword = { keyword: "React", kind: "technology", group: "one:react" }

const body = (text: string): DocumentLine => ({ text, factIds: ["F1"] })

const letter = (paragraphs: readonly string[], greeting = "Dear Hiring Team,", closing = "Kind regards,"): CoverLetterContent => ({
  kind: "cover_letter",
  greeting,
  opening: null,
  paragraphs: paragraphs.map(body),
  closingLine: null,
  closing,
})

describe("letter keyword cap (EPIC-0012 rule 3, Revision 2 R14)", () => {
  it("keeps the cap explicit", () => {
    expect(LETTER_KEYWORD_LIMIT).toBe(3)
  })

  it("leaves three mentions untouched", () => {
    const input = letter(["I built React dashboards.", "React features shipped.", "My React work."])
    const result = capLetterKeywords(input, [REACT])
    expect(result).toMatchObject({ mentions: 3, dropped: 0, overCap: false })
    expect(result.letter).toEqual(input)
  })

  it("drops the sentence holding the fourth mention and keeps the rest of its paragraph", () => {
    const input = letter([
      "I built React dashboards.",
      "React features shipped.",
      "My React work.",
      "I built React dashboards. I also mentored six developers.",
    ])
    const result = capLetterKeywords(input, [REACT])
    expect(result).toMatchObject({ mentions: 4, dropped: 1 })
    expect(result.letter.paragraphs.map((paragraph) => paragraph.text)).toEqual([
      "I built React dashboards.",
      "React features shipped.",
      "My React work.",
      "I also mentored six developers.",
    ])
  })

  // Revision 2, R14 replaces R7's "a paragraph always keeps a sentence": a paragraph left empty by the cap
  // is dropped while another body paragraph remains.
  it("drops a paragraph left empty, while another body paragraph remains", () => {
    const input = letter(["I built React dashboards.", "React features shipped.", "My React work.", "React again."])
    const result = capLetterKeywords(input, [REACT])
    expect(result).toMatchObject({ mentions: 4, dropped: 1, overCap: false })
    expect(result.letter.paragraphs.map((paragraph) => paragraph.text)).toEqual([
      "I built React dashboards.",
      "React features shipped.",
      "My React work.",
    ])
  })

  it("neither counts nor changes a keyword in the greeting or the sign-off", () => {
    const input = letter(
      ["I built React dashboards.", "React features shipped.", "My React work.", "I built React dashboards. I also mentored six developers."],
      "Dear React Hiring Team,",
      "React regards,"
    )
    const result = capLetterKeywords(input, [REACT])
    expect(result).toMatchObject({ mentions: 4, dropped: 1 })
    expect(result.letter.greeting).toBe("Dear React Hiring Team,")
    expect(result.letter.closing).toBe("React regards,")
  })

  it("reports each trimmed paragraph with its original, so a judge verdict can follow the trim (R14 fix)", () => {
    const result = capLetterKeywords(letter(["I built React screens. I tested React code.", "I shipped React apps. I like plain work. I wrote React docs."]), [REACT])
    expect(result.trimmed).toHaveLength(1)
    expect(result.trimmed[0]?.from.text).toBe("I shipped React apps. I like plain work. I wrote React docs.")
    expect(result.trimmed[0]?.to.text).toBe("I shipped React apps. I like plain work.")
    expect(result.letter.paragraphs[1]).toEqual(result.trimmed[0]?.to)
  })

  it("reports nothing trimmed when nothing is cut", () => {
    expect(capLetterKeywords(letter(["I built React screens."]), [REACT]).trimmed).toEqual([])
  })
})
