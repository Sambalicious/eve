import { describe, expect, it } from "vitest"

import { type FactWording, type LetterTarget, dropUnsupportedSentences, validateDocument } from "./document-claims.js"
import type { CoverLetterContent } from "./document-model.js"
import {
  charClassOf,
  completionWordIn,
  directionAllowance,
  isQuoteLike,
  sentencesOf,
  storedDirectionQuotes,
  unsourcedQuotationIn,
  withoutDirectionQuote,
} from "./company-direction.js"

/**
 * EPIC-0012 rule 4 (design 2d, 2e): a letter sentence may carry one span copied exactly from a stored
 * forward statement, inside quotation marks, in a sentence that says "you" or "your" about the employer
 * and holds no first-person word. Only that span leaves the claim and number checks.
 */
const QUOTES = ["Our aim is to halve operational emissions by 2030", "We will cut water use by 40% across the group"]

/** Everything a line may point at in the provenance tests: the stored quotes and one cited fact's words. */
const SOURCES = [...QUOTES, "Mentored 6 junior developers"]

/** Whitespace runs are noise in these checks; the words are what matter. */
const collapsed = (text: string | null) => text?.replace(/\s+/g, " ").trim() ?? null

describe("EPIC-0012 rule 4: the quoted direction span", () => {
  it("removes an exactly copied span of three or more words and spends the allowance", () => {
    const allowance = directionAllowance()
    const text = "Your aim to “halve operational emissions by 2030” is clear."
    expect(collapsed(withoutDirectionQuote(text, QUOTES, allowance))).toBe("Your aim to is clear.")
    expect(allowance.used).toBe(true)
  })

  it("accepts straight quotes as well as typographic ones", () => {
    expect(collapsed(withoutDirectionQuote('Your plan to "halve operational emissions by 2030" is clear.', QUOTES, directionAllowance()))).toBe(
      "Your plan to is clear."
    )
  })

  it("takes a span from the middle of a stored quote, copied word for word", () => {
    expect(collapsed(withoutDirectionQuote("Your target of “cut water use by 40%” is clear.", QUOTES, directionAllowance()))).toBe(
      "Your target of is clear."
    )
  })

  // Review fix (post-R26): the stripped sentence goes back through `String.replace`, so a `$'` (or `$&`, or
  // `` $` ``) in what is left of it must stay as written rather than be read as a replacement pattern. The
  // literal is a frame word here (it carries no letter), so the strip itself still passes.
  it("keeps a replacement pattern in the remaining text as written", () => {
    const text = "Your plan to “halve operational emissions by 2030” is clear $'. We are a team."
    expect(collapsed(withoutDirectionQuote(text, QUOTES, directionAllowance()))).toBe("Your plan to is clear $'. We are a team.")
  })

  it("leaves an altered quote in place, so its number still fails", () => {
    expect(withoutDirectionQuote("Your aim to “halve operational emissions by 2035” is clear.", QUOTES, directionAllowance())).toBeNull()
    // R4: a word outside the span that is not a frame word blocks the strip, so the altered number stays.
    expect(withoutDirectionQuote("Your aim to “halve operational emissions” is 2035.", QUOTES, directionAllowance())).toBeNull()
  })

  it("leaves an unquoted span in place", () => {
    expect(withoutDirectionQuote("Your 2030 agenda sets a clear test.", QUOTES, directionAllowance())).toBeNull()
  })

  it("refuses a span shorter than three words", () => {
    expect(withoutDirectionQuote("Your aim to “by 2030” sets a test.", QUOTES, directionAllowance())).toBeNull()
  })

  it("refuses a sentence that says nothing about the employer", () => {
    expect(withoutDirectionQuote("The plan to “halve operational emissions by 2030” is clear.", QUOTES, directionAllowance())).toBeNull()
  })

  it.each([
    ["I", "Your aim to “halve operational emissions by 2030” is one I helped deliver."],
    ["we", "Your aim to “halve operational emissions by 2030” is one we helped deliver."],
    ["our", "Your aim to “halve operational emissions by 2030” matches our work."],
    ["I've", "Your aim to “halve operational emissions by 2030” is one I've helped deliver."],
    ["we're", "Your aim to “halve operational emissions by 2030” is one we're helping deliver."],
  ])("refuses a direction sentence with a first-person word (%s)", (_word, text) => {
    expect(withoutDirectionQuote(text, QUOTES, directionAllowance())).toBeNull()
  })

  it("allows one span per letter: a spent allowance strips nothing", () => {
    const allowance = directionAllowance()
    expect(withoutDirectionQuote("Your aim to “halve operational emissions by 2030” is clear.", QUOTES, allowance)).not.toBeNull()
    expect(withoutDirectionQuote("Your plan to “cut water use by 40%” is clear.", QUOTES, allowance)).toBeNull()
  })

  it("strips nothing when the posting has no direction quotes", () => {
    expect(withoutDirectionQuote("Your aim to “halve operational emissions by 2030” sets a test.", [], directionAllowance())).toBeNull()
  })

  it("strips only the first sentence that meets the form", () => {
    const text = "Your aim to “halve operational emissions by 2030” is clear. Your plan to “cut water use by 40%” is clear."
    const stripped = withoutDirectionQuote(text, QUOTES, directionAllowance())
    expect(collapsed(stripped)).toBe("Your aim to is clear. Your plan to “cut water use by 40%” is clear.")
  })
})

describe("EPIC-0012 rule 4: sentences split as the letter repair splits them", () => {
  it("splits on a full stop before a capital", () => {
    expect(sentencesOf("Your aim is clear. I built the models.")).toEqual(["Your aim is clear.", "I built the models."])
  })

  it("does not split after an abbreviation", () => {
    expect(sentencesOf("I built models, e.g. wind farm models. I cut cost.")).toEqual(["I built models, e.g. wind farm models.", "I cut cost."])
  })
})

