/**
 * EPIC-0012 QA gate 8 (after owner-approved repair wave 7: R25, closed by category and balance). HARD-STOP gate.
 * Adversarial unit tests by an independent QA session. Test files only; no product code changed. Report:
 * epics/active/EPIC-0012-tailoring-rules/test-plan.r8.md.
 *
 * Convention, as in the gate-1 to 7 specs: `it` asserts behaviour the candidate shows and the design requires.
 * `it.fails` asserts REQUIRED behaviour the candidate does not show: each one is a blocker QA8-Bn in the report, and
 * it turns red when the defect is fixed (then it becomes `it`). "OBSERVATION" tests pin a class the design accepts
 * (C1-C15, residuals i-iv), leaves to the judge, or that the report raises as a minor; they pass today.
 *
 * The judge is a plain function (rubber stamp = `() => true`), not a model. `finish` is the gate-4 helper, copied
 * unchanged through gates 5 to 7: it replays documents.service.ts generate() in the service's order. Fresh inputs
 * only: no row repeats a gate-7 input or a Revision 7 row (QA7 rows, V1-V18, P1-P15, the C11-C15 pins).
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
  ["J3", "Wrote Jest tests for search"],
  ["TWO", "Cut report preparation time by 30% using Jest. Trained the finance team"],
  ["AWARD", "Won the \"analyst of the year\" award for the forecasting models"],
  ["CJK", "Built carbon models for 北京 Energy"],
  // Gate 8: facts whose own wording carries a spaced mark that does not balance (C13 shapes).
  ["DASH", "Built 27\" dashboards for traders"],
  ["LAT", "Reduced p99 latency to <200ms"],
  ["SVC", "Wrote the order_service in Go"],
  ["SHY", "Led cross-func­tional forecasting teams"],
  ["NAME", "Shipped the “Pro” plan with O'Brien"],
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
const ALL_SRC = [...QUOTES, FACTS.get("AWARD")!, FACTS.get("WIND")!, FACTS.get("TWO")!]

const letterAlone = (frame: string, posting: PostingGuard, judge: Judge = RUBBER_STAMP, ...factIds: string[]) =>
  finish(emptyResume, letterOf(line(frame, ...(factIds.length > 0 ? factIds : ["WIND", "AWARD"])), MENT_P), { posting, judge })
const letterWith = (frame: string, posting: PostingGuard, judge: Judge = RUBBER_STAMP) =>
  finish(emptyResume, letterOf(line(`${frame} ${WIND_SENTENCE}`, "WIND", "AWARD"), MENT_P), { posting, judge })
const storedLower = (outcome: Outcome) => allText(outcome).toLowerCase()
const quotedStored = (frame: string, posting: PostingGuard) => storedLower(letterWith(frame, posting)).includes("revenue within")

// ---------------------------------------------------------------------------------------------------------
// 1. QA8-B1: a quotation spanning sentences whose two ends are both "trusted" apostrophe shapes.
// ---------------------------------------------------------------------------------------------------------
/**
 * R25 B reads only ACTIVE marks, sentence by sentence. A rule f mark (a leading mark before an elision or a two-digit
 * number: ‘Til, ‘Cause, ‘90s, '30) opens only, and a rule e mark (after s, x, z, "in" or a number: costs’, 2030')
 * closes only. Each is active only when a partner sits in the SAME sentence, so an opener ending its sentence's marks
 * and a closer starting another sentence's marks are both inactive: S1 passes each sentence, and nothing between them
 * is compared. A left single quotation mark ‘ is drawn as an opener, and ’ at the end of the passage as a closer.
 */
const SPANNING = [
  ["‘til … costs’ (left single mark, rule f elision; rule e after s)", `‘til I built wind farm financial models for offshore projects. Your plan to ${FAB} is clear. Forecasting revenue and costs’`],
  ["‘90s … models’ (rule f decade)", `‘90s tools taught me to build wind farm financial models. Your plan to ${FAB} is clear. I built those models’`],
  ["'30 … 2030' (straight, rule f number, rule e number)", `'30 wind farm financial models for offshore projects. Your plan to ${FAB} is clear. Built by 2030'`],
  ["‘cause … teams’ (rule f elision, three sentences)", `‘cause I built wind farm financial models. Your plan to ${FAB} is clear. It is mine. I trained the teams’`],
] as const

