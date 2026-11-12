/**
 * EPIC-0012 QA gate 7 (after owner-approved repair wave 6: R24, default-deny quotation provenance).
 * Adversarial unit tests by an independent QA session. Test files only; no product code changed. Report:
 * epics/active/EPIC-0012-tailoring-rules/test-plan.r7.md.
 *
 * Convention, as in the gate-1 to 6 specs: `it` asserts behaviour the candidate shows and the design requires.
 * `it.fails` asserts REQUIRED behaviour the candidate does not show: each one is a blocker QA7-Bn in the report, and
 * it turns red when the defect is fixed (then it becomes `it`). "OBSERVATION" tests pin a class the design accepts
 * (C1-C10, residuals i-iii), leaves to the judge, or that the report raises as a minor; they pass today.
 *
 * The judge is a plain function (rubber stamp = `() => true`), not a model. `finish` is the gate-4 helper, copied
 * unchanged through gates 5 and 6: it replays documents.service.ts generate() in the service's order. Fresh inputs
 * only: no row repeats a gate-6 input or a Revision 6 row (QA6 rows, W1-W18, the R24 must-pass rows, C5-C10 pins).
 */
import { describe, expect, it } from "vitest"

import type { AtsKeyword } from "../ats/ats-score.js"
import {
  type PostingGuard,
  dropOrphanDirection,
  dropUnsupportedSentences,
  fallBackToFactWording,
  hardFailCounts,
  letterBlocksOnlyOnUnjudged,
  needsMeaningCheck,
  postingGuard,
  settleCappedLetter,
  validateDocument,
} from "./document-claims.js"
import type { CoverLetterContent, DocumentLine, ResumeContent } from "./document-model.js"
import { charClassOf, completionWordIn, isQuoteLike, unsourcedQuotationIn } from "./company-direction.js"
import { headlineFor } from "./headline.js"
import { keywordDensity, repairDenseLines, resumeLineRefs } from "./keyword-density.js"
import { capLetterKeywords } from "./letter-keyword-cap.js"
import { meaningKey } from "./line-text.js"

const withHeading = (fact: string, organization = "Acme") => `${fact}. Analyst, ${organization}, 2020–2023`
const HEADING = "Analyst, Acme, 2020–2023"

const WORDING = new Map([
  ["PAY", "Supported the payments migration"],
  ["WIND", "Built wind farm financial models for offshore projects, forecasting revenue and cost"],
  ["MENT", "Mentored 6 junior developers"],
  ["QA", "Tested React forms with Jest and ran regression suites"],
  ["J1", "Wrote Jest tests for the checkout"],
  ["J2", "Wrote Jest tests for the cart"],
  ["J3", "Wrote Jest tests for search"],
  ["TWO", "Cut report preparation time by 30% using Jest. Trained the finance team"],
  ["AWARD", "Won the \"analyst of the year\" award for the forecasting models"],
  ["ZUR", "Built risk models for Zürich Energy and Société Générale"],
  ["CJK", "Built carbon models for 北京 Energy"],
  ["SK", "React, TypeScript, Jest"],
])
const FACTS = new Map([...WORDING].map(([id, text]) => [id, withHeading(text)] as const))
const POSTING =
  "Sustainability consulting firm. We use Workiva daily.\nTableau experience is a plus.\nTools: Snowflake, Power BI and Excel. ESG reporting matters. Carbon accounting matters. We want to double revenue within the decade."
const QUOTES = ["Our aim is to halve operational emissions by 2030", "We will cut water use by 40% across the group"]
const TARGET = { employer: "Verdant", roleTitle: "Sustainability Consultant" }
const guard = (direction: readonly string[] = QUOTES, bridges = true): PostingGuard => postingGuard(POSTING, "Sustainability Consultant", ["carbon accounting"], bridges, direction)
const kw = (name: string): AtsKeyword => ({ keyword: name, kind: "technology", group: `one:${name.toLowerCase()}` })

const line = (text: string, ...factIds: string[]): DocumentLine => ({ text, factIds })
const resumeOf = (summary: DocumentLine[], bullets: DocumentLine[] = [], skills: DocumentLine[] = []): ResumeContent => ({
  kind: "resume",
  summary,
  experience: bullets.length === 0 ? [] : [{ heading: line(HEADING, "WIND"), bullets }],
  skills,
  education: [],
})
const letterOf = (...paragraphs: DocumentLine[]): CoverLetterContent => ({
  kind: "cover_letter",
  greeting: "Dear Hiring Team,",
  opening: null,
  paragraphs,
  closingLine: null,
  closing: "Kind regards,",
})
const MENT_P = line("I mentored 6 junior developers.", "MENT")
const emptyLetter = letterOf(MENT_P)
const emptyResume = resumeOf([line("Mentored 6 junior developers", "MENT")])

type Judge = (text: string, factIds: readonly string[]) => boolean
const RUBBER_STAMP: Judge = () => true
const REFUSE_ALL: Judge = () => false

type Options = Readonly<{ posting?: PostingGuard; keywords?: readonly AtsKeyword[]; judge?: Judge; judgeFails?: boolean }>