/** Revision 3, R19: every quoted span in a document line must repeat words the line can point at. */
describe("EPIC-0012 Revision 3, R19: a quotation must come from somewhere", () => {
  it.each([
    ["a whole stored quote", "“halve operational emissions by 2030”"],
    ["a run from the middle of a stored quote", "“water use by 40% across”"],
    ["one token", "“emissions”"],
    ["a phrase from a cited fact", "“mentored 6 junior developers”"],
  ])("a span backed by a source passes (%s)", (_name, span) => {
    expect(unsourcedQuotationIn(`Your plan to ${span} is clear.`, SOURCES)).toBeNull()
  })

  it.each([
    ["words no source holds", "Your plan to “double revenue within the decade” is clear.", "double revenue within the decade"],
    ["a span cut inside a token", "Your plan to “alve operational emissions” is clear.", "alve operational emissions"],
    ["a token inserted in a run", "Your plan to “halve operational emissions by 2035” is clear.", "halve operational emissions by 2035"],
  ])("a span no source backs is returned (%s)", (_name, text, span) => {
    expect(unsourcedQuotationIn(text, SOURCES)).toBe(span)
  })

  it("two quotations in one sentence are checked as one stretch", () => {
    // Revision 5, R23 (C1): the whole stretch from the first mark to the last is one envelope, so two separate
    // quotations fail unless that stretch itself is one run of one source.
    expect(unsourcedQuotationIn("Your aim to “BY 2030” and “not a quote” are clear.", SOURCES)).toBe("BY 2030” and “not a quote")
    expect(unsourcedQuotationIn("You wrote «halve operational emissions by 2030» and „water use by 40%“ there.", SOURCES)).not.toBeNull()
  })

  it.each([
    ["a contraction", "I'm proud of the team's work."],
    ["a possessive plural", "The teams' goals are clear."],
    ["a straight single quote inside a word", "It's the model's own number."],
  ])("%s is not a quotation", (_name, text) => {
    expect(unsourcedQuotationIn(text, SOURCES)).toBeNull()
  })

  it("a single quote at a word boundary is a quotation and is checked", () => {
    expect(unsourcedQuotationIn("Your plan to 'double revenue' is clear.", SOURCES)).toBe("double revenue")
    expect(unsourcedQuotationIn("Your plan to 'halve operational emissions by 2030' is clear.", SOURCES)).toBeNull()
  })

  it("an unbalanced double mark fails closed on its whole sentence", () => {
    expect(unsourcedQuotationIn("Your plan to “halve operational emissions by 2030 is clear.", SOURCES)).toBe(
      "Your plan to “halve operational emissions by 2030 is clear."
    )
  })
})

/**
 * Revision 5, R23: a quotation is found by content, not by pairing marks. Every quote-like mark that could
 * bound a quotation is active; the text between the first and the last is checked as one run of one source,
 * and two layout tests keep anything outside that region from reading as quoted.
 */
describe("EPIC-0012 Revision 5, R23: quotation provenance by content", () => {
  const FAB = "double revenue within the decade"
  const STORED = "halve operational emissions by 2030"

  it.each([
    ["„…” (low-9 opened, right mark closed)", "„", "”"],
    ["”…” (two right marks)", "”", "”"],
    ["“…“ (two left marks)", "“", "“"],
    ["»…« (reversed guillemets)", "»", "«"],
    ["‹…› (single guillemets)", "‹", "›"],
    ["「…」 (corner brackets)", "「", "」"],
    ["『…』 (white corner brackets)", "『", "』"],
    ["﹁…﹂ (presentation forms)", "﹁", "﹂"],
    ["〝…〞 (ditto marks)", "〝", "〞"],
    ["＂…＂ (fullwidth marks)", "＂", "＂"],
    ["’…’ (right single marks)", "’", "’"],
    ["‘…’ (left single marks)", "‘", "’"],
    ["‚…‘ (low single opened, left single closed)", "‚", "‘"],
    ["´…´ (acute accents)", "´", "´"],
    ["′…′ (primes)", "′", "′"],
    ["＇…＇ (fullwidth apostrophes)", "＇", "＇"],
    ["`…` (backticks)", "`", "`"],
  ])("%s is a quotation and its span is checked", (_name, open, close) => {
    expect(unsourcedQuotationIn(`Your plan to ${open}${FAB}${close} is clear.`, SOURCES)).toBe(FAB)
  })

  it.each([
    ["‚…‘", "‚", "‘"],
    ["’…’", "’", "’"],
    ["「…」", "「", "」"],
  ])("a sourced phrase in %s passes", (_name, open, close) => {
    expect(unsourcedQuotationIn(`Your plan to ${open}${STORED}${close} is clear.`, SOURCES)).toBeNull()
  })

  it("an inner possessive or apostrophe never ends the span early", () => {
    expect(unsourcedQuotationIn("Your plan to ‘double the team’s revenue within the decade’ is clear.", SOURCES)).toBe(
      "double the team’s revenue within the decade"
    )
    expect(unsourcedQuotationIn("Your plan to ‘double the teams’ revenue within the decade’ is clear.", SOURCES)).toBe(
      "double the teams’ revenue within the decade"
    )
  })

  it("an opener after a dash or a colon opens a span", () => {
    expect(unsourcedQuotationIn(`Your plan–‘${FAB}’–is clear.`, SOURCES)).toBe(FAB)
    expect(unsourcedQuotationIn(`Your plan:'${FAB}' is clear.`, SOURCES)).toBe(FAB)
  })

  it("a single opener with no closer fails closed on its whole sentence", () => {
    expect(unsourcedQuotationIn("Your plan to 'double revenue is clear.", SOURCES)).toBe("Your plan to 'double revenue is clear.")
  })

  it("a mark inside a word opens a span when something closes it", () => {
    expect(unsourcedQuotationIn("Your plan'double revenue' is clear.", SOURCES)).toBe("double revenue")
  })

  it.each([
    ["a decade before a plural s", "In the '90s I built models."],
    ["an elision", "'Twas a pleasure."],
    ["a contraction", "I'm proud of the team's work."],
    ["a plural possessive", "The teams' goals are clear."],
    ["a singular possessive", "I built my team's models."],
    ["a name", "I worked with O'Brien."],
    ["a name ending in a mark", "I met the founder at Dunkin' Donuts."],
    ["a mark inside a name", "I built models in Hawai'i."],
  ])("%s is not a quotation", (_name, text) => {
    expect(unsourcedQuotationIn(text, SOURCES)).toBeNull()
  })

  it("two quotations in one sentence are one envelope, so two separate sources fail closed (C1)", () => {
    expect(unsourcedQuotationIn("the 'A' and 'B' awards", ["the A award", "the B award"])).not.toBeNull()
    // The companion: one source holding the whole stretch from the first mark to the last is still one run.
    expect(unsourcedQuotationIn("the 'A award' and more", ["the A award and more"])).toBeNull()
  })
})

/**
 * Revision 5, R23: the pins from the design. N1 to N15 are new adversarial readings; L1 to L8, N16 and the
 * name-mark row must pass; the fact-self rows pin S0; C1 to C6 are the accepted costs; (i) and (ii) are the
 * stated residuals. Sources are the stored quotes plus the WIND fact, or the named fact.
 */