describe("1. QA8-B1: a fabricated sentence between a trusted opener and a trusted closer", () => {
  it.fails.each(SPANNING)("QA8-B1: %s is refused at function level", (_name, text) => {
    expect(unsourcedQuotationIn(text, ALL_SRC)).not.toBeNull()
  })
  it("QA8-B1 control: the same passage with plain marks “…” is refused (R25 B, narrowed S0)", () => {
    expect(unsourcedQuotationIn(`“I built wind farm financial models for offshore projects. Your plan to ${FAB} is clear. Forecasting revenue and costs”`, ALL_SRC)).not.toBeNull()
  })
  it("QA8-B1 control: in ONE sentence the same trusted ends are active and S3 refuses the envelope", () => {
    expect(unsourcedQuotationIn(`‘til I built wind farm financial models; your plan to ${FAB} is clear; forecasting revenue and costs’`, ALL_SRC)).not.toBeNull()
  })
  describe.each(STATES)("%s", (_state, flags) => {
    const posting = guardFor(flags)
    it.fails("QA8-B1: ‘til … costs’ around a fabricated sentence is never stored (rubber stamp)", () => {
      expect(storedLower(letterAlone(SPANNING[0][1], posting))).not.toContain("revenue within")
    })
    it("QA8-B1 control: a capitalised ‘Til is a claim word no judge can lend, so the row needs the lower-case opener", () => {
      expect(storedLower(letterAlone(SPANNING[0][1].replace("‘til", "‘Til"), posting))).not.toContain("revenue within")
    })
    it("QA8-B1 control: with a judge that refuses, nothing fabricated is stored", () => {
      expect(storedLower(letterAlone(SPANNING[0][1], posting, REFUSE_ALL))).not.toContain("revenue within")
    })
  })
})

// ---------------------------------------------------------------------------------------------------------
// 2. QA8-B2: a verbatim fact sentence with an unbalanced spaced mark inside a paragraph (fixed by R26).
// ---------------------------------------------------------------------------------------------------------
/**
 * QA8-B2 pinned a verbatim fact sentence whose spaced marks do not balance as a block: narrowed S0 failed it
 * inside a paragraph, though U0 passes it alone. R26 (owner-approved repair wave 8, cost C13) reads U0 on each
 * sentence too, so a sentence that IS one of a source's own sentences passes inside a longer unit. A fact's own
 * sentence therefore keeps its paragraph, as C13 states: a false positive drops one sentence at most, and never
 * a document. Every sentence of these letters is legitimate.
 */
const C13_FACTS = [
  ["27\" (inches)", "DASH", "Built 27\" dashboards for traders."],
  ["<200ms", "LAT", "Reduced p99 latency to <200ms."],
  ["order_service", "SVC", "Wrote the order_service in Go."],
] as const