/** The service's post-model pipeline, in the service's order (documents.service.ts generate()). */
function finish(draftResume: ResumeContent, draftLetter: CoverLetterContent, options: Options = {}) {
  const posting = options.posting ?? guard()
  const keywords = options.keywords ?? []
  const judge = options.judge ?? RUBBER_STAMP
  const items: DocumentLine[] = []
  const kinds = [
    ...draftResume.summary.map((l) => ({ l, kind: "summary" as const })),
    ...draftResume.experience.flatMap((e) => e.bullets.map((l) => ({ l, kind: "experience_bullet" as const }))),
    ...draftResume.skills.map((l) => ({ l, kind: "skills" as const })),
    ...draftLetter.paragraphs.map((l) => ({ l, kind: "letter_paragraph" as const })),
  ]
  for (const { l, kind } of kinds) {
    if (needsMeaningCheck(l, FACTS, kind === "letter_paragraph" ? TARGET : null, null, kind, posting, WORDING)) items.push(l)
  }
  const failed = options.judgeFails === true && items.length > 0
  const meaningChecked = new Set<string>()
  if (!failed) for (const l of items) if (judge(l.text, l.factIds)) meaningChecked.add(meaningKey(l.text, l.factIds))
  const tailoredResume = fallBackToFactWording(draftResume, FACTS, WORDING, null, meaningChecked, posting)
  const tailoredLetter = dropUnsupportedSentences(draftLetter, FACTS, TARGET, null, meaningChecked, posting, WORDING)
  const orphaned = dropOrphanDirection(tailoredLetter.letter, posting)
  const cap = capLetterKeywords(orphaned.letter, keywords)
  const settled = settleCappedLetter(cap, FACTS, TARGET, null, meaningChecked, posting, WORDING)
  const finalChecked = settled.checked
  const density = keywordDensity(resumeLineRefs(tailoredResume.resume), keywords)
  const finalResume = density.lineIds.length > 0 ? repairDenseLines(tailoredResume.resume, density.lineIds, WORDING).resume : tailoredResume.resume
  const resumeValidation = validateDocument(finalResume, FACTS, null, null, finalChecked, posting, WORDING)
  const letterValidation = validateDocument(settled.letter, FACTS, TARGET, null, finalChecked, posting, WORDING)
  const providerError = !letterValidation.ok && failed && letterBlocksOnlyOnUnjudged(settled.letter, FACTS, TARGET, null, finalChecked, posting, WORDING)
  return {
    resume: finalResume,
    letter: settled.letter,
    sent: items.map((l) => l.text),
    resumeValid: resumeValidation.ok,
    letterValid: letterValidation.ok,
    providerError,
    cap,
    settled,
    hardFails: hardFailCounts(draftResume, draftLetter, FACTS, TARGET, null, posting, WORDING),
  }
}
type Outcome = ReturnType<typeof finish>

const resumeTexts = (outcome: Outcome) => [...outcome.resume.summary, ...outcome.resume.experience.flatMap((e) => e.bullets), ...outcome.resume.skills].map((l) => l.text)
const letterTexts = (outcome: Outcome) => outcome.letter.paragraphs.map((p) => p.text)
const norm = (text: string) => text.trim().replace(/\.$/, "").toLowerCase()
const allText = (outcome: Outcome) => [...resumeTexts(outcome), ...letterTexts(outcome)].join(" | ")

const STATES = [
  ["both flags off", { bridges: false, direction: false }],
  ["bridges only", { bridges: true, direction: false }],
  ["direction only", { bridges: false, direction: true }],
  ["both flags on", { bridges: true, direction: true }],
] as const
const guardFor = (flags: { bridges: boolean; direction: boolean }) => guard(flags.direction ? QUOTES : [], flags.bridges)

const WIND_SENTENCE = "I built wind farm financial models for offshore projects, forecasting revenue and cost."
const REACT = [kw("React")]
const FAB = "double revenue within the decade"
const AWARD_SRC = [FACTS.get("AWARD")!]
const ALL_SRC = [...QUOTES, FACTS.get("AWARD")!, FACTS.get("WIND")!]

/** Lisu capital letters (U+A4D0-A4FF, Script=Lisu, Lo) that are drawn exactly as Latin capitals. */
const LISU: Record<string, string> = {
  A: "ꓮ", B: "ꓐ", C: "ꓚ", D: "ꓓ", E: "ꓰ", F: "ꓝ", G: "ꓖ", H: "ꓧ", I: "ꓲ", J: "ꓙ", K: "ꓗ", L: "ꓡ", M: "ꓟ",
  N: "ꓠ", O: "ꓳ", P: "ꓑ", R: "ꓣ", S: "ꓢ", T: "ꓔ", U: "ꓴ", V: "ꓦ", W: "ꓪ", X: "ꓫ", Y: "ꓬ", Z: "ꓜ",
}
const lisu = (text: string) => [...text.toUpperCase()].map((c) => LISU[c] ?? c).join("")
const LISU_FAB = lisu(FAB) // renders "DOUBLE REVENUE WITHIN THE DECADE"

/** A letter whose first paragraph is `frame` alone (no trailing sentence), citing WIND and AWARD. */
const letterAlone = (frame: string, posting: PostingGuard, judge: Judge = RUBBER_STAMP) =>
  finish(emptyResume, letterOf(line(frame, "WIND", "AWARD"), MENT_P), { posting, judge })
/** A letter paragraph `frame` followed by the WIND sentence, citing WIND and AWARD (the gate-6 helper). */
const letterWith = (frame: string, posting: PostingGuard, judge: Judge = RUBBER_STAMP) =>
  finish(emptyResume, letterOf(line(`${frame} ${WIND_SENTENCE}`, "WIND", "AWARD"), MENT_P), { posting, judge })
const storedLower = (outcome: Outcome) => allText(outcome).toLowerCase()
const quotedStored = (frame: string, posting: PostingGuard) => storedLower(letterWith(frame, posting)).includes("revenue within")