describe("EPIC-0012 Revision 5, R23: adversarial and must-pass pins", () => {
  const FAB = "double revenue within the decade"
  const WIND = "Built wind farm financial models for offshore projects, forecasting revenue and cost"
  const AWARD = 'Won the "analyst of the year" award for the forecasting models'
  const TEAMS = "Built the teams' shared forecasting models"
  const PIN_SOURCES = [...QUOTES, WIND]

  it.each([
    ["N1 triple nesting", `Your plan to “‘«${FAB}»’” is clear.`, PIN_SOURCES],
    ["N2 a sourced shell in curly singles", `I won the ‘analyst of the year ‘${FAB}’ award’ too.`, [AWARD]],
    ["N3 a closer before an opener, empty envelope", `Your plan to ${FAB}” “is clear.`, PIN_SOURCES],
    ["N4 a sourced envelope outside the region", `Your aim” is “${FAB}.`, PIN_SOURCES],
    ["N5 glued on both sides, sourced envelope", `Your plan”to“${FAB}.`, PIN_SOURCES],
    ["N6 an elision opener and a possessive closer", `Your plan to 'Twas ${FAB}s' is clear.`, PIN_SOURCES],
    ["N7 a name mark as the opener", `Your plan to O’${FAB}s’ is clear.`, PIN_SOURCES],
    ["N8 an n-unit as the opener", `Your plan to 'n' ${FAB}' is clear.`, PIN_SOURCES],
    ["N9 Ps/Pe brackets in no list", `Your plan to ❮${FAB}❯ and ⟨more⟩ is clear.`, PIN_SOURCES],
    ["N10 a rare Pi/Pf pair", `Your plan to ⸌${FAB}⸍ is clear.`, PIN_SOURCES],
    ["N11 saltillo look-alikes", `Your plan to ꞌ${FAB}ꞌ is clear.`, PIN_SOURCES],
    ["N12 a sourced quotation, then an unclosed one", `Your plan to “halve operational emissions by 2030” “${FAB}.`, PIN_SOURCES],
    ["N13 in-word marks", `Your plan to Hawai'${FAB}'i is clear.`, PIN_SOURCES],
    ["N14 gershayim", `Your plan to ״${FAB}״ is clear.`, PIN_SOURCES],
    ["N15 chopped single-token quotations in mixed marks", "Your plan to “double”‘revenue’ is clear.", PIN_SOURCES],
  ])("%s fails closed", (_name, text, sources) => {
    expect(unsourcedQuotationIn(text, sources)).not.toBeNull()
  })

  it.each([
    ["L1 a sourced quotation holding a plural possessive", `I built “the teams' shared forecasting models”.`, [TEAMS]],
    ["L2 a contraction after a sourced quotation", `I won the “analyst of the year” award and I'm proud of it.`, [AWARD]],
    ["L3 a trailing possessive before a sourced quotation", `The teams' “analyst of the year” award went to me.`, [AWARD]],
    ["L4 an elision after a sourced quotation", `I won the “analyst of the year” award in the ’90s.`, [AWARD]],
    ["L5 a contraction before a sourced quotation", `My manager's “analyst of the year” nomination.`, [AWARD]],
    ["L6 an in-word mark in a name", "I built models in Hawaiʻi.", []],
    ["L7 ordinary brackets around a sourced quotation", `Built models (offshore) for “analyst of the year” award`, [AWARD]],
    ["L8 two sourced quotations whose stretch is one run", `Won the “analyst of the year” award for the “forecasting models”`, [AWARD]],
    ["N16 the fact's own words with the marks moved", `Won the analyst “of the year award for” the forecasting models`, [AWARD]],
    ["S4's name-mark exemption", `Together, O'Brien and I won the 'A' award.`, ["O'Brien and I won the 'A' award"]],
  ])("%s passes", (_name, text, sources) => {
    expect(unsourcedQuotationIn(text, sources)).toBeNull()
  })

  it.each([
    "Built the teams' shared forecasting models",
    AWARD,
    "Built models in Hawai'i and the teams' dashboards",
    "Led O'Brien's team in the '90s on the teams' models",
    "Won the 'A' and 'B' awards",
    "Called it “ world class ” in review",
    "Shipped ““v2”” to 3 clients",
    "Named ‘rock 'n' roll analyst’ by peers",
  ])("a cited fact's own wording passes whatever its marks: %s", (wording) => {
    expect(unsourcedQuotationIn(wording, [`${wording}. Analyst, Acme, 2020–2023`])).toBeNull()
  })

  it.each([
    ["C1 two separate quotations", "the 'A' and 'B' awards", ["the A award", "the B award"]],
    ["C2 an elision before a quotation", "In the '90s I won the “analyst of the year” award", [AWARD]],
    ["C3 a possessive after a quotation", "I won the “analyst of the year” award for the teams' models", [AWARD]],
    ["C4 a name mark before a trailing mark", "I worked with O'Brien on the teams' models", PIN_SOURCES],
    ["C5 padded marks", "I won the “ analyst of the year ” award.", [AWARD]],
    ["C6 a name mark before a quotation", "I worked with O'Brien on the “analyst of the year” award", [AWARD]],
  ])("%s fails closed (accepted cost)", (_name, text, sources) => {
    expect(unsourcedQuotationIn(text, sources)).not.toBeNull()
  })

  it("OBSERVATION (R23 residual i): a contraction mark never bounds a quotation", () => {
    expect(unsourcedQuotationIn("Your plan's double revenue within the decade's goal is clear.", PIN_SOURCES)).toBeNull()
  })

  it.each([
    ["asterisks", `Your plan to *${FAB}* is clear.`],
    ["pipes", `Your plan to |${FAB}| is clear.`],
    ["tildes", `Your plan to ~${FAB}~ is clear.`],
  ])("OBSERVATION (R23 residual ii): %s are not quote-like, so they make no quotation", (_name, text) => {
    expect(unsourcedQuotationIn(text, PIN_SOURCES)).toBeNull()
  })
})

/**
 * Revision 5, R23 step 1: a mark is recognised by Unicode category, not a fixed list. Ordinary brackets, in
 * every width, stay plain text whatever their width or presentation form.
 */
describe("EPIC-0012 Revision 5, R23: which characters can hold a quotation", () => {
  it.each([
    // QA5-B3: marks outside R22's closed list
    ["｢"], ["｣"], ["❝"], ["❞"], ["❛"], ["❜"], ["〈"], ["〉"], ["《"], ["》"], ["ˮ"], ["〃"], ["⹂"],
    // R22 paired marks
    ['"'], ["“"], ["”"], ["„"], ["‟"], ["«"], ["»"], ["‹"], ["›"], ["「"], ["」"], ["『"], ["』"],
    ["﹁"], ["﹂"], ["﹃"], ["﹄"], ["〝"], ["〞"], ["〟"], ["＂"], ["″"],
    // R22 single marks
    ["'"], ["‘"], ["’"], ["‚"], ["‛"], ["´"], ["′"], ["＇"], ["ʼ"], ["ʻ"], ["`"],
    // tick look-alikes outside the named marks
    ["˝"], ["‴"], ["‵"], ["‶"], ["‷"], ["⁗"], ["｀"], ["ʹ"], ["ʺ"], ["ʽ"], ["ʾ"], ["ʿ"], ["ˈ"], ["ˊ"], ["ˋ"],
    ["❟"], ["❠"], ["🙶"], ["🙷"], ["🙸"], ["׳"], ["״"], ["Ꞌ"], ["ꞌ"],
  ])("%s is quote-like", (char) => {
    expect(isQuoteLike(char)).toBe(true)
  })

  it.each([
    ["("], [")"], ["["], ["]"], ["{"], ["}"],
    ["（"], ["）"], ["［"], ["］"], ["｛"], ["｝"], ["﹙"], ["﹚"], ["⁽"], ["⁾"], ["₍"], ["₎"],
    ["-"], ["–"], ["—"], [","], ["."], [";"], [":"], ["!"], ["?"], ["%"], ["&"], ["/"], ["*"], ["|"], ["~"],
  ])("%s is not quote-like", (char) => {
    expect(isQuoteLike(char)).toBe(false)
  })
})