describe("2. QA8-B2: a verbatim fact sentence with an unbalanced spaced mark, inside a paragraph", () => {
  it.each(C13_FACTS)("%s: the sentence passes alone (U0) and inside a two-sentence paragraph (U0 on one sentence)", (_name, id, sentence) => {
    expect(unsourcedQuotationIn(sentence, [FACTS.get(id)!])).toBeNull()
    expect(unsourcedQuotationIn(`${sentence} I mentored 6 junior developers.`, [FACTS.get(id)!, FACTS.get("MENT")!])).toBeNull()
  })
  it.each(C13_FACTS)("QA8-B2: %s, one-paragraph letter of two legitimate sentences is valid (never a block)", (_name, id, sentence) => {
    const outcome = finish(emptyResume, letterOf(line(`${sentence} I mentored 6 junior developers.`, id, "MENT")), { posting: guard([], false) })
    expect(outcome.letterValid).toBe(true)
    expect(letterTexts(outcome).join(" ")).toContain("I mentored 6 junior developers.")
  })
  it.each(C13_FACTS)("QA8-B2: %s, in a two-paragraph letter the paragraph is kept whole, and the other paragraph stays", (_name, id, sentence) => {
    const outcome = finish(emptyResume, letterOf(line(`${sentence} ${WIND_SENTENCE}`, id, "WIND"), line("I wrote Jest tests for search.", "J3")), { posting: guard([], false) })
    expect(outcome.letterValid).toBe(true)
    expect(letterTexts(outcome).join(" ")).toContain("I built wind farm financial models")
    expect(letterTexts(outcome).join(" ")).toContain("I wrote Jest tests for search.")
  })
  it("QA8-B2 OBSERVATION: the paragraph holding the 27-inch sentence is kept whole when another paragraph survives", () => {
    const outcome = finish(emptyResume, letterOf(line(`Built 27" dashboards for traders. ${WIND_SENTENCE}`, "DASH", "WIND"), line("I wrote Jest tests for search.", "J3")), { posting: guard([], false) })
    expect(letterTexts(outcome)[0]).toContain("27\" dashboards")
    expect(letterTexts(outcome)[1]).toBe("I wrote Jest tests for search.")
    expect(outcome.letterValid).toBe(true)
  })
  it("QA8-B2 OBSERVATION: a two-sentence summary line holding a verbatim 27-inch fact sentence is kept whole; the resume stays valid", () => {
    const outcome = finish(
      resumeOf([line(`Built 27" dashboards for traders. Mentored 6 junior developers`, "DASH", "MENT"), line("Mentored 6 junior developers", "MENT")], [line(`Reduced p99 latency to <200ms. Built wind farm financial models for offshore projects`, "LAT", "WIND")]),
      emptyLetter,
      { posting: guard([], false) }
    )
    expect(resumeTexts(outcome).join(" | ")).toContain("27\" dashboards")
    expect(resumeTexts(outcome)[0]).toBe(`Built 27" dashboards for traders. Mentored 6 junior developers`)
    expect(outcome.resumeValid).toBe(true)
  })
  it("controls: a balanced fact (AWARD) and a CJK fact as paragraph sentences keep the paragraph (P3/P4 shapes, fresh partner)", () => {
    for (const [id, sentence] of [["AWARD", `${WORDING.get("AWARD")}.`], ["CJK", `${WORDING.get("CJK")}.`]] as const) {
      const outcome = finish(emptyResume, letterOf(line(`${sentence} I wrote Jest tests for search.`, id, "J3")), { posting: guard([], false) })
      expect(outcome.letterValid, id).toBe(true)
      expect(letterTexts(outcome).join(" "), id).toContain("I wrote Jest tests for search.")
    }
  })
})

// ---------------------------------------------------------------------------------------------------------
// 3. QA7-B1/B2/B3 closed against fresh inputs; no new bypass of unsourcedQuotationIn.
// ---------------------------------------------------------------------------------------------------------
/** One or more characters per Unicode category edge the brief names; each is used as both marks of a quotation. */
const CATEGORY_EDGES: readonly (readonly [string, string])[] = [
  ["Lm ʹ U+02B9", "ʹ"], ["Lm ˮ U+02EE", "ˮ"], ["Lm ꞈ U+A788", "ꞈ"], ["Lm ₐ U+2090", "ₐ"], ["Lm ߴ U+07F4", "ߴ"],
  ["Sk ´ U+00B4", "´"], ["Sk ᾽ U+1FBD", "᾽"], ["Sk ˋ? U+02CB is Lm; Sk ˥ U+02E5", "˥"], ["Sk ＾ U+FF3E", "＾"],
  ["Mn U+0301", "́"], ["Mn U+0313", "̓"], ["Mn U+0345", "ͅ"], ["Me U+20DD", "⃝"], ["Me U+0488", "҈"],
  ["Cf U+2063", "⁣"], ["Cf U+FFF9", "￹"], ["Cf U+110BD", "\u{110bd}"], ["Co U+F0000", "\u{f0000}"], ["Co U+E123", ""],
  ["Cn U+0378", "͸"], ["Cn U+2FFFE", "\u{2fffe}"], ["Zs U+1680 ogham", " "], ["tag U+E0041", "\u{e0041}"], ["tag U+E0027", "\u{e0027}"],
  ["VS U+FE0E", "︎"], ["VS U+E0100", "\u{e0100}"], ["Lo ǀ U+01C0", "ǀ"], ["Lo ᑊ U+144A", "ᑊ"], ["Po ⹂ U+2E42", "⹂"],
  ["Pi ⸂ U+2E02", "⸂"], ["Pf ⸃ U+2E03", "⸃"], ["Po ׳ U+05F3", "׳"], ["So ❛ U+275B", "❛"], ["So 🙷 U+1F677", "\u{1f677}"],
]
const SHAPES = [
  ["glued", (c: string) => `Your plan to ${c}${FAB}${c} is clear.`],
  ["padded", (c: string) => `Your plan to ${c} ${FAB} ${c} is clear.`],
  ["after the fact wording", (c: string) => `Built wind farm financial models for offshore projects ${c}${FAB}${c}.`],
  ["inside a sourced quotation", (c: string) => `I won the “analyst of the year ${c}${FAB}${c}” award.`],
  ["spanning sentences from a fact sentence", (c: string) => `Built wind farm financial models for offshore projects ${c}forecasting revenue and cost. Your plan to ${FAB} is clear.${c}`],
] as const

