import { describe, expect, it } from "vitest"

import { normaliseForQuote, quoteAppearsIn } from "./source-quote.js"

const resume = normaliseForQuote(
  "Brightwave Ltd, Senior Frontend Engineer, 2021–2024\nLed a team of 4 frontend\nengineers at Brightwave Ltd, 2021-2024\n“Cut” load time by 38%"
)

describe("quoteAppearsIn", () => {
  it("finds an exact quote", () => {
    expect(quoteAppearsIn("Brightwave Ltd, Senior Frontend Engineer", resume)).toBe(true)
  })

  it("ignores line breaks, repeated spaces and case", () => {
    expect(quoteAppearsIn("led a team of 4   frontend engineers", resume)).toBe(true)
  })

  it("treats typographic dashes and quotes as their ASCII forms", () => {
    expect(quoteAppearsIn("2021-2024", resume)).toBe(true)
    expect(quoteAppearsIn('"Cut" load time by 38%', resume)).toBe(true)
  })

  it.each([
    ["U+2062", "Led a team of 4 front\u2062end engineers"],
    ["U+202E", "Led a team of 4 front\u202Eend engineers"],
    ["U+2066", "Led a team of 4 front\u2066end engineers"],
  ])("ignores a default-ignorable code point (%s) inside a quote (SEC-219)", (_label, quote) => {
    expect(quoteAppearsIn(quote, resume)).toBe(true)
  })

  it.each([
    ["a changed number", "Led a team of 5 frontend engineers"],
    ["an invented employer", "Senior Frontend Engineer at Google"],
    ["a too-short quote", "Ltd"],
    ["an empty quote", "   "],
  ])("rejects %s", (_label, quote) => {
    expect(quoteAppearsIn(quote, resume)).toBe(false)
  })
})