/** Revision 3, R20: a completion word is any form of the claim, matched by `stem()` plus "hitting". */
describe("EPIC-0012 Revision 3, R20: completion words by stem", () => {
  it.each([
    ["met"], ["meet"], ["meets"], ["achieved"], ["achieve"], ["achieves"], ["achieving"], ["reached"], ["reach"],
    ["reaches"], ["reaching"], ["delivered"], ["deliver"], ["delivers"], ["delivering"], ["hit"], ["hits"],
    ["hitting"], ["done"], ["completed"], ["completes"], ["accomplishing"], ["accomplished"], ["fulfilled"],
    ["fulfils"], ["fulfilling"], ["realised"], ["realized"], ["exceeded"], ["exceeding"], ["surpassed"],
    ["surpasses"], ["surpassing"],
  ])("'%s' is a completion word", (word) => {
    expect(completionWordIn(`My wind farm financial models ${word} it.`)).not.toBeNull()
    expect(completionWordIn(word.toUpperCase())).not.toBeNull()
  })

  // The design keeps nouns with the judge: no noun list, so "completion" and "delivery" are not hard fails.
  it.each([["achievement"], ["delivery"], ["completion"], ["advances"], ["contributed"], ["aiming"], ["support"], ["helped"]])(
    "'%s' is not a completion word",
    (word) => {
      expect(completionWordIn(`My wind farm financial models ${word} it.`)).toBeNull()
    }
  )
})

/**
 * Revision 6, R24: default-deny quotation provenance. A character is a word, a space or an allowlisted plain
 * character; anything else is a mark. The envelope rule (S0 to S3) stays, a wordless envelope fails, and L1
 * to L4 make the outer marks attach only inward. The QA6 rows are pinned here at function level, with W1 to
 * W18 and the must-pass and cost rows from the design.
 */