describe("3. QA7-B1, B2, B3 and the R25 rules hold against fresh inputs", () => {
  it("R25 step 1 invariant: no code point in a mark category (Lm Sk M Cf Co Cn Zl Zp Cc) is a word or plain character", () => {
    const bad: string[] = []
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue
      const char = String.fromCodePoint(cp)
      if (!/^[\p{Lm}\p{Sk}\p{M}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Cc}]$/u.test(char)) continue
      const cls = charClassOf(char)
      if (cls === "word" || cls === "plain") bad.push(cp.toString(16))
    }
    expect(bad).toEqual([])
  })
  it("R25 step 1: no Pi, Pf, Ps or Pe code point outside the plain brackets is a word or plain character", () => {
    const bad: string[] = []
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue
      const char = String.fromCodePoint(cp)
      if (!/^[\p{Pi}\p{Pf}\p{Ps}\p{Pe}]$/u.test(char)) continue
      if (charClassOf(char) === "mark") continue
      if (!/^[()[\]{}]$/.test(char.normalize("NFKC"))) bad.push(cp.toString(16))
    }
    expect(bad).toEqual([])
  })
  it.each(CATEGORY_EDGES)("%s as both marks is refused in every shape", (_name, char) => {
    for (const [shape, make] of SHAPES) expect(unsourcedQuotationIn(make(char), ALL_SRC), `${shape}: ${JSON.stringify(make(char))}`).not.toBeNull()
  })
  it("non-Latin letters and confusables inside or around a sourced quotation are refused", () => {
    const rows = [
      `I won the “analyst of the year ${"дабл ревеню"}” award.`, // Cyrillic words (word class, compared)
      `I won the “analyst of the year δίπλα” award.`, // Greek words (word class, compared)
      `I won the “analyst of the year 倍增收入” award.`, // CJK (kept by R25 step 2)
      `I won the “analyst of the year ᎠᏴᏞᎬ” award.`, // Cherokee capitals that look Latin
      `I won the “analyst of the year ꓓꓳꓴꓐꓡꓰ” award.`, // Lisu, fresh word
      `I won the “ａｎａｌｙｓｔ of the year ｄｏｕｂｌｅ” award.`, // fullwidth: NFKC folds the sourced and fabricated words alike
      `I won the “analyst of the year 𝖉𝖔𝖚𝖇𝖑𝖊” award.`, // mathematical fraktur
      `I won the “anal‍yst of the year” award ${FAB}.`, // ZWJ kept inside a sourced word (R25 step 2) makes it unsourced
      `Built wind farm financial models for offshore projects «倍增收入».`,
      `Built wind farm financial models for offshore projects ᐸ${FAB}ᐳ.`, // Canadian syllabics drawn as chevrons
    ]
    for (const text of rows) expect(unsourcedQuotationIn(text, ALL_SRC), text).not.toBeNull()
  })
  it("balance rule B and narrowed S0 on unusual layouts: every row is refused", () => {
    const rows = [
      `I won the “analyst of the year”” award ${FAB}.`, // over-balanced closer
      `I won the ““analyst of the year” award ${FAB}.`, // doubled opener
      `I won the “analyst of the year\n${FAB}” award.`, // newline inside
      `I won the “analyst of the year” “${FAB}” award.`, // second quotation
      `I won the “analyst of the year”\t“${FAB}”.`, // tab between two quotations
      `${FAB} “`, // trailing lone opener
      `Did I win the “analyst of the year? Your plan to ${FAB} is clear.”`, // ? split
      `I won the “analyst of the year! Your plan to ${FAB} is clear.” award`, // ! split
      `I won the “analyst of the year” at Acme Inc. Your plan to “${FAB}” is clear.`, // abbreviation, no split
      `Won the "analyst. Your plan to ${FAB} is clear. Of the year" award.`, // AWARD's own marks cut across sentences
      `Won the "analyst of the year. Your plan to ${FAB} is clear.`, // AWARD cut leaves its opener open within the unit
      `“Our aim is to halve operational emissions. Your plan to ${FAB} is clear. By 2030”`, // stored quote cut around a fabricated sentence
      `Your aim “to halve operational emissions by 2030. Your plan to ${FAB} is clear.”`,
      `Your plan to “${FAB} and halve operational emissions by 2030” is clear.`, // fabrication inside a stored quote
      `Your plan to 'n' ${FAB} 'n' is clear.`, // n-units as marks
      `Your plan'n'${FAB}'n'is clear.`,
      `I won the “analyst of the year”️ ${FAB}”.`, // variation selector on a closer
      `“Analyst of the year.” “${FAB}.”`,
      `“Built wind farm financial models for offshore projects.” Your plan to ${FAB} is clear.”`,
    ]
    for (const text of rows) expect(unsourcedQuotationIn(text, ALL_SRC), JSON.stringify(text)).not.toBeNull()
  })
  it("U0 only passes text that is all source words: a fabricated word anywhere in the unit fails U0", () => {
    for (const text of [`Won the "analyst of the year double" award for the forecasting models`, `Won the "analyst of the doubled year" award for the forecasting models`, `"analyst of the decade"`]) {
      expect(unsourcedQuotationIn(text, AWARD_SRC), text).not.toBeNull()
    }
  })
  describe.each(STATES)("%s", (_state, flags) => {
    const posting = guardFor(flags)
    it.each([
      ["Cherokee inside a sourced quotation", `I won the “analyst ᎠᏴᏞᎬ of the year” award.`],
      ["Lm ʹ as marks", `Your plan to ʹ${FAB}ʹ is clear.`],
      ["Me U+20DD as marks", `Your plan to ⃝${FAB}⃝ is clear.`],
      ["tag apostrophes", `Your plan to \u{e0027}${FAB}\u{e0027} is clear.`],
      ["fabrication inside a stored quote", `Your plan to “${FAB} and halve operational emissions by 2030” is clear.`],
      ["over-balanced closer", `I won the “analyst of the year”” award and ${FAB}.`],
      ["AWARD's marks reused across sentences", `Won the "analyst. Your plan to ${FAB} is clear. Of the year" award.`],
    ])("%s: never stored, rubber-stamped", (_name, frame) => {
      expect(quotedStored(frame, posting) || storedLower(letterWith(frame, posting)).includes("ᏴᏞ")).toBe(false)
    })
  })
  it("OBSERVATION (residual ii): characters just inside the allowlist are commas, brackets, digits or strokes, and wrap nothing", () => {
    for (const char of ["﹐", "︐", "，", "⁽", "₍", "¹", "⁰", "Ⅰ", "ⅼ", "ℓ", "ӏ", "١"]) {
      expect(isQuoteLike(char), `U+${char.codePointAt(0)!.toString(16)}`).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------------------------------------
// 4. Never a block from R25's quotation check, and normalisation never rewrites stored text.
// ---------------------------------------------------------------------------------------------------------
describe("4. fallback and storage", () => {
  it.each([["DASH"], ["LAT"], ["SVC"], ["SHY"], ["NAME"], ["AWARD"], ["CJK"]])("%s: the fact's own wording passes, so a refused bullet falls back and the resume is valid", (id) => {
    expect(unsourcedQuotationIn(WORDING.get(id)!, [FACTS.get(id)!])).toBeNull()
    const outcome = finish(resumeOf([], [line(`${WORDING.get(id)} “${FAB}”`, id)]), emptyLetter, { posting: guard([], false), judge: REFUSE_ALL })
    expect(resumeTexts(outcome)).toEqual([WORDING.get(id)])
    expect(outcome.resumeValid).toBe(true)
  })
  it.each([
    ["NFD", "I led the “cross-functional forecasting teams” at Acme Energy.".normalize("NFD")],
    ["soft hyphen copied from the fact", "I led “cross-func­tional forecasting teams” at Acme."],
    ["compatibility ligature", "I led “cross-functional forecasting teams” at Acme, ﬁrst."],
  ])("%s: a passing letter sentence is stored code point for code point", (_name, text) => {
    const outcome = finish(emptyResume, letterOf(line(text, "SHY"), MENT_P), { posting: guard([], false) })
    const stored = letterTexts(outcome)
    if (unsourcedQuotationIn(text, [FACTS.get("SHY")!]) === null) expect(stored[0]).toBe(text)
    else expect(stored.join(" ")).not.toContain("forecasting teams")
    for (const p of stored) expect([text, MENT_P.text]).toContain(p)
  })
  it("a bullet that is the CJK fact's wording in NFD-equivalent form is stored as written or as the wording, never composed", () => {
    const written = "Built carbon models for 北京 Energy"
    const outcome = finish(resumeOf([], [line(written, "CJK")]), emptyLetter, { posting: guard([], false), judge: REFUSE_ALL })
    expect(resumeTexts(outcome)).toEqual([written])
  })
})

// ---------------------------------------------------------------------------------------------------------
// 5. False positives: legitimate text still passes (fresh).
// ---------------------------------------------------------------------------------------------------------
describe("5. legitimate text", () => {
  it.each([
    ["They’d’ve shipped it."], ["We’ve met at 9 o'clock."], ["Hawai'i and O'ahu teams joined."], ["Thanks, ma'am; y'all helped."],
    ["The bus' route and the box' lid."], ["Movin' fast mattered."], ["A 12' boom and a 3' rail."], ["D'Angelo and O'Hara joined."],
    ["’Twas a good year."], ["Since ’19 I have led it."], ["In the ’80s it began."], ["Fish ’n’ chips."],
    ["I scaled to 10× load at 99.95% uptime."], ["Budget: £1.2m (2021–2023); team of 8."], ["I used Node.js, C# and F#."],
  ])("not a quotation: %s", (text) => {
    expect(unsourcedQuotationIn(text, [])).toBeNull()
  })
  it.each([
    ["I was named “analyst of the year” in 2021."],
    ["I won the 'analyst of the year' award."],
    ["I won the ‚analyst of the year‘ award."],
    ["I won the «analyst of the year» award."],
    ["I won the “Analyst of the Year.”"],
    ["I won (“analyst of the year”), twice."],
    ["My teams' “analyst of the year” award came first."],
    ["I won the “analyst of the year” award, and I’m proud."],
  ])("quoting the cited fact passes: %s", (text) => {
    expect(unsourcedQuotationIn(text, AWARD_SRC)).toBeNull()
  })
  it("quoting a stored quote passes (direction on), and a quote held in a profile fact passes", () => {
    expect(unsourcedQuotationIn("Your aim “to halve operational emissions by 2030” is clear.", QUOTES)).toBeNull()
    expect(unsourcedQuotationIn("I shipped the “Pro” plan with O'Brien.", [FACTS.get("NAME")!])).toBeNull()
    expect(unsourcedQuotationIn(WORDING.get("NAME")!, [FACTS.get("NAME")!])).toBeNull()
  })
  it("a fact's own wording passes, and the fact's words in a quotation pass", () => {
    expect(unsourcedQuotationIn("I built “wind farm financial models” for offshore projects.", [FACTS.get("WIND")!])).toBeNull()
    expect(unsourcedQuotationIn(`${WORDING.get("TWO")}.`, [FACTS.get("TWO")!])).toBeNull()
  })
  it("OBSERVATION (new with R25 step 2, minor): quoting a fact that holds a soft hyphen fails in either form; one sentence drops, the unquoted sentence passes", () => {
    expect(unsourcedQuotationIn("I led “cross-functional forecasting teams” for years.", [FACTS.get("SHY")!])).not.toBeNull()
    // Copying the soft hyphen does not help: it is a Cf mark glued inside a word, orientation 0, refused by B (C9/C14).
    expect(unsourcedQuotationIn("I led “cross-func­tional forecasting teams” for years.", [FACTS.get("SHY")!])).not.toBeNull()
    expect(unsourcedQuotationIn("I led cross-functional forecasting teams.", [FACTS.get("SHY")!])).toBeNull()
  })
  it("OBSERVATION (C13 class, closed by R26 for QA8-B2): verbatim fact sentences holding <, →, ≥, _, @ or an emoji pass inside a paragraph, and their partner sentence stays", () => {
    for (const [fact, sentence] of [
      ["Migrated Python → Go services", "Migrated Python → Go services."],
      ["Cut AWS costs by ≥30%", "Cut AWS costs by ≥30%."],
      ["Launched the 🚀 app", "Launched the 🚀 app."],
      ["Ran the ops@acme.com inbox", "Ran the ops@acme.com inbox."],
    ] as const) {
      expect(unsourcedQuotationIn(sentence, [withHeading(fact)]), fact).toBeNull()
      expect(unsourcedQuotationIn(`${sentence} I mentored 6 junior developers.`, [withHeading(fact), FACTS.get("MENT")!]), fact).toBeNull()
    }
  })
  it("costs C12-C15 fail closed on fresh rows; residuals (iii), (iii′), (iv) pass on fresh rows", () => {
    expect(unsourcedQuotationIn(`“Wrote Jest tests for the checkout. Wrote Jest tests for search.”`, [FACTS.get("J1")!, FACTS.get("J3")!]), "C12").not.toBeNull()
    expect(unsourcedQuotationIn(`I “sailed O'ahu and Moloka'i” daily.`, ["sailed O'ahu and Moloka'i"]), "C14").not.toBeNull()
    expect(unsourcedQuotationIn("Ranked 1ˢᵗ in the region.", []), "C15").not.toBeNull()
    expect(unsourcedQuotationIn(`Your plan to ${FAB} ”wind farm financial models” too.`, [FACTS.get("WIND")!]), "(iii)").toBeNull()
    expect(unsourcedQuotationIn(`I built the 'forecasting models' ${FAB}.`, ["the 'forecasting models' award"]), "(iii′)").toBeNull()
    expect(unsourcedQuotationIn(`Won the "analyst`, AWARD_SRC), "(iv)").toBeNull()
    expect(unsourcedQuotationIn("O'Brien and I won the “analyst of the year” award.", AWARD_SRC), "C6 (name mark opens the envelope)").not.toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------------------
// 6. Rubber-stamp judge, every flag state, fresh draft; regressions with fresh inputs.
// ---------------------------------------------------------------------------------------------------------
describe("6. rubber-stamp judge and regressions", () => {
  const RESUME = resumeOf(
    [line("Built wind farm financial models for offshore projects in Power BI", "WIND"), line("Built wind farm financial models, “ᏴᏞᎬ the finest”", "WIND")],
    [line("Mentored 26 junior developers", "MENT"), line("Built carbon accounting models for offshore wind farm projects", "WIND"), line("Spearheaded the payments migration", "PAY")]
  )
  const LETTER = letterOf(
    line(`Your plan to ʹ${FAB}ʹ is clear. ${WIND_SENTENCE}`, "WIND"),
    line("Your plan to “halve operational emissions by 2030” is clear. My wind farm financial models have surpassed it.", "WIND"),
    MENT_P
  )
  const BAD = ["Power BI", "finest", "26 junior", "carbon accounting models", "Spearheaded", "revenue within", "surpassed"]
  it.each(STATES)("%s: no hard-fail class is stored, none reaches the judge, both documents valid", (_name, flags) => {
    const outcome = finish(RESUME, LETTER, { posting: guardFor(flags) })
    const text = allText(outcome)
    for (const bad of BAD) expect(text, bad).not.toContain(bad)
    expect(outcome.resumeValid).toBe(true)
    expect(outcome.letterValid).toBe(true)
    for (const bad of ["Power BI", "finest", "26 junior", "revenue within"]) expect(outcome.sent.join(" | "), bad).not.toContain(bad)
  })
  it.each(STATES)("%s: a judge that fails or refuses stores only fact wording in the resume", (_name, flags) => {
    for (const options of [{ judge: REFUSE_ALL }, { judgeFails: true }] as const) {
      const outcome = finish(RESUME, LETTER, { posting: guardFor(flags), ...options })
      const wordings = new Set([...WORDING.values()].map(norm))
      for (const text of resumeTexts(outcome)) expect(wordings.has(norm(text)), text).toBe(true)
    }
  })
  it("QA3-B1 / R17: the cap trims a judged paragraph to a re-failing sentence; it drops and the letter stays valid", () => {
    const forms = ["login", "billing", "invite"].map((n) => line(`I tested React ${n} forms.`, "QA"))
    const outcome = finish(emptyResume, letterOf(...forms, line("I tested React audit forms with Jest. I ran regression suites.", "QA")), { keywords: REACT })
    expect(outcome.letterValid).toBe(true)
    expect(letterTexts(outcome).join(" ")).not.toContain("I ran regression suites")
    expect(outcome.settled.paragraphsDropped).toBe(1)
  })
  it.each([["met"], ["surpassing"], ["Fulfilled"], ["reaching"]])("QA3-B2 / R20 (direction on): '%s' after a stored quote is never stored", (word) => {
    const outcome = finish(emptyResume, letterOf(line(`Your plan to “halve operational emissions by 2030” is clear. My wind farm financial models ${word} it.`, "WIND"), MENT_P), { posting: guard() })
    expect(letterTexts(outcome).join(" ")).not.toContain(`${word} it`)
  })
  it("QA3-B3 / R18 / R21 headline: fresh step-down titles are null; whole titles print", () => {
    for (const title of ["Graduate Sustainability Consultant", "Sustainability Consultant Apprentice", "Assistant to the Sustainability Consultant", "Sustainability Consultant (Contract)"]) {
      expect(headlineFor("Sustainability Consultant", [title]), title).toBeNull()
    }
    expect(headlineFor("Sustainability Consultant", ["Senior Sustainability Consultant"])).toBe("Sustainability Consultant")
    expect(headlineFor("Sustainability Consultant", ["Sustainability Lead", "Carbon Consultant"])).toBeNull()
  })
  it("R10 / R13 / R14 / R16 / QA3-M2 fresh rows", () => {
    expect(allText(finish(resumeOf([line("Built wind farm financial models for offshore projects in snowflake", "WIND")]), emptyLetter)).toLowerCase()).not.toContain("snowflake")
    expect(resumeTexts(finish(resumeOf([], [line("Engineered wind farm financial models", "WIND"), line("Crafted wind farm financial models", "WIND")]), emptyLetter, { judge: REFUSE_ALL }))).toEqual([WORDING.get("WIND")])
    expect(letterTexts(finish(emptyResume, letterOf(...["a", "b", "c", "d"].map((n) => line(`I tested the ${n} React form.`, "QA"))), { keywords: REACT }))).toHaveLength(3)
    const r16 = finish(emptyResume, letterOf(line("I designed offshore wind farm revenue models.", "WIND"), line("Peers called me ʹthe model wizardʹ.", "WIND")), { judgeFails: true })
    expect(r16.letterValid).toBe(false)
    expect(r16.providerError).toBe(false)
    expect(finish(emptyResume, letterOf(line("I wrote Jest tests for the checkout. I wrote Jest tests for search.", "J1", "J3")), { judgeFails: true }).letterValid).toBe(true)
    expect(completionWordIn("the delivery metric")).toBeNull()
  })
  it("hard-fail counts carry only reason codes and numbers, never text", () => {
    const outcome = finish(RESUME, LETTER, { posting: guard() })
    for (const [key, value] of Object.entries(outcome.hardFails)) {
      expect(key).toMatch(/^[a-z_]+$/)
      expect(typeof value).toBe("number")
    }
    expect(JSON.stringify(outcome.hardFails)).not.toMatch(/revenue|ᏴᏞ|ʹ|Power/)
  })
})