// ---------------------------------------------------------------------------------------------------------
// 1. R24 holes: text the employer never wrote, stored inside quotation marks, both flags off, rubber stamp.
// ---------------------------------------------------------------------------------------------------------
describe("1. R24: fabricated quotations that still reach storage", () => {
  // QA7-B1. Closed by R25 step 3. S0 now also requires balanced spaced marks, so a sentence that is fact wording
  // but carries only one end of a quotation no longer skips the check, and B reads every active mark at the end of
  // every sentence: an opener that never closes leaves the depth above 0. sentencesOf still splits at ". X", so the
  // sentences are read one at a time, but the unclosed opener is now caught in the sentence that holds it.
  it("QA7-B1 fixed by R25 B and narrowed S0: a quotation spanning sentences, opened and closed in fact-wording sentences, is refused", () => {
    const rows = [
      `“Built wind farm financial models for offshore projects. Double revenue within the decade. Forecasting revenue and cost.”`,
      `Built wind farm financial models for offshore projects, “forecasting revenue and cost. Double revenue within the decade.`,
      `“Analyst of the year. Double revenue within the decade. Analyst of the year.”`,
    ]
    for (const text of rows) expect(unsourcedQuotationIn(text, ALL_SRC), text).not.toBeNull()
  })
  it("QA7-B1 OBSERVATION: a bare fabricated middle sentence ('Double revenue within the decade.') is caught downstream as claim_word, so end to end it needs a 'Your plan' frame", () => {
    const outcome = letterAlone(`“Built wind farm financial models for offshore projects. Double revenue within the decade. Forecasting revenue and cost.”`, guard([], false))
    expect(storedLower(outcome)).not.toContain("revenue within")
  })
  it("QA7-B1 control: the same text with the fabricated sentence inside one sentence is refused (S3)", () => {
    expect(unsourcedQuotationIn(`“Built wind farm financial models for offshore projects; double revenue within the decade; forecasting revenue and cost.”`, ALL_SRC)).not.toBeNull()
  })
  describe.each(STATES)("%s", (_state, flags) => {
    const posting = guardFor(flags)
    it.each([
      ["closed shell, paragraph is the quotation", `“Built wind farm financial models for offshore projects. Your plan to ${FAB} is clear. Forecasting revenue and cost.”`, letterAlone],
      ["unclosed opener in a fact-wording sentence", `Built wind farm financial models for offshore projects, “forecasting revenue and cost. Your plan to ${FAB} is clear.`, letterWith],
    ] as const)("QA7-B1 fixed by R25 B and narrowed S0: %s is never stored", (_name, frame, build) => {
      expect(storedLower(build(frame, posting))).not.toContain("revenue within")
    })
  })

  // QA7-B2. Closed by R25 step 2: only spaced marks split tokens, so mark-class letters stay in the token
  // and are compared; text written in Lisu, CJK or Cherokee is no longer invisible to S0 and S3.
  it("QA7-B2 fixed by R25 step 2: a quoted run of mark-class letters is never sourced by its absence", () => {
    const rows = [
      `Built wind farm financial models for offshore projects “${LISU_FAB}”.`,
      `Built wind farm financial models for offshore projects «收入十年翻番».`,
      `I won the “analyst of the ${lisu("decade")} year” award.`,
      `I won the “analyst ${lisu("double revenue")} of the year” award.`,
    ]
    for (const text of rows) expect(unsourcedQuotationIn(text, ALL_SRC), text).not.toBeNull()
  })
  it("QA7-B2 control: the same words in Latin letters are refused", () => {
    for (const text of [`Built wind farm financial models for offshore projects “${FAB.toUpperCase()}”.`, `I won the “analyst of the DECADE year” award.`]) {
      expect(unsourcedQuotationIn(text, ALL_SRC), text).not.toBeNull()
    }
  })
  describe.each(STATES)("%s", (_state, flags) => {
    const posting = guardFor(flags)
    it("QA7-B2 fixed by R25 step 2: a Lisu-lettered fabricated quotation after the fact wording is never stored in a letter", () => {
      expect(allText(letterAlone(`Built wind farm financial models for offshore projects “${LISU_FAB}”.`, posting))).not.toContain(LISU_FAB)
    })
    it("QA7-B2 fixed by R25 step 2: Lisu words inside a sourced quotation are never stored", () => {
      expect(allText(letterWith(`I won the “analyst ${lisu("double revenue")} of the year” award.`, posting))).not.toContain(lisu("double revenue"))
    })
    it("QA7-B2 fixed by R25 step 2: in a resume bullet and a summary line, too", () => {
      const outcome = finish(
        resumeOf([line(`Won the “analyst ${lisu("double")} of the year” award`, "AWARD")], [line(`Built wind farm financial models for offshore projects “${LISU_FAB}”`, "WIND")]),
        emptyLetter,
        { posting }
      )
      expect(allText(outcome)).not.toMatch(/[ꓐ-꓿]/u)
    })
  })

  // QA7-B3. Closed by R25 step 1: `charClassOf` reads the character's own category before its NFKC form, so
  // ᴵ U+1D35, ˡ U+02E1 and ᶦ U+1DA6 are marks (Lm) even though their NFKC forms are Latin letters.
  it("QA7-B3 fixed by R25 step 1: modifier letters are marks", () => {
    for (const char of ["ᴵ", "ˡ", "ᶦ"]) expect(charClassOf(char), `U+${char.codePointAt(0)!.toString(16)}`).toBe("mark")
  })
  it("QA7-B3 fixed by R25 step 1: a quotation drawn with modifier letters is refused", () => {
    for (const mark of ["ᴵ", "ˡ", "ᶦ"]) expect(unsourcedQuotationIn(`Your plan to ${mark}${FAB}${mark} is clear.`, ALL_SRC), mark).not.toBeNull()
  })
  it("QA7-B3 OBSERVATION: with ᴵ (NFKC capital I) glued to the words, the claim check refuses 'Idouble' as a capitalised word, so only lower-case forms reach storage", () => {
    expect(quotedStored(`Your plan to ᴵ${FAB}ᴵ is clear.`, guard([], false))).toBe(false)
  })
  describe.each(STATES)("%s", (_state, flags) => {
    const posting = guardFor(flags)
    it.each([
      ["ˡ…ˡ U+02E1 modifier small l", `Your plan to ˡ${FAB}ˡ is clear.`],
      ["ˡˡ…ˡˡ doubled", `Your plan to ˡˡ${FAB}ˡˡ is clear.`],
      ["ᶦ…ᶦ U+1DA6 modifier small capital I", `Your plan to ᶦ${FAB}ᶦ is clear.`],
    ])("QA7-B3 fixed by R25 step 1: %s (drawn as tick marks) is never stored", (_name, frame) => {
      expect(quotedStored(frame, posting)).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------------------------------------
// 2. QA6-B1, B2, B3 closed against fresh inputs; normalisation, invisible characters, edges and sentence shapes.
// ---------------------------------------------------------------------------------------------------------
const INVISIBLES: readonly (readonly [string, string])[] = [
  ["ZWSP", "\u200b"], ["ZWNJ", "\u200c"], ["ZWJ", "\u200d"], ["WJ", "\u2060"], ["BOM", "\ufeff"], ["SHY", "\u00ad"],
  ["CGJ", "\u034f"], ["VS16", "\ufe0f"], ["VS1", "\ufe00"], ["LRM", "\u200e"], ["RLM", "\u200f"], ["ALM", "\u061c"],
  ["LRE", "\u202a"], ["RLO", "\u202e"], ["PDF", "\u202c"], ["LRI", "\u2066"], ["FSI", "\u2068"], ["PDI", "\u2069"],
  ["MVS", "\u180e"], ["TAG-quote", "\u{e0022}"], ["TAG-cancel", "\u{e007f}"], ["combining grave", "\u0300"],
  ["combining comma above", "\u0313"], ["Hangul filler", "\u3164"], ["invisible times", "\u2062"], ["VT", "\u000b"],
  ["FF", "\u000c"], ["NEL", "\u0085"], ["PS", "\u2029"], ["Braille blank", "\u2800"],
]
/**
 * Attack templates where every slot `¦` is a gap; one invisible character goes into one gap at a time. Without
 * any invisible character, each template is refused today (checked in the control row).
 */
const TEMPLATES = [
  `Your plan to¦ ¦“¦${FAB}¦”¦ is clear.`,
  `Your plan¦'¦${FAB}¦'¦is clear.`,
  `Your plan to ${FAB}¦.¦”¦“¦analyst of the year¦”¦ too.`,
  `I won the “analyst of the year” award¦:¦“¦${FAB}.`,
  `I won the “analyst of the year¦”¦ ¦${FAB}¦”¦ award.`,
  `Your plan¦’¦${FAB}¦’¦is clear.`,
]
const fill = (template: string, slot: number, char: string) => {
  let n = -1
  return template.replace(/¦/g, () => ((n += 1) === slot ? char : ""))
}

describe("2. QA6-B1, B2, B3 hold against fresh inputs", () => {
  it("control: every template is refused without an invisible character", () => {
    for (const template of TEMPLATES) expect(unsourcedQuotationIn(template.replace(/¦/g, ""), ALL_SRC), template).not.toBeNull()
  })
  it.each(INVISIBLES)("%s in every gap of every template is refused", (_name, char) => {
    for (const template of TEMPLATES) {
      const slots = template.split("¦").length - 1
      for (let slot = 0; slot < slots; slot += 1) {
        const text = fill(template, slot, char)
        expect(unsourcedQuotationIn(text, ALL_SRC), JSON.stringify(text)).not.toBeNull()
      }
    }
  })
  it.each(INVISIBLES)("%s inside a fabricated word in a sourced shell is refused", (_name, char) => {
    expect(unsourcedQuotationIn(`I won the “analyst of the year dou${char}ble revenue” award.`, ALL_SRC)).not.toBeNull()
  })

  describe.each(STATES)("%s", (_state, flags) => {
    const posting = guardFor(flags)
    it.each([
      // normalisation
      ["NFD of the whole sentence", `Your plan to “${FAB}” is clear.`.normalize("NFD")],
      ["NFKD of fullwidth quotes", `Your plan to ＂${FAB}＂ is clear.`.normalize("NFKD")],
      ["fullwidth straight double quotes", `Your plan to ＂${FAB}＂ is clear.`],
      ["fullwidth letters inside a sourced shell", `I won the “analyst of the year ｄｏｕｂｌｅ revenue” award.`],
      ["ligatures in the fabricated words", `Your plan to “double revenue within the decade, ﬁrst and ﬂat” is clear.`],
      ["mathematical bold fabricated words", `Your plan to “𝐝𝐨𝐮𝐛𝐥𝐞 𝐫𝐞𝐯𝐞𝐧𝐮𝐞” is clear.`],
      ["circled letters", `Your plan to “ⓓⓞⓤⓑⓛⓔ revenue” is clear.`],
      ["superscript-digit footnote glued", `Your plan to “${FAB}”¹ is clear.`],
      ["Greek oxia as a closer, Latin acute as opener", `Your plan to ´${FAB}´ is clear.`],
      ["NFD-decomposable mark ǅ inside", `Your plan to “ǅ ${FAB}” is clear.`],
      // homoglyphs inside the fabricated words or the marks
      ["Cyrillic а and е inside a sourced quote's words", `I won the “аnalyst of thе year” award, and ${FAB}.`],
      ["Greek ο in the fabricated words", `Your plan to “dοuble revenue” is clear.`],
      ["Armenian ՚ as both marks", `Your plan to ՚${FAB}՚ is clear.`],
      ["Hebrew geresh ׳ and gershayim ״", `Your plan to ״${FAB}״ is clear.`],
      ["Arabic-Indic digits in the quote", `Your plan to “${FAB} by ٢٠٣٠” is clear.`],
      ["Devanagari digits in the quote", `Your plan to “${FAB} by २०३०” is clear.`],
      // characters at the allowlist edge
      ["ASCII ,, then ''", `Your plan to ,,${FAB}'' is clear.`],
      ["ASCII << >>", `Your plan to <<${FAB}>> is clear.`],
      ["ASCII backticks", `Your plan to \`\`${FAB}'' is clear.`],
      ["ASCII = and ^", `Your plan to =${FAB}^ is clear.`],
      ["underscore emphasis", `Your plan to _${FAB}_ is clear.`],
      // envelope edges, L1 to L4
      ["L1: opener glued to a closing bracket", `I won the “analyst of the year” award)“${FAB}”.`],
      ["L1: closer glued through %", `Your plan to grow 40%”“analyst of the year” is clear.`],
      ["L1: closer glued through a currency sign", `Your plan to ${FAB} $”“analyst of the year” is clear.`],
      ["L2: envelope starts with a bracket", `Your plan to “(${FAB})” is clear.`],
      ["L3: envelope ends with a colon", `Your plan to “${FAB}:” is clear.`],
      ["L4: closer then a slash and a word", `I won the “analyst of the year”/${FAB}.`],
      ["L4: closer then a hash and a word", `I won the “analyst of the year”#${FAB}.`],
      ["L4: closer then an ellipsis and a word", `I won the “analyst of the year”…${FAB}.`],
      // nested, doubled, glued
      ["a fabricated shell around a sourced quote", `Your plan to “${FAB} “analyst of the year”” is clear.`],
      ["a sourced quote inside guillemets inside a fabricated quote", `Your plan to «${FAB} “analyst of the year” too» is clear.`],
      ["triple glued closers", `Your plan to “‘«${FAB}»’” is clear.`],
      ["a real quote, then fabricated words inside the same marks", `I won the “analyst of the year, ${FAB}” award.`],
      ["a real quote, a comma, then a fabricated quote", `I won the “analyst of the year”, “${FAB}”.`],
      ["a real quote then a fabricated one with no space", `I won the “analyst of the year”“${FAB}”.`],
      ["the fact's straight marks reused around fabricated words", `Won the "analyst of the year" award for the "${FAB}" models`],
      // sentences
      ["a fabricated quote after an abbreviation that splits", `I joined Acme Inc. In 2021, “${FAB}” was the goal.`],
      ["a quotation ending in ?! with the next sentence fabricated", `Did I win the “analyst of the year?!” “${FAB}.”`],
      ["two sentences, the closer glued to the next one", `I won the “analyst of the year.”Your plan to “${FAB}” is clear.`],
    ])("%s: never stored, even rubber-stamped", (_name, frame) => {
      expect(quotedStored(frame, posting)).toBe(false)
    })
  })

  it("a fabricated quote in summary, bullet and skills lines is never stored; the bullet falls back to the fact wording", () => {
    for (const flags of STATES.map(([, f]) => f)) {
      const outcome = finish(
        resumeOf([line(`Built wind farm financial models\u200b“${FAB}”`, "WIND")], [line(`Won the "analyst of the year" award for the forecasting models ‹${FAB}›`, "AWARD")], [line(`React, ＂${FAB}＂`, "SK")]),
        emptyLetter,
        { posting: guardFor(flags) }
      )
      expect(allText(outcome)).not.toContain("revenue within")
      expect(resumeTexts(outcome)).toContain(WORDING.get("AWARD"))
      expect(outcome.resumeValid).toBe(true)
    }
  })

  it("OBSERVATION (residual iii, stated design limit): an outer mark attached inward and spaced from FAB passes", () => {
    for (const text of [`Your aim to ${FAB} ”forecasting revenue and cost” too.`]) {
      expect(unsourcedQuotationIn(text, ALL_SRC), text).toBeNull()
    }
  })
  it("R25 B: an unclosed outer opener is refused", () => {
    expect(unsourcedQuotationIn(`I built “wind farm financial models for” offshore projects“ ${FAB}.`, ALL_SRC)).not.toBeNull()
  })
  it("OBSERVATION (residual ii and design 2.3 judge class): allowlisted ASCII wrappers are not quotations", () => {
    for (const wrap of [["/", "/"], ["--", "--"], ["(", ")"], ["[", "]"], ["·", "·"], ["°", "°"], ["#", "#"], [",,", ",,"], ["+", "+"]] as const) {
      expect(unsourcedQuotationIn(`Your plan to ${wrap[0]}${FAB}${wrap[1]} is clear.`, ALL_SRC), wrap.join("…")).toBeNull()
    }
  })
  it.each([["~30%"], ["-30%"], ["+30%"], ["±30%"], ["$30%"], ["30%+"]])(
    "MINOR QA7-M1 (judge class): a sign glued to a cited fact's number inside a quotation (%s) passes R24 and the number check; only the judge stops it",
    (number) => {
      const frame = `I “cut report preparation time by ${number} using Jest” last year.`
      expect(unsourcedQuotationIn(frame, [FACTS.get("TWO")!])).toBeNull()
      for (const flags of STATES.map(([, f]) => f)) {
        expect(letterTexts(finish(emptyResume, letterOf(line(frame, "TWO"), MENT_P), { posting: guardFor(flags) })).join(" ")).toContain(number)
        expect(letterTexts(finish(emptyResume, letterOf(line(frame, "TWO"), MENT_P), { posting: guardFor(flags), judge: REFUSE_ALL })).join(" ")).not.toContain(number)
      }
    }
  )
  it("counted as `unsourced_quote`, with no text", () => {
    const outcome = letterWith(`Your plan to “\u2066${FAB}\u2069” is clear.`, guard([], false))
    expect(outcome.hardFails.unsourced_quote).toBeGreaterThan(0)
    expect(JSON.stringify(outcome.hardFails)).not.toMatch(/revenue|decade|“|\u2066/)
  })
})

// ---------------------------------------------------------------------------------------------------------
// 3. Normalisation classifies, it never rewrites.
// ---------------------------------------------------------------------------------------------------------
describe("3. stored text is never rewritten by normalisation", () => {
  it.each([
    ["NFD accents", `I built “risk models for Zürich Energy and Société Générale” last year.`.normalize("NFD")],
    ["NFC accents", `I built “risk models for Zürich Energy and Société Générale” last year.`.normalize("NFC")],
    ["fullwidth letters in the quotation", "I built “ｒｉｓｋ models for Zürich Energy” and Société Générale."],
  ])("%s: a passing letter sentence is stored code point for code point", (_name, text) => {
    expect(unsourcedQuotationIn(text, [FACTS.get("ZUR")!])).toBeNull()
    const outcome = finish(emptyResume, letterOf(line(text, "ZUR"), MENT_P), { posting: guard([], false) })
    expect(letterTexts(outcome)[0]).toBe(text)
  })
  it("a bullet that is the fact's wording in NFD is stored as written, not composed", () => {
    const nfd = WORDING.get("ZUR")!.normalize("NFD")
    const outcome = finish(resumeOf([], [line(nfd, "ZUR")]), emptyLetter, { posting: guard([], false), judge: REFUSE_ALL })
    const stored = resumeTexts(outcome)
    expect(stored).toHaveLength(1)
    // Either the line as written or the fact wording; never a normalised copy of the line.
    expect([nfd, WORDING.get("ZUR")]).toContain(stored[0])
  })
})

// ---------------------------------------------------------------------------------------------------------
// 4. False positives: legitimate text passes (fresh), C1-C10 behave as accepted, new cases observed.
// ---------------------------------------------------------------------------------------------------------
describe("4. legitimate text", () => {
  it.each([
    ["I couldn’t’ve done it alone."], ["Y’all’s support mattered."], ["We’re ready, and we’ll deliver."], ["I joined at 8 o’clock sharp."],
    ["I lived on O'ahu."], ["My boss' feedback helped."], ["The Jones' office and the Cox' lab."], ["Rockin' and rollin' shifts."],
    ["I drove a 10' truck."], ["I worked with O’Connor and D’Souza."], ["L'Oréal hired me."], ["Rock ’n’ roll fans."],
    ["I shipped ’em fast."], ["In ’08 I started."], ["I met Zoë, Søren and Łukasz."], ["Ma'am, I'm ready."],
    ["I used C# and C++ daily."], ["I hit 99.9% uptime 24/7."], ["I built R&D tools (2019–2022)."], ["Revenue grew ½ again — €3m."],
  ])("not a quotation: %s", (text) => {
    expect(unsourcedQuotationIn(text, [])).toBeNull()
  })
  it.each([
    ["I won the “analyst of the year” award twice."],
    ["I won the \"analyst of the year\" award twice."],
    ["The ‘analyst of the year’ award was mine."],
    ["I won the „analyst of the year“ award."],
    ["I won the »analyst of the year« award."],
    ["Named “analyst of the year,” I kept going."],
    ["Named “analyst of the year!” by my peers."],
    ["My “analyst of the year” award’s citation named the models."],
    ["I won the “Analyst Of The Year” award."],
  ])("quoting the cited fact passes: %s", (text) => {
    expect(unsourcedQuotationIn(text, AWARD_SRC)).toBeNull()
  })
  it("quoting a stored quote passes (direction on)", () => {
    expect(unsourcedQuotationIn("I share your aim “to halve operational emissions by 2030”, and I’m keen.", QUOTES)).toBeNull()
    expect(unsourcedQuotationIn("You “will cut water use by 40%” and I can help.", QUOTES)).toBeNull()
  })
  it.each([
    ["NFD", `I built “risk models for Zürich Energy” in 2021.`.normalize("NFD")],
    ["fullwidth source words", `I built “ｒｉｓｋ models for Zürich Energy” in 2021.`],
  ])("quoting a fact with diacritics passes in %s", (_name, text) => {
    expect(unsourcedQuotationIn(text, [FACTS.get("ZUR")!])).toBeNull()
  })
  it("a fact's own wording with a CJK name passes as a bullet (S0) and as the fallback", () => {
    expect(unsourcedQuotationIn(WORDING.get("CJK")!, [FACTS.get("CJK")!])).toBeNull()
    const outcome = finish(resumeOf([], [line("Built carbon models for 北京 Energy using Excel", "CJK")]), emptyLetter, { posting: guard([], false), judge: REFUSE_ALL })
    expect(resumeTexts(outcome)).toEqual([WORDING.get("CJK")])
    expect(outcome.resumeValid).toBe(true)
  })
  it("OBSERVATION (C9): a letter sentence naming a CJK or Arabic company, or a Yoruba name with stacked tone marks, drops one sentence; the paragraph keeps the rest", () => {
    for (const name of ["北京 Energy", "شركة Energy", "Adébáyọ\u0300 Energy"]) {
      const frame = `I built carbon models for ${name} last year.`
      expect(unsourcedQuotationIn(frame, [FACTS.get("CJK")!]), name).not.toBeNull()
      const outcome = finish(emptyResume, letterOf(line(`${frame} ${WIND_SENTENCE}`, "CJK", "WIND"), MENT_P), { posting: guard([], false) })
      expect(letterTexts(outcome).join(" ")).toContain("I built wind farm financial models")
      expect(outcome.letterValid).toBe(true)
    }
  })
  it("OBSERVATION (C9): ≥, ≈, →, ✓ and an e-mail address each drop their sentence", () => {
    for (const text of ["I kept uptime ≥ 99%.", "I saved ≈ €2m.", "I moved Excel → Snowflake.", "✓ Built models.", "Write to ada@example.com."]) {
      expect(unsourcedQuotationIn(text, []), text).not.toBeNull()
    }
  })
  it("the accepted costs C1-C10 fail closed, one fresh row each", () => {
    const rows = [
      ["C1", "I won “analyst of the year” for “wind farm financial models”."],
      ["C2", "Back in ’19 I won the “analyst of the year” award."],
      ["C3", "I won the “analyst of the year” award for the analysts' models."],
      ["C4", "With O'Neill I built the clients' models."],
      ["C5", "I won the “analyst of the year”-style award."],
      ["C5 (French padded guillemets, NBSP)", "I won the «\u00a0analyst of the year\u00a0» award."],
      ["C5 (French padded guillemets, space)", "I won the « analyst of the year » award."],
      ["C6", "With L'Estrange I won the “analyst of the year” award."],
      ["C7", "I sailed Kaua'i to Ni'ihau."],
      ["C8", "I won the “analyst of the year—” award."],
      ["C9", "I won the award ★ twice."],
      ["C10", "I won the ‘’ award."],
    ] as const
    for (const [cost, text] of rows) expect(unsourcedQuotationIn(text, [...AWARD_SRC, FACTS.get("WIND")!]), `${cost}: ${text}`).not.toBeNull()
  })
  it("a letter that quotes the cited fact, with contractions and an NFD name from a fact, is stored end to end, both flags off", () => {
    const frame = "I’m proud I won the ‘analyst of the year’ award, and Zürich Energy’s team agreed.".normalize("NFD")
    const outcome = finish(emptyResume, letterOf(line(frame, "AWARD", "ZUR"), MENT_P), { posting: guard([], false) })
    expect(letterTexts(outcome).join(" ")).toContain(frame)
  })
  it("isQuoteLike, fresh table rows", () => {
    for (const char of ["ʺ", "˗", "‛", "‟", "❮", "❯", "⹂", "〝", "〞", "〟", "\u{1F676}", "\u2064", "ꞌ", "ǀ"]) expect(isQuoteLike(char), `U+${char.codePointAt(0)!.toString(16)}`).toBe(true)
    for (const char of ["ß", "ø", "ł", "ı", "Ω", "ж", "٣", "¼", "™", "№", "－", "，"]) expect(isQuoteLike(char), `U+${char.codePointAt(0)!.toString(16)}`).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------------------
// 5. Rubber-stamp judge, every flag state, fresh adversarial draft; then regressions with fresh inputs.
// ---------------------------------------------------------------------------------------------------------
describe("5. rubber-stamp judge and regressions", () => {
  const RESUME = resumeOf(
    [line("Built wind farm financial models for offshore projects in Tableau", "WIND"), line("Built wind farm financial models, “\u202ethe best in Europe\u202c”", "WIND")],
    [line("Mentored 16 junior developers", "MENT"), line("Built carbon accounting dashboards for offshore wind farm projects", "WIND"), line("Pioneered the payments migration", "PAY")]
  )
  const LETTER = letterOf(
    line(`Your plan to ⸌${FAB}⸍ is clear. ${WIND_SENTENCE}`, "WIND"),
    line("Your plan to “halve operational emissions by 2030” is clear. My wind farm financial models have reached it.", "WIND"),
    MENT_P
  )
  const BAD = ["Tableau", "best in Europe", "16 junior", "carbon accounting dashboards", "Pioneered", "revenue within", "reached it"]
  it.each(STATES)("%s: no hard-fail class is stored, none reaches the judge, both documents valid", (_name, flags) => {
    const outcome = finish(RESUME, LETTER, { posting: guardFor(flags) })
    const text = allText(outcome)
    for (const bad of BAD) expect(text, bad).not.toContain(bad)
    expect(outcome.resumeValid).toBe(true)
    expect(outcome.letterValid).toBe(true)
    for (const bad of ["Tableau", "best in Europe", "16 junior", "revenue within"]) expect(outcome.sent.join(" | "), bad).not.toContain(bad)
  })
  it.each(STATES)("%s: a judge that fails or refuses stores only fact wording in the resume", (_name, flags) => {
    for (const options of [{ judge: REFUSE_ALL }, { judgeFails: true }] as const) {
      const outcome = finish(RESUME, LETTER, { posting: guardFor(flags), ...options })
      const wordings = new Set([...WORDING.values()].map(norm))
      for (const text of resumeTexts(outcome)) expect(wordings.has(norm(text)), text).toBe(true)
    }
  })
  it("QA3-B1 / R17: the cap trims a judged paragraph to a re-failing sentence; it drops and the letter stays valid", () => {
    const forms = ["signup", "profile", "search"].map((n) => line(`I tested React ${n} forms.`, "QA"))
    const outcome = finish(emptyResume, letterOf(...forms, line("I tested React export forms with Jest. I ran regression suites.", "QA")), { keywords: REACT })
    expect(outcome.letterValid).toBe(true)
    expect(letterTexts(outcome).join(" ")).not.toContain("I ran regression suites")
    expect(outcome.settled.paragraphsDropped).toBe(1)
  })
  it("QA3-M1: a cap that leaves only a stored-quote sentence drops it (direction on)", () => {
    const p = line("I tested React import forms. Your plan to “cut water use by 40% across the group” is clear.", "QA")
    const outcome = finish(emptyResume, letterOf(...["g", "h", "i"].map((n) => line(`I tested React ${n} forms.`, "QA")), p), { keywords: REACT })
    expect(letterTexts(outcome).join(" ")).not.toContain("cut water use")
    expect(outcome.letterValid).toBe(true)
  })
  it.each([["achieved"], ["exceeding"], ["Completed"], ["hit"]])("QA3-B2 / R20 (direction on): '%s' after a stored quote is never stored", (word) => {
    const outcome = finish(emptyResume, letterOf(line(`Your plan to “halve operational emissions by 2030” is clear. My wind farm financial models ${word} it.`, "WIND"), MENT_P), { posting: guard() })
    expect(letterTexts(outcome).join(" ")).not.toContain(`${word} it`)
  })
  it("OBSERVATION (R20 is a closed stem list; synonyms are the judge's class): 'attained' after a stored quote is sent to the judge", () => {
    const p = line("Your plan to “halve operational emissions by 2030” is clear. My wind farm financial models have attained it.", "WIND")
    expect(completionWordIn("have attained it")).toBeNull()
    expect(finish(emptyResume, letterOf(p, MENT_P), { posting: guard() }).sent).toContain(p.text)
    expect(letterTexts(finish(emptyResume, letterOf(p, MENT_P), { posting: guard(), judge: REFUSE_ALL })).join(" ")).not.toContain("attained")
  })
  it("R20 leaves ordinary words alone", () => {
    for (const word of ["metric", "hitchhike", "delivery van", "realms"]) expect(completionWordIn(`the ${word} list`), word).toBeNull()
  })
  it("QA3-B3 / R18 / R21 headline: fresh step-down and qualifier titles are null; whole titles print", () => {
    for (const title of ["Junior Sustainability Consultant", "Sustainability Consultant Intern", "Deputy to the Sustainability Consultant", "Sustainability Consultant (Secondment)", "Sustainability Consultant / Auditor"]) {
      expect(headlineFor("Sustainability Consultant", [title]), title).toBeNull()
    }
    for (const title of ["Lead Sustainability Consultant", "Principal Sustainability Consultant", "Sustainability Consultant."]) {
      expect(headlineFor("Sustainability Consultant", [title]), title).toBe("Sustainability Consultant")
    }
  })
  it("R12 / QA4-B1: two titles never combine", () => {
    expect(headlineFor("Sustainability Consultant", ["Sustainability Analyst", "ESG Consultant"])).toBeNull()
  })
  it("R10: a posting tool in lower case never stores, even rubber-stamped", () => {
    expect(allText(finish(resumeOf([line("Built wind farm financial models for offshore projects in workiva", "WIND")]), emptyLetter)).toLowerCase()).not.toContain("workiva")
  })
  it("R13: two refused rewords of one fact collapse to one fact wording", () => {
    const outcome = finish(resumeOf([], [line("Designed wind farm financial models", "WIND"), line("Authored wind farm financial models", "WIND")]), emptyLetter, { judge: REFUSE_ALL })
    expect(resumeTexts(outcome)).toEqual([WORDING.get("WIND")])
  })
  it("R14: four React paragraphs keep three and stay valid", () => {
    const outcome = finish(emptyResume, letterOf(...["w", "x", "y", "z"].map((n) => line(`I tested the ${n} React form.`, "QA"))), { keywords: REACT })
    expect(letterTexts(outcome)).toHaveLength(3)
    expect(outcome.letterValid).toBe(true)
  })
  it("R16: judge down, a reworded paragraph plus a ⸌…⸍ unsourced quote is a claim block, not a provider error", () => {
    const outcome = finish(emptyResume, letterOf(line("I created offshore wind farm revenue models.", "WIND"), line("Peers called me ⸌the model maestro⸍.", "WIND")), { judgeFails: true })
    expect(outcome.letterValid).toBe(false)
    expect(outcome.providerError).toBe(false)
  })
  it("QA3-M2: whole-fact 'I' sentences stay mechanical with the judge down", () => {
    const outcome = finish(emptyResume, letterOf(line("I wrote Jest tests for the checkout. I wrote Jest tests for search.", "J1", "J3")), { judgeFails: true })
    expect(outcome.letterValid).toBe(true)
  })
  it("hard-fail counts carry only reason codes and numbers", () => {
    const outcome = finish(RESUME, LETTER, { posting: guard() })
    for (const [key, value] of Object.entries(outcome.hardFails)) {
      expect(key).toMatch(/^[a-z_]+$/)
      expect(typeof value).toBe("number")
    }
  })
})