describe("EPIC-0012 Revision 6, R24: default-deny quotation provenance", () => {
  const FAB = "double revenue within the decade"
  const AWARD = 'Won the "analyst of the year" award for the forecasting models'
  const WIND = "Built wind farm financial models for offshore projects, forecasting revenue and cost"
  const R24_SOURCES = [...QUOTES, AWARD, WIND]
  const AWARD_SRC = [AWARD]

  it.each([
    ["QA6-B2: ZWSP after each straight mark", `Your plan'\u200b${FAB}'\u200bis clear.`],
    ["QA6-B2: ZWSP after each curly mark", `Your plan’\u200b${FAB}’\u200bis clear.`],
    ["QA6-B2: word joiner", `Your plan'\u2060${FAB}'\u2060is clear.`],
    ["QA6-B2: zero-width non-joiner", `Your plan’\u200c${FAB}’\u200cis clear.`],
    ["QA6-B2: soft hyphen", `Your plan'\u00ad${FAB}'\u00adis clear.`],
    ["QA6-B2: combining acute on each mark", `Your plan'\u0301${FAB}'\u0301is clear.`],
    ["QA6-B2: after a one-letter word, ZWSP", `Your plan is a'\u200b${FAB}'\u200b goal.`],
    ["QA6-B3: closer after a full stop, then ;", `Your plan to ${FAB}.”; the “analyst of the year” award is mine.`],
    ["QA6-B3: closer after a full stop, opener glued", `Your plan to ${FAB}.”“analyst of the year” is my title.`],
    ["QA6-B3: closer after !, then em dash", `Your plan to ${FAB}!”—“analyst of the year” too.`],
    ["QA6-B3: spaced closer, then em dash", `Your plan to ${FAB} ”—“analyst of the year” too.`],
    ["QA6-B3: unclosed opener after a colon and an ellipsis", `I won the “analyst of the year” award:“…${FAB}.`],
    ["QA6-B3: unclosed opener between em dashes", `I won the “analyst of the year” award—“—${FAB}.`],
    ["QA6-B3: N3 with ZWSP (renders FAB”“is)", `Your plan to ${FAB}\u200b”“\u200bis clear.`],
    ["QA6-B3: N5 with ZWSP (renders plan”the“FAB)", `Your plan\u200b”the“\u200b${FAB}.`],
    ["R19: a closer after a full stop then ')'", `(Your plan to ${FAB}.”) “Analyst of the year” is my title.`],
  ])("%s fails closed", (_name, text) => {
    expect(unsourcedQuotationIn(text, R24_SOURCES)).not.toBeNull()
  })

  // W1 to W18 from R24: two rows carry two inputs, so W11 and W17 each pin both.
  it.each([
    ["W1: RTL isolate", `Your plan to \u2067“${FAB}”\u2069 is clear.`],
    ["W2: RLM before an unopened closer", `Your plan to ${FAB}\u200f”“analyst of the year” too.`],
    ["W3: bidi override", `I won the “analyst of the year” award \u202eedaced eht nihtiw eunever elbuod\u202c.`],
    ["W4: variation selector", `Your plan'\ufe0f${FAB}'\ufe0fis clear.`],
    ["W5: combining grapheme joiner", `Your plan’\u034f${FAB}’\u034fis clear.`],
    ["W6: Mongolian vowel separator", `Your plan'\u180e${FAB}'\u180eis clear.`],
    ["W7: ZWJ with fullwidth apostrophes", `Your plan＇\u200d${FAB}＇\u200dis clear.`],
    ["W8: Canadian syllabics drawn as ticks", `Your plan to ᐟ${FAB}ᐠ is clear.`],
    ["W9: tonos and psili", `Your plan to ΄${FAB}᾿ is clear.`],
    ["W10: combining comma above right", `Your plan\u0315${FAB}\u0315 is clear.`],
    ["W11: homoglyph guillemets, fullwidth", `Your plan to ＜＜${FAB}＞＞ is clear.`],
    ["W11: homoglyph guillemets, ASCII", `Your plan to <<${FAB}>> is clear.`],
    ["W12: closer glued to a number", `Your plan to ${FAB} by 40%”“cut water use” is clear.`],
    ["W13: digit, en dash", `Your aim to ${FAB} by 2030”–“halve operational emissions” is clear.`],
    ["W14: marks inside a number", `Your plan to 2'${FAB}'0 is clear.`],
    ["W15: opener glued right after a full stop", `I won the “analyst of the year” award.“…${FAB}.`],
    ["W16: last mark glued out through a dash", `I won the “analyst of the year” award“—${FAB}.`],
    ["W17: a wordless envelope between spaced marks", `Your plan to ${FAB} ”—“ is clear.`],
    ["W17: a wordless envelope before a word", `Your plan to ”“ ${FAB}.`],
    ["W18: unopened trailing mark on a non-s word", `Your plan to ${FAB}' “analyst of the year” too.`],
  ])("%s fails closed", (_name, text) => {
    expect(unsourcedQuotationIn(text, R24_SOURCES)).not.toBeNull()
  })

  describe("must-pass rows (null)", () => {
    it.each([
      ["an o'clock time", "From 9 o'clock to 5 o'clock I modelled."],
      ["Hawai'i and O'ahu", "I built models in Hawai'i and O'ahu."],
      ["y'all and ma'am", "Thank y'all, ma'am."],
      ["a number possessive", "I managed CHF 5'000 budgets."],
      ["a trailing mark after a number", "The 5' cable."],
      ["a name ending in in", "I met the founder at Dunkin' Donuts."],
    ])("%s is not a quotation", (_name, text) => {
      expect(unsourcedQuotationIn(text, AWARD_SRC)).toBeNull()
    })

    it.each([
      ["US style with the comma inside", "I won the “analyst of the year,” the top award."],
      ["US style with the full stop inside", "I won the “analyst of the year.” award"],
      ["German „…“", "I won the „analyst of the year“ award."],
      ["Swedish ”…”", "I won the ”analyst of the year” award."],
      ["«…»", "I won the «analyst of the year» award."],
      ["brackets around the quotation", "I won (“analyst of the year”) twice."],
      ["a name before the quotation", "José won the “analyst of the year” award."],
      ["NBSP around the quotation", "I won the\u00a0“analyst of the year”\u00a0award."],
    ])("%s passes", (_name, text) => {
      expect(unsourcedQuotationIn(text, AWARD_SRC)).toBeNull()
    })

    it("a stored quote passes", () => {
      expect(unsourcedQuotationIn("Your plan to “cut water use by 40%” is clear.", QUOTES)).toBeNull()
    })

    it.each([
      ["plain symbols and digits", "React • TypeScript | Jest ~ 3 years"],
      ["currency, degrees and multiplication", "Modelled 1.5°C pathways worth £40m and €3 × 2."],
      ["ellipsis and dashes", "I built models… in 2020–2023 — and more."],
      ["Arabic-Indic digits", "Mentored ٦ junior developers"],
      ["fullwidth digits", "Mentored ６ junior developers"],
    ])("%s are plain text, not marks", (_name, text) => {
      expect(unsourcedQuotationIn(text, [])).toBeNull()
    })

    it.each([
      ["ZWSP inside a fact's words", "Built wind\u200bfarm models"],
      ["CJK inside a fact's words", "Built models for 北京 Energy"],
    ])("%s pass against the fact's own wording (S0)", (_name, wording) => {
      expect(unsourcedQuotationIn(wording, [`${wording}. Analyst, Acme, 2020–2023`])).toBeNull()
    })
  })

  // Residual (iii), narrowed by R25 B: spacing decides, glyph orientation never does, for the two shapes below.
  // An opener left unclosed is no longer one of them.
  it.each([
    ["a spaced closer before the envelope", `Your plan to ${FAB} ”analyst of the year” too.`],
    ["an s-possessive before the envelope", `Your plan to ${FAB}s' “analyst of the year” too.`],
  ])("OBSERVATION (R24 residual iii): %s passes", (_name, text) => {
    expect(unsourcedQuotationIn(text, AWARD_SRC)).toBeNull()
  })

  it("R25 B: an outer mark attached to the envelope is refused", () => {
    expect(unsourcedQuotationIn(`I won the “analyst of the year” award“ ${FAB}.`, AWARD_SRC)).not.toBeNull()
  })

  it.each([
    ["C5: an outer mark attached through a dash", "Rated “analyst of the year”—the top award.", AWARD_SRC],
    ["C5: an opener attached through a dash", "Rated—“analyst of the year” award.", AWARD_SRC],
    ["C7: two in-word apostrophes", "I built models on Kaua'i and Moloka'i.", AWARD_SRC],
    ["C7: marks inside two numbers", "CHF 5'000 and 7'000", AWARD_SRC],
    ["C8: nested at an edge", "I won the “‘analyst of the year’” award.", AWARD_SRC],
    ["C8: an ellipsis at an edge", "I won the “…analyst of the year” award.", AWARD_SRC],
    ["C9: an invisible character", "I built\u200b models.", []],
    ["C9: an emoji", "I love 🚀 launches.", []],
    ["C9: letters outside the three scripts", "I worked in 北京 for years.", []],
    ["C9: symbols outside the allowlist", "Cost < 5 and > 2.", []],
    ["C10: a wordless envelope", "I built models “” for offshore projects.", []],
  ] as const)("%s fails closed (accepted cost)", (_name, text, sources) => {
    expect(unsourcedQuotationIn(text, sources)).not.toBeNull()
  })

  describe("R24 isQuoteLike additions", () => {
    it.each([
      ["U+1FFD", "´"], ["U+1FEF", "`"], ["U+0374", "ʹ"], ["˵", "˵"], ["˶", "˶"], ["՚", "՚"], ["ߵ", "ߵ"],
      ["ߴ", "ߴ"], ["᾽", "᾽"], ["᾿", "᾿"], ["΄", "΄"], ["ᐟ", "ᐟ"], ["ᐠ", "ᐠ"], ["ᑊ", "ᑊ"],
      ["<", "<"], [">", ">"], ["^", "^"], ["\\", "\\"], ["=", "="], ["@", "@"],
      ["U+200B", "\u200b"], ["U+00AD", "\u00ad"], ["U+0301", "\u0301"], ["U+202E", "\u202e"],
      ["U+FE0F", "\ufe0f"], ["U+1680", "\u1680"], ["U+2028", "\u2028"], ["U+E000", "\ue000"],
    ])("%s is quote-like", (_name, char) => {
      expect(isQuoteLike(char)).toBe(true)
    })

    it.each([
      ["$", "$"], ["£", "£"], ["€", "€"], ["#", "#"], ["+", "+"], ["…", "…"], ["·", "·"], ["•", "•"],
      ["°", "°"], ["×", "×"], ["±", "±"], ["a", "a"], ["Z", "Z"], ["é", "é"], ["0", "0"],
      ["٦", "٦"], ["６", "６"], ["NBSP", "\u00a0"], ["U+3000", "\u3000"],
    ])("%s is not quote-like", (_name, char) => {
      expect(isQuoteLike(char)).toBe(false)
    })
  })
})

/**
 * Revision 7, R25: a character's own category decides before NFKC, only spaced marks split tokens, and a
 * quotation has to close. The QA7 rows are pinned at function level, then the new adversarial variants V1 to
 * V14, V17 and V18, the must-pass rows P1 to P6 and P8 to P15, the costs C11 to C15, the residual
 * observations and the `charClassOf` additions. V15 and V16 were already refused by R24. Sources are the
 * stored quotes plus the WIND and AWARD facts, or the named fact.
 */
