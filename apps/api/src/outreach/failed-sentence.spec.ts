import { describe, expect, it } from "vitest"

import { OUTREACH_FIRST_FAILED_SENTENCE_MAX } from "@eve/contracts"

import { capFailedSentence, mentionsReaderName } from "./failed-sentence.js"

/**
 * EPIC-0014 architecture r1 D13: the first failed sentence's two pure rules.
 * The cap is defence in depth (the write schema already bounds the line) and the
 * name comparison is the privacy check both writers run under the row lock.
 */
const codePoints = (text: string) => Array.from(text).length
/** Whole words of at most six letters, so a cut can always find a boundary. */
const words = (count: number, width = 6) => Array.from({ length: count }, () => "x".repeat(width)).join(" ")

describe("capFailedSentence: the 400 code-point bound (D13, AC 11.4)", () => {
  it("returns null as given, and a whitespace-only sentence as null", () => {
    expect(capFailedSentence(null)).toBeNull()
    expect(capFailedSentence("   ")).toBeNull()
  })

  it("trims surrounding whitespace and keeps a sentence at the cap whole", () => {
    const sentence = words(66)
    const at400 = `${sentence.slice(0, 400)}`
    expect(codePoints(at400)).toBe(400)
    expect(capFailedSentence(`  ${at400}  `)).toBe(at400)
    expect(capFailedSentence(at400)).not.toContain("\u2026")
  })

  it("cuts a longer sentence at a whole word with one ellipsis, at most 400 code points", () => {
    const cut = capFailedSentence(words(100))!
    expect(codePoints(cut)).toBeLessThanOrEqual(OUTREACH_FIRST_FAILED_SENTENCE_MAX)
    expect(cut.endsWith(" \u2026")).toBe(true)
    const kept = cut.slice(0, -2)
    expect(kept.split(" ").every((word) => word === "x".repeat(6))).toBe(true)
    expect(cut).not.toContain("\u2014")
  })

  it("never splits an astral character", () => {
    const sentence = `${"\u{1F600}".repeat(401)} end`
    const cut = capFailedSentence(sentence)
    expect(cut).toBeNull()
    const mixed = `${words(70)} ${"\u{1F600}".repeat(20)}`
    const kept = capFailedSentence(mixed)
    if (kept !== null) expect(kept).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u)
  })

  it("withholds a sentence with no whole word to cut at", () => {
    expect(capFailedSentence("a".repeat(401))).toBeNull()
  })

  it("counts code points, so 400 astral characters are within the cap", () => {
    const sentence = "\u{1F600}".repeat(400)
    expect(capFailedSentence(sentence)).toBe(sentence)
  })
})

describe("mentionsReaderName: the Reader-name comparison (D13, decision 9)", () => {
  it.each([
    ["the full name", "I mentored Amara Okafor's team.", "Amara Okafor"],
    ["the full name in lower case", "i mentored amara okafor last year.", "Amara Okafor"],
    ["the first name only", "I asked Amara about the release.", "Amara Okafor"],
    ["a hyphenated part", "I worked with Okafor-Smith on the release.", "Okafor-Smith"],
    ["a part of three letters", "Sam reviewed the pull request.", "Sam Okafor"],
    ["an accent-folded part", "I met Amara last week.", "Amára Okafor"],
  ])("matches %s", (_case, sentence, name) => {
    expect(mentionsReaderName(sentence, name)).toBe(true)
  })

  it.each([
    ["a part of two letters", "I sold a van last week.", "An Li"],
    ["a part inside a longer word", "I advanced the release.", "An Li"],
    ["a different name", "I worked with Zorvex Quill.", "Amara Okafor"],
    ["a name inside a longer word", "The Okafors held a reunion.", "Amara Okafor"],
  ])("does not match %s", (_case, sentence, name) => {
    expect(mentionsReaderName(sentence, name)).toBe(false)
  })

  it("is conservative when a name is also a common word", () => {
    expect(mentionsReaderName("I will send the draft.", "Will")).toBe(true)
  })
})
