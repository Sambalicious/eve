import { describe, expect, it } from "vitest"

import { postingsSearch, readPostingsView } from "./postings-url"

const read = (search: string) => readPostingsView(new URLSearchParams(search))
const canonical = (search: string) => {
  const view = read(search)
  return postingsSearch({ tab: view.hasTab ? view.tab : null, filter: view.filter })
}

describe("readPostingsView (8W.3, 8W.6)", () => {
  it("defaults to Good matches with no filter", () => {
    expect(read("")).toEqual({ tab: "good", legacyExcluded: false, hasTab: false, filter: { families: [], keyword: null } })
  })

  it("reads tab, families and keyword", () => {
    expect(read("tab=all&families=backend,mobile&keyword=go")).toEqual({
      tab: "all",
      legacyExcluded: false,
      hasTab: true,
      filter: { families: ["backend", "mobile"], keyword: "go" },
    })
  })

  it.each([
    ["tab=good&families=robotics", "tab=good"],
    ["tab=good&families=backend,frontend", "tab=good&families=backend"],
    ["tab=good&families=Backend", "tab=good"],
    ["tab=good&families=backend,", "tab=good&families=backend"],
    [`tab=good&keyword=${"a".repeat(101)}`, "tab=good"],
    // v1.12.1 postingKeywordSchema: a non-whitespace control character drops the keyword.
    ["tab=good&keyword=%00", "tab=good"],
    ["tab=good&keyword=re%00act", "tab=good"],
    ["tab=good&families=backend&keyword=go%7F", "tab=good&families=backend"],
    ["tab=good&keyword=%1Freact", "tab=good"],
    // Whitespace controls are trimmed, not refused.
    ["tab=good&keyword=%09react%0A", "tab=good&keyword=react"],
    [`tab=good&families=mobile&keyword=${"a".repeat(101)}`, "tab=good&families=mobile"],
    ["tab=good&keyword=%20%20", "tab=good"],
    ["tab=good&families=mobile,backend", "tab=good&families=backend,mobile"],
    ["tab=good&keyword=%20react%20", "tab=good&keyword=react"],
    ["tab=bogus&keyword=react", "keyword=react"],
    // 8d.15 (WEB-16): a keyword that folds to empty (keywordFoldsToEmpty) is no keyword.
    ["tab=good&keyword=%E2%80%8B", "tab=good"],
    ["tab=good&keyword=%C2%AD", "tab=good"],
    ["tab=good&keyword=%CC%81", "tab=good"],
    ["tab=good&families=mobile&keyword=%E2%81%A0%E2%80%8B", "tab=good&families=mobile"],
    ["tab=good&keyword=%20%EF%BB%BF%20", "tab=good"],
    // Mixed visible and invisible characters is a real keyword; the server folds it.
    ["tab=good&keyword=re%E2%80%8Bact", "tab=good&keyword=re%E2%80%8Bact"],
    // A control character is still refused, invisible characters or not.
    ["tab=good&keyword=%E2%80%8B%00", "tab=good"],
    ["", ""],
  ])("canonicalises %s to %s", (input, output) => {
    expect(canonical(input)).toBe(output)
  })

  it("AC-4.5 the old tab values map onto the new ones, and excluded_family remembers its section", () => {
    expect(read("tab=ranked")).toMatchObject({ tab: "good", hasTab: true, legacyExcluded: false })
    expect(read("tab=skipped")).toMatchObject({ tab: "not_a_match", hasTab: true, legacyExcluded: false })
    expect(read("tab=excluded_family")).toMatchObject({ tab: "not_a_match", hasTab: true, legacyExcluded: true })
    expect(canonical("tab=excluded_family&families=mobile")).toBe("tab=not_a_match&families=mobile")
  })

  it("accepts a keyword of exactly 100 characters after trimming", () => {
    expect(read(`keyword=${encodeURIComponent(`  ${"a".repeat(100)}  `)}`).filter.keyword).toBe("a".repeat(100))
  })

  it("encodes the keyword and reads it back", () => {
    const search = postingsSearch({ tab: "all", filter: { families: [], keyword: "100% C++ & Go" } })
    expect(search).toBe("tab=all&keyword=100%25%20C%2B%2B%20%26%20Go")
    expect(read(search).filter.keyword).toBe("100% C++ & Go")
  })

  it("8d.15 never writes a keyword that folds to empty", () => {
    expect(postingsSearch({ tab: "good", filter: { families: [], keyword: "\u200B" } })).toBe("tab=good")
    expect(postingsSearch({ tab: null, filter: { families: ["mobile"], keyword: " \u00AD\u2060 " } })).toBe("families=mobile")
  })

  it("dedupes repeated family keys", () => {
    expect(read("families=backend,backend,mobile").filter.families).toEqual(["backend", "mobile"])
  })
})