describe("EPIC-0012 Revision 7, R25: closed by category and balance", () => {
  const FAB = "double revenue within the decade"
  const AWARD = 'Won the "analyst of the year" award for the forecasting models'
  const WIND = "Built wind farm financial models for offshore projects, forecasting revenue and cost"
  const TEAMS = "Built the teams' shared forecasting models"
  const R25_SOURCES = [...QUOTES, AWARD, WIND]
  const AWARD_SRC = [AWARD]

  /** Lisu capitals (U+A4D0-A4FF, Script=Lisu) drawn exactly as Latin capitals. */
  const LISU: Record<string, string> = {
    A: "ꓮ", B: "ꓐ", C: "ꓚ", D: "ꓓ", E: "ꓰ", F: "ꓝ", G: "ꓖ", H: "ꓧ", I: "ꓲ", J: "ꓙ", K: "ꓗ", L: "ꓡ", M: "ꓟ",
    N: "ꓠ", O: "ꓳ", P: "ꓑ", R: "ꓣ", S: "ꓢ", T: "ꓔ", U: "ꓴ", V: "ꓦ", W: "ꓪ", X: "ꓫ", Y: "ꓬ", Z: "ꓜ",
  }
  const lisu = (text: string) => [...text.toUpperCase()].map((c) => LISU[c] ?? c).join("")
  const LISU_FAB = lisu(FAB)

  it.each([
    ["QA7-B1: a closed shell whose paragraph is the quotation", `“Built wind farm financial models for offshore projects. Your plan to ${FAB} is clear. Forecasting revenue and cost.”`, R25_SOURCES],
    ["QA7-B1: an unclosed opener in a fact-wording sentence", `Built wind farm financial models for offshore projects, “forecasting revenue and cost. Your plan to ${FAB} is clear.`, R25_SOURCES],
    ["QA7-B1 (G7 :176 row 1): three sentences in one quotation", `“Built wind farm financial models for offshore projects. Double revenue within the decade. Forecasting revenue and cost.”`, R25_SOURCES],
    ["QA7-B1 (G7 :176 row 2): fact wording, an unclosed opener, then the FAB sentence", `Built wind farm financial models for offshore projects, “forecasting revenue and cost. Double revenue within the decade.`, R25_SOURCES],
    ["QA7-B1 (G7 :176 row 3): an analysed fact wording in a shell", `“Analyst of the year. Double revenue within the decade. Analyst of the year.”`, R25_SOURCES],
    ["QA7-B1 (G7i :325): the spanning quote read as a letter paragraph", `“Built wind farm financial models for offshore projects. Your plan to ${FAB} is clear. Forecasting revenue and cost.”`, R25_SOURCES],
  ])("%s is refused", (_name, text, sources) => {
    expect(unsourcedQuotationIn(text, sources), text).not.toBeNull()
  })

  it.each([
    ["QA7-B2 (G7 :207 row 1): Lisu capitals after the fact wording", `Built wind farm financial models for offshore projects “${LISU_FAB}”.`, R25_SOURCES],
    ["QA7-B2 (G7 :207 row 2): CJK in guillemets", "Built wind farm financial models for offshore projects «收入十年翻番».", R25_SOURCES],
    ["QA7-B2 (G7 :207 row 3): Lisu inside a sourced shell", `I won the “analyst of the ${lisu("decade")} year” award.`, R25_SOURCES],
    ["QA7-B2 (G7 :207 row 4): Lisu words inside a sourced shell", `I won the “analyst ${lisu("double revenue")} of the year” award.`, R25_SOURCES],
    ["QA7-B2 (G7 :223): a Lisu-lettered quotation after the fact wording", `Built wind farm financial models for offshore projects “${LISU_FAB}”.`, R25_SOURCES],
    ["QA7-B2 (G7 :226): Lisu words inside a sourced quotation", `I won the “analyst ${lisu("double revenue")} of the year” award.`, R25_SOURCES],
    ["QA7-B2 (G7 :229): a resume bullet with Lisu", `Won the “analyst ${lisu("double")} of the year” award`, R25_SOURCES],
    ["QA7-B2 (G7 :229): an experience bullet with Lisu", `Built wind farm financial models for offshore projects “${LISU_FAB}”`, R25_SOURCES],
    ["QA7-B2 (G7i :329): the Lisu quotation in a letter", `Built wind farm financial models for offshore projects “${LISU_FAB}”.`, R25_SOURCES],
  ])("%s is refused", (_name, text, sources) => {
    expect(unsourcedQuotationIn(text, sources), text).not.toBeNull()
  })

  it.each([
    ["QA7-B3 (G7 :247, G7i :333): ˡ marks", `Your plan to ˡ${FAB}ˡ is clear.`],
    ["QA7-B3 (G7 :247): ᴵ marks", `Your plan to ᴵ${FAB}ᴵ is clear.`],
    ["QA7-B3 (G7 :247): ᶦ marks", `Your plan to ᶦ${FAB}ᶦ is clear.`],
    ["QA7-B3 (G7 :255): ˡ…ˡ", `Your plan to ˡ${FAB}ˡ is clear.`],
    ["QA7-B3 (G7 :255): ˡˡ…ˡˡ doubled", `Your plan to ˡˡ${FAB}ˡˡ is clear.`],
    ["QA7-B3 (G7 :255): ᶦ…ᶦ", `Your plan to ᶦ${FAB}ᶦ is clear.`],
  ])("%s is refused", (_name, text) => {
    expect(unsourcedQuotationIn(text, R25_SOURCES), text).not.toBeNull()
  })

  it.each([
    ["V1 an outer opener never closed", `I won the “analyst “of” the year and ${FAB}.`, R25_SOURCES],
    ["V2 two unclosed openers", `I won the “analyst “of “the” year ${FAB}.`, R25_SOURCES],
    ["V3 a glued inner mark", `I won the “analyst”of “the” year ${FAB}.`, R25_SOURCES],
    ["V4 a verbatim cut through AWARD's own marks", `"Analyst of. Your plan to ${FAB} is clear. The year" award for the forecasting models.`, AWARD_SRC],
    ["V5 nested marks across three sentences", `“Built “wind” farm financial models for offshore projects. Your plan to ${FAB} is clear. Forecasting “revenue” and cost.”`, R25_SOURCES],
    ["V6 a mirror: an unopened closer", `Your plan to ${FAB} “analyst” of the year” is clear.`, R25_SOURCES],
    ["V7 Swedish marks, odd count", `I won the ”analyst ”of” the year ${FAB}.`, R25_SOURCES],
    ["V8 guillemets, odd count", `I won the «analyst «of» the year ${FAB}.`, R25_SOURCES],
    ["V9 Lisu with no mark at all", `Built wind farm financial models for offshore projects ꓓꓳꓴꓐꓡꓰ ꓣꓰꓦꓰꓠꓴꓰ`, [WIND, AWARD]],
    ["V10 Cherokee inside a sourced quotation", `I won the “analyst ᏚᎪᏴᏞᎬ of the year” award.`, AWARD_SRC],
    ["V11 CJK inside a sourced quotation", `I won the “analyst of the 收入 year” award.`, AWARD_SRC],
    ["V12 ⁱ U+2071 added to the words", `Your plan to ⁱ${FAB}ⁱ is clear.`, R25_SOURCES],
    ["V13 ʳ U+02B3 and ᵢ U+1D62 added to the words", `Your plan to ʳ${FAB}ᵢ is clear.`, R25_SOURCES],
    ["V14 a lone opener added to the fact wording", `“Built wind farm financial models for offshore projects, forecasting revenue and cost`, R25_SOURCES],
    ["V17 a Lisu sentence between two sourced ones", `“Built wind farm financial models for offshore projects. ꓓꓳꓴꓐꓡꓰ. Forecasting revenue and cost.”`, R25_SOURCES],
    ["V18 straight marks, odd count", `I won the 'analyst 'of the year' ${FAB}.`, R25_SOURCES],
  ])("%s is refused", (_name, text, sources) => {
    expect(unsourcedQuotationIn(text, sources), text).not.toBeNull()
  })

  it.each([
    ["P1 two quotations in two sentences", `I won the “analyst of the year” award. I built “wind farm financial models” too.`, R25_SOURCES],
    ["P2 a nested sourced quotation", `I won the “the ‘analyst of the year’ award” twice.`, ["the ‘analyst of the year’ award"]],
    ["P3 the AWARD sentence verbatim, with its straight marks, inside a paragraph", `${AWARD}. I mentored 6 junior developers.`, [AWARD, "Mentored 6 junior developers"]],
    ["P4 a CJK fact sentence verbatim inside a paragraph", `Built carbon models for 北京 Energy. I mentored 6 junior developers.`, ["Built carbon models for 北京 Energy", "Mentored 6 junior developers"]],
    ["P5 a plural possessive inside a sourced quotation", `I built “the teams' shared forecasting models”.`, [TEAMS]],
    ["P6 a sourced quotation in straight marks", `Your plan to 'halve operational emissions by 2030' is clear.`, [QUOTES[0] ?? ""]],
    ["P8 Swedish marks, paired", `I won the ”analyst of the year” award.`, AWARD_SRC],
    ["P9 German marks", `I won the „analyst of the year“ award.`, AWARD_SRC],
    ["P10 ordinary brackets around a sourced quotation", `I won the (“analyst of the year”) award.`, AWARD_SRC],
    ["P11 the fallback wording with a straight mark, through U0", `Built 27" dashboards for traders`, [`Built 27" dashboards for traders`]],
    ["P12 subscript and superscript numbers", `Cut CO₂ by 30% across 4 m² sites.`, []],
    ["P13 a masculine ordinal marker", `Ranked 1º in the region.`, []],
    ["P14 an n-unit", `Rock 'n' roll fans.`, []],
    ["P15 a name mark and a straight quotation", `Together, O'Brien and I won the 'A' award.`, ["O'Brien and I won the 'A' award"]],
  ])("%s passes", (_name, text, sources) => {
    expect(unsourcedQuotationIn(text, sources), text).toBeNull()
  })

  // C11 is the accepted cost QA7-M1: the quotation check passes, and the number check and the judge are the
  // backstop. G7 :386 pins the judge's role end to end.
  it("C11 (QA7-M1, accepted): a sign glued to a fact's number inside a quotation passes", () => {
    const TWO = "Cut report preparation time by 30% using Jest. Trained the finance team"
    expect(unsourcedQuotationIn(`I “cut report preparation time by -30% using Jest” last year.`, [TWO])).toBeNull()
  })

  it("C12: a quotation spanning two sentences fails unless the unit is verbatim source text", () => {
    const TWO = "Cut report preparation time by 30% using Jest. Trained the finance team"
    expect(unsourcedQuotationIn(`“Cut report preparation time by 30% using Jest. Trained the finance team.”`, [TWO])).not.toBeNull()
  })

  it("C13 (narrowed by R26, QA8-B2): a fact's own wording with an unbalanced spaced mark passes alone through U0 and inside a paragraph, and a non-verbatim sentence with the same mark drops alone", () => {
    const TWENTY_SEVEN = `Built 27" dashboards for traders`
    expect(unsourcedQuotationIn(`${TWENTY_SEVEN}.`, [TWENTY_SEVEN])).toBeNull()
    // QA8-B2: U0 reads each sentence, so a fact's own sentence passes inside a paragraph. The one-paragraph letter
    // is ready end to end (G8 :221, G8i :342). A sentence that is not verbatim is not a source's own words: it is
    // still checked by narrowed S0 and B, so it drops while the paragraph's other sentences stay.
    expect(unsourcedQuotationIn(`${TWENTY_SEVEN}. ${WIND}.`, [TWENTY_SEVEN, WIND])).toBeNull()
    const NOT_VERBATIM = `Built 27" dashboards for traders and beyond`
    expect(unsourcedQuotationIn(`${NOT_VERBATIM}. ${WIND}.`, [TWENTY_SEVEN, WIND])).not.toBeNull()
  })

  it("C14: an in-word apostrophe inside a sourced quotation fails balance", () => {
    expect(unsourcedQuotationIn(`I “sailed Kaua'i daily” for years.`, R25_SOURCES)).not.toBeNull()
  })

  it("C15 (C9 widened): modifier letters are marks, so the sentence drops", () => {
    expect(unsourcedQuotationIn(`I won for the nᵗʰ time.`, [])).not.toBeNull()
  })

  it.each([
    ["(iii) a spaced closer before the envelope", `Your plan to ${FAB} ”analyst of the year” too.`, AWARD_SRC],
    ["(iii) a spaced closer before a WIND envelope", `Your plan to ${FAB} ”forecasting revenue and cost” too.`, [WIND]],
    ["(iii) an s-possessive before the envelope", `Your plan to ${FAB}s' “analyst of the year” too.`, AWARD_SRC],
    ["(iii′) a possessive-shaped closer read as closing", `I won the 'analyst of the years' ${FAB}.`, ["'analyst of the years'"]],
    ["(iv) a verbatim cut that leaves a quotation open across units", `Won the "analyst of the`, AWARD_SRC],
  ])("OBSERVATION (R25 residual %s) passes", (_name, text, sources) => {
    expect(unsourcedQuotationIn(text, sources), text).toBeNull()
  })

  it.each([
    ["ˡ", "mark"], ["ᶦ", "mark"], ["ᴵ", "mark"], ["ʰ", "mark"], ["ⁱ", "mark"], ["ᵃ", "mark"], ["ₐ", "mark"],
    ["¹", "word"], ["²", "word"], ["ª", "word"], ["º", "word"],
    ["™", "word"],
  ] as const)("R25 charClassOf: %s is %s", (char, expected) => {
    expect(charClassOf(char), `U+${char.codePointAt(0)!.toString(16)}`).toBe(expected)
  })
})

