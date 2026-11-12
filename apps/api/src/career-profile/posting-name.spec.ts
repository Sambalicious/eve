import { describe, expect, it } from "vitest"

import { letterName } from "./posting-name.js"

// SEC-411 (slice 5 prework): Unicode terminators and confusables no longer
// bypass letterName. Strings from security-recheck-SEC-410.md step 2.
describe("letterName: Unicode sentence punctuation after NFKC (SEC-411)", () => {
  it.each([
    ["U+FF0E fullwidth full stop", "Frontend Engineer\uFF0E Payments Team"],
    ["U+FE52 small full stop", "Frontend Engineer\uFE52 Payments Team"],
    ["U+06D4 Arabic full stop", "Frontend Engineer\u06D4 Payments Team"],
    ["U+0589 Armenian full stop", "Frontend Engineer\u0589 Payments Team"],
    ["U+1362 Ethiopic full stop", "Frontend Engineer\u1362 Payments Team"],
    ["U+0964 Devanagari danda", "Frontend Engineer\u0964 Payments Team"],
    ["U+203C double exclamation", "Frontend Engineer\u203C Payments Team"],
    ["U+FF61 halfwidth ideographic full stop", "Frontend Engineer\uFF61 Payments Team"],
    ["U+FE54 small semicolon", "Frontend Engineer\uFE54 Payments Team"],
    ["U+FE56 small question mark", "Frontend Engineer\uFE56 Payments Team"],
    ["U+2024 one dot leader", "Frontend Engineer\u2024 Payments Team"],
    ["U+060C Arabic comma", "Frontend Engineer\u060C Payments Team"],
    ["U+3001 ideographic comma", "Frontend Engineer\u3001 Payments Team"],
  ])("%s gives null", (_label, raw) => {
    expect(letterName(raw)).toBeNull()
  })
})

describe("letterName: confusables and mixed scripts (SEC-411)", () => {
  it.each([
    ["Cyrillic Р in PhD", "Frontend Engineer \u0420hD"],
    ["all-Cyrillic МВА", "Frontend Engineer \u041C\u0412\u0410"],
    ["Greek Δ in PhD", "Frontend Engineer Ph\u0394"],
    ["Cyrillic Е in Ex", "\u0415x Google Staff Engineer"],
    ["Cyrillic І in I", "Frontend Engineer \u0406 Team"],
    ["Greek omicron in former", "Frontend Engineer f\u03BFrmer Google"],
    ["math bold PhD", "Frontend Engineer \u{1D40F}\u{1D421}\u{1D403}"],
    ["fullwidth PhD", "Frontend Engineer \uFF30\uFF48\uFF24"],
    ["fullwidth digits", "Frontend Engineer \uFF11\uFF15 years"],
    ["mixed-script word", "Fr\u043Entend Engineer"],
  ])("%s gives null", (_label, raw) => {
    expect(letterName(raw)).toBeNull()
  })

  it.each([
    ["Senior Frontend Engineer", "Senior Frontend Engineer"],
    ["Staff Software Engineer, Payments", "Staff Software Engineer, Payments"],
    ["Back-end Engineer (Remote)", "Back-end Engineer (Remote)"],
    ["O'Reilly & Sons", "O'Reilly & Sons"],
    ["Ingénieur Logiciel", "Ingénieur Logiciel"],
    ["Société Générale", "Société Générale"],
    ["Яндекс", "Яндекс"],
    ["Ελληνική Εταιρεία", "Ελληνική Εταιρεία"],
    ["株式会社メルカリ", "株式会社メルカリ"],
    ["Acme\u00a0Payments", "Acme Payments"],
    ["ﬁntech Labs", "fintech Labs"],
  ])("a normal name is kept: %s", (raw, expected) => {
    expect(letterName(raw)).toBe(expected)
  })
})
