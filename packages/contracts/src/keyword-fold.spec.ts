import { describe, expect, it } from "vitest"

import { foldForKeywords, jobPostingsPath, jobPostingsQuerySchema, keywordFoldsToEmpty, postingKeywordSchema } from "./index.js"

/**
 * Slice 8d (8d.13, 8d.14, D8d-5): a keyword that folds to empty is no keyword,
 * through one shared function (PF-69, PF-70, PF-71, PF-72, PF-74).
 */
const parse = (query: Record<string, unknown>) => jobPostingsQuerySchema.safeParse(query)

/** PF-69 and PF-70: every character the fold removes, alone or with whitespace. */
const INVISIBLE: ReadonlyArray<readonly [string, string]> = [
  ["U+200B", "\u200b"],
  ["U+00AD", "\u00ad"],
  ["U+2060 U+200B", "\u2060\u200b"],
  ["U+0301", "\u0301"],
  ["U+034F", "\u034f"],
  ["U+180E", "\u180e"],
  ["U+200B..U+200F", "\u200b\u200c\u200d\u200e\u200f"],
  ["U+202A..U+202E", "\u202a\u202b\u202c\u202d\u202e"],
  ["U+2060..U+2064", "\u2060\u2061\u2062\u2063\u2064"],
  ["U+FEFF", "\ufeff"],
  ["U+FE0F", "\ufe0f"],
  ["U+200B inside spaces", "  \u200b  "],
  ["combining marks only", "\u0300\u0301\u0302"],
  ["tab, ZWSP, newline", "\t\u200b\n"],
]

describe("keywordFoldsToEmpty (8d.13)", () => {
  it.each(INVISIBLE)("%s folds to empty", (_label, keyword) => {
    expect(keywordFoldsToEmpty(keyword)).toBe(true)
  })

  it.each(["", " ", "\t\n"])("blank %j folds to empty", (keyword) => {
    expect(keywordFoldsToEmpty(keyword)).toBe(true)
  })

  it.each(["k", "\u200bk\u00ad", "é", "e\u0301", "-", "%", "_", "😀", "1"])("%j is a keyword", (keyword) => {
    expect(keywordFoldsToEmpty(keyword)).toBe(false)
  })

  it("is defined by the fold, not a character list: every code point the fold drops on its own is caught", () => {
    let dropped = 0
    for (let code = 0x20; code <= 0xffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue
      const char = String.fromCharCode(code)
      if (foldForKeywords(char).trim() === "") {
        dropped += 1
        expect(keywordFoldsToEmpty(char)).toBe(true)
      }
    }
    expect(dropped).toBeGreaterThan(1000)
  })
})

describe("the query schema treats a fold-empty keyword as no keyword (PF-69 to PF-72)", () => {
  it.each(INVISIBLE)("%s parses to keyword null", (_label, keyword) => {
    expect(parse({ keyword })).toMatchObject({ success: true, data: { keyword: null } })
  })

  it("a visible letter among invisible characters is still a keyword (PF-72)", () => {
    expect(parse({ keyword: "\u200bk\u00ad" }).data?.keyword).toBe("\u200bk\u00ad")
  })

  it.each(["\u200b\u0000", "\u0001\u00ad", "\u007f\u0301"])("control characters with invisible ones are still refused (PF-71): %j", (keyword) => {
    expect(parse({ keyword }).success).toBe(false)
  })

  it("postingKeywordSchema keeps its v1.12.1 behaviour; the fold-empty rule is applied on top", () => {
    expect(postingKeywordSchema.parse("  react ")).toBe("react")
    expect(postingKeywordSchema.safeParse("\u0000").success).toBe(false)
  })

  it("jobPostingsPath leaves out a fold-empty keyword", () => {
    expect(jobPostingsPath({ tab: "ranked", keyword: "\u200b" })).toBe("/v1/job-postings?tab=ranked")
    expect(jobPostingsPath({ tab: "ranked", keyword: "\u0301 " })).toBe("/v1/job-postings?tab=ranked")
  })
})

describe("foldForKeywords (shared; slice 8 behaviour unchanged)", () => {
  it.each([
    ["Développeur   BACKEND", "developpeur backend"],
    ["U.S. only", "us only"],
    ["Back\u2010End", "back-end"],
    ["Soft\u00adware", "software"],
    ["DÉVELOPPEUR MOBILE", "developpeur mobile"],
  ])("%j folds to %j", (text, folded) => {
    expect(foldForKeywords(text)).toBe(folded)
  })
})