/**
 * EPIC-0012 Revision 8, R26 (QA8-B2): U0 reads each sentence. A sentence that IS one of a source's own
 * sentences passes inside a longer unit too, so a fact's own sentence can no longer fail narrowed S0's balance
 * and drop the paragraph it sits in (cost C13). Everything else is unchanged: a non-verbatim sentence with the
 * same mark is still checked and drops alone, and a run cut inside a source's own quotation is not a sentence.
 *
 * A fact's validation text carries its heading after the wording (documents.service `factsOf`), so the source
 * is `${fact}. Analyst, Acme, 2020–2023` and the fact's own sentence is its first sentence.
 */
describe("EPIC-0012 Revision 8, R26: U0 on one sentence (QA8-B2)", () => {
  const HEADING = "Analyst, Acme, 2020–2023"
  const source = (fact: string) => `${fact}. ${HEADING}`
  const MENT = "Mentored 6 junior developers"
  const MENT_SENTENCE = "I mentored 6 junior developers."
  const SECOND = "I built wind farm financial models for offshore projects."
  const TARGET: LetterTarget = { employer: "Verdant", roleTitle: "Sustainability Consultant" }

  /** One character per row, glued inside a fact's own words, so its sentence passes only through U0. */
  const ROWS = [
    ['" (inches)', 'Built 27" dashboards for traders', 'Built 27" dashboards for traders.'],
    ["< (less than)", "Reduced p99 latency to <200ms", "Reduced p99 latency to <200ms."],
    ["_ (underscore)", "Wrote the order_service in Go", "Wrote the order_service in Go."],
    ["→ (arrow)", "Migrated Python → Go services", "Migrated Python → Go services."],
    ["≥ (greater-or-equal)", "Cut AWS costs by ≥30%", "Cut AWS costs by ≥30%."],
    ["🚀 (emoji)", "Launched the 🚀 app", "Launched the 🚀 app."],
  ] as const
  /**
   * The e-mail row is checked at function level only. A letter may not carry a contact detail (SEC-401), so the
   * pipeline refuses it as `contact_detail` before any trimming: that is a separate, intended hard fail, not the
   * quotation check.
   */
  const EMAIL = ["an e-mail address", "Ran the ops@acme.com inbox", "Ran the ops@acme.com inbox."] as const

  const letter = (text: string, ...factIds: string[]): CoverLetterContent => ({
    kind: "cover_letter",
    greeting: "Dear Hiring Team,",
    opening: null,
    paragraphs: [{ text, factIds }],
    closingLine: null,
    closing: "Kind regards,",
  })

  it.each([...ROWS, EMAIL])("%s: the verbatim sentence passes in a two-sentence paragraph, and the other sentence stays", (_name, fact, sentence) => {
    expect(unsourcedQuotationIn(`${sentence} ${MENT_SENTENCE}`, [source(fact), source(MENT)])).toBeNull()
  })

  it.each([...ROWS, EMAIL])("%s: the verbatim sentence passes in a three-sentence paragraph, and the other sentences stay", (_name, fact, sentence) => {
    expect(unsourcedQuotationIn(`${sentence} ${SECOND} ${MENT_SENTENCE}`, [source(fact), source(MENT)])).toBeNull()
  })

  it.each(ROWS)("%s: a sentence that is not verbatim is still refused, and drops alone", (_name, fact, sentence) => {
    const notVerbatim = `${sentence.slice(0, -1)} and beyond.`
    // Not a source sentence: U0 does not pass it, narrowed S0 and B still read its mark, so it drops.
    expect(unsourcedQuotationIn(`${notVerbatim} ${MENT_SENTENCE}`, [source(fact), source(MENT)])).not.toBeNull()
    const paragraphs = letter(`${notVerbatim} ${MENT_SENTENCE}`, "DASH", "MENT")
    const facts = new Map([
      ["DASH", source(fact)],
      ["MENT", source(MENT)],
    ])
    const trimmed = dropUnsupportedSentences(paragraphs, facts, TARGET, null, new Set(), null, null)
    // Only that sentence goes: the paragraph survives with the sentence that passes on its own.
    expect(trimmed.dropped).toBe(1)
    expect(trimmed.letter.paragraphs.map((paragraph) => paragraph.text)).toEqual([MENT_SENTENCE])
  })

  it.each(ROWS)("%s: the one-paragraph letter of two fact sentences stays ready end to end", (_name, fact, sentence) => {
    const text = `${sentence} ${MENT_SENTENCE}`
    const facts = new Map([
      ["DASH", source(fact)],
      ["MENT", source(MENT)],
    ])
    const wording: FactWording = new Map([
      ["DASH", fact],
      ["MENT", MENT],
    ])
    const trimmed = dropUnsupportedSentences(letter(text, "DASH", "MENT"), facts, TARGET, null, new Set(), null, wording)
    expect(trimmed.dropped).toBe(0)
    expect(trimmed.letter.paragraphs.map((paragraph) => paragraph.text)).toEqual([text])
    expect(validateDocument(trimmed.letter, facts, TARGET, null, new Set(), null, wording).ok).toBe(true)
  })

  it("OBSERVATION: the e-mail sentence is refused in a letter as a contact detail, not as an unsourced quotation", () => {
    const text = `${EMAIL[2]} ${MENT_SENTENCE}`
    const facts = new Map([
      ["DASH", source(EMAIL[1])],
      ["MENT", source(MENT)],
    ])
    // The quotation check passes the sentence (U0), so only SEC-401 stops the letter.
    expect(unsourcedQuotationIn(text, [facts.get("DASH")!, facts.get("MENT")!])).toBeNull()
    expect(validateDocument(letter(text, "DASH", "MENT"), facts, TARGET, null, new Set(), null, null)).toMatchObject({ reason: "contact_detail" })
  })

  it("a run cut inside a source's own quotation is not one of its sentences, so it is still checked", () => {
    const DELIVERED = 'Delivered the "north star" migration in 2024'
    const cut = 'Delivered the "north. Your plan is clear.'
    // The first sentence is a prefix run of the source's tokens, but the source has no sentence end there.
    expect(unsourcedQuotationIn(cut, [source(DELIVERED)])).not.toBeNull()
    expect(unsourcedQuotationIn(DELIVERED, [source(DELIVERED)])).toBeNull()
  })

  // R26 residual (v), closed in R27: a source whose own quotation spans a sentence end is split inside that
  // quotation, so two of its sentences read unbalanced. Such a source gets no per-sentence pass, so an invented
  // sentence cannot sit between or after the halves of its quotation.
  it.each([
    ['Q5 an invented sentence inside a source quotation cut at a sentence end', `Praised by the CFO: "Fast. Your plan to double revenue within the decade is clear. Reliable."`, `Praised by the CFO: "Fast. Accurate. Reliable."`],
    ['Q4 a source quotation left open over an invented sentence', `Praised by the CFO: "Fast. Your plan to double revenue within the decade is clear.`, `Praised by the CFO: "Fast. Accurate. Reliable."`],
    ['Q17 an abbreviation-led source quotation left open over an invented sentence', `Thanked by Dr. Lee for the "Q3. Your plan to double revenue within the decade is clear.`, `Thanked by Dr. Lee for the "Q3. Close" playbook`],
  ])("residual (v) %s is refused", (_name, text, fact) => {
    expect(unsourcedQuotationIn(text, [source(fact)])).not.toBeNull()
  })
})

// Review fix (post-R26): `forward_statements` is jsonb, so a row can hold a value the extraction never writes.
// Only a stored list of up to three quotes of at most 200 characters lends a letter anything.
describe("EPIC-0012 rule 4: the stored forward statements", () => {
  it("keeps a list the extraction could have written", () => {
    const quotes = ["Our aim is to halve operational emissions by 2030", "We will cut water use by 40% across the group"]
    expect(storedDirectionQuotes(quotes)).toEqual(quotes)
    expect(storedDirectionQuotes(["x".repeat(200)])).toEqual(["x".repeat(200)])
  })

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an object", { quote: "We will cut water use by 40% across the group" }],
    ["a bare string", "We will cut water use by 40% across the group"],
    ["numbers", [1, 2, 3]],
    ["a null inside the list", ["We will cut water use by 40%", null]],
    ["a quote past 200 characters", ["y".repeat(201)]],
    ["four quotes", ["a", "b", "c", "d"]],
  ])("%s lends nothing", (_name, value) => {
    expect(storedDirectionQuotes(value)).toEqual([])
  })
})
