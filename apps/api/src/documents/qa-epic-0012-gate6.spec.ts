/**
 * EPIC-0012 QA gate 6 (after owner-approved repair wave 5: R23, quotation provenance by content, the envelope rule).
 * Adversarial unit tests by an independent QA session. Test files only; no product code changed. Report:
 * epics/active/EPIC-0012-tailoring-rules/test-plan.r6.md.
 *
 * Convention, as in the gate-1 to 5 specs: `it` asserts behaviour the candidate shows and the design requires.
 * `it.fails` asserts REQUIRED behaviour the candidate does not show: each one is a blocker QA6-Bn in the report, and
 * it turns red when the defect is fixed (then it becomes `it`). "OBSERVATION" tests pin a class the design accepts,
 * leaves to the judge, or that the report raises as a minor; they pass today.
 *
 * The judge is a plain function (rubber stamp = `() => true`), not a model. `finish` is the gate-4 helper, copied
 * unchanged through gate 5: it replays documents.service.ts generate() in the service's order. Fresh inputs only:
 * no row repeats a gate-5 or Revision 5 (N1-N16, L1-L8, C1-C6) input.
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
import { completionWordIn, isQuoteLike, unsourcedQuotationIn } from "./company-direction.js"
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
  ["DOCS", "Reduced Jest suite runtime by 40%. Wrote onboarding guides"],
  ["AWARD", "Won the \"analyst of the year\" award for the forecasting models"],
  ["TEAMS", "Built the teams' shared forecasting models"],
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
const JEST = [kw("Jest")]
const REACT = [kw("React")]
const FAB = "double revenue within the decade"
const AWARD_SRC = [FACTS.get("AWARD")!]
const ALL_SRC = [...QUOTES, FACTS.get("AWARD")!, FACTS.get("WIND")!]

/** A letter paragraph citing WIND and AWARD, so "analyst of the year" is a source in every flag state. */
const letterWith = (frame: string, posting: PostingGuard, judge: Judge = RUBBER_STAMP) =>
  finish(emptyResume, letterOf(line(`${frame} ${WIND_SENTENCE}`, "WIND", "AWARD"), MENT_P), { posting, judge })
const quotedStored = (frame: string, posting: PostingGuard) => letterTexts(letterWith(frame, posting)).join(" ").toLowerCase().includes("revenue within")

// ---------------------------------------------------------------------------------------------------------
// 1. R23 holes: text the employer never wrote, stored as a quotation with both flags off and a rubber stamp.
// ---------------------------------------------------------------------------------------------------------
describe("1. R23: fabricated quotations that still reach storage", () => {
  // QA6-B1. isQuoteLike (company-direction.ts:182-186) tests the code point as written, against QUOTE_LOOK_ALIKES
  // (:157-167) and Pi/Pf/Ps/Pe. Nothing normalises first. Three characters are CANONICALLY equivalent (NFC) to marks
  // the list names, so they render the same and normalise to them: U+1FFD GREEK OXIA = ´ U+00B4, U+1FEF GREEK
  // VARIA = ` U+0060, U+0374 GREEK NUMERAL SIGN = ʹ U+02B9. Others are drawn as ticks or double ticks and are in
  // no list: ˵ ˶ (U+02F5/6, modifier middle double grave/acute), ՚ (U+055A Armenian apostrophe), ߵ ߴ (U+07F5/4 NKo
  // tone apostrophes) and ᾽ (U+1FBD Greek koronis). With no mark, S1 passes the sentence.
  it("BLOCKER QA6-B1: every code point canonically equivalent to a listed mark is quote-like", () => {
    for (const char of ["´", "`", "ʹ"]) {
      expect(isQuoteLike(char.normalize("NFC")), `NFC of U+${char.codePointAt(0)!.toString(16)}`).toBe(true)
    }
  })
  it.each([["´"], ["`"], ["ʹ"]])("QA6-B1 fixed by R24 step 1: isQuoteLike(%s) is true (canonical twin of a listed mark)", (char) => {
    expect(isQuoteLike(char)).toBe(true)
  })
  describe.each(STATES)("%s", (_state, flags) => {
    const posting = guardFor(flags)
    it.each([
      ["´…´ U+1FFD (canonical ´ U+00B4)", `Your plan to ´${FAB}´ is clear.`],
      ["`…` U+1FEF (canonical ` U+0060)", `Your plan to `${FAB}` is clear.`],
      ["ʹ…ʹ U+0374 (canonical ʹ U+02B9)", `Your plan to ʹ${FAB}ʹ is clear.`],
      ["˵…˶ U+02F5/U+02F6", `Your plan to ˵${FAB}˶ is clear.`],
      ["՚…՚ U+055A Armenian apostrophe", `Your plan to ՚${FAB}՚ is clear.`],
      ["ߵ…ߴ U+07F5/U+07F4 NKo apostrophes", `Your plan to ߵ${FAB}ߴ is clear.`],
      ["᾽…᾽ U+1FBD koronis", `Your plan to ᾽${FAB}᾽ is clear.`],
    ])("BLOCKER QA6-B1: %s is never stored", (_name, frame) => {
      expect(quotedStored(frame, posting)).toBe(false)
    })
  })

  // QA6-B2. Rule d (company-direction.ts:326-337) needs a word character on BOTH sides of an apostrophe mark. An
  // invisible or combining code point after the mark (ZWSP U+200B, ZWNJ U+200C, word joiner U+2060, soft hyphen
  // U+00AD, combining acute U+0301) makes it rule e, "trailing: closes only" (:339-343). Both marks of QA5-B2's
  // plan'…'is are then closers with no opener, so activePositions (:368-379) finds none and S1 passes. The text
  // renders exactly as the QA5-B2 rows, which R23 catches without the invisible character.
  describe.each(STATES)("%s", (_state, flags) => {
    const posting = guardFor(flags)
    it.each([
      ["ZWSP after each straight mark", `Your plan'\u200b${FAB}'\u200bis clear.`],
      ["ZWSP after each curly mark", `Your plan’\u200b${FAB}’\u200bis clear.`],
      ["word joiner", `Your plan'\u2060${FAB}'\u2060is clear.`],
      ["zero-width non-joiner", `Your plan’\u200c${FAB}’\u200cis clear.`],
      ["soft hyphen", `Your plan'\u00ad${FAB}'\u00adis clear.`],
      ["combining acute on each mark", `Your plan'\u0301${FAB}'\u0301is clear.`],
      ["after a one-letter word, ZWSP", `Your plan is a'\u200b${FAB}'\u200b goal.`],
    ])("BLOCKER QA6-B2: %s (renders as plan'…'is) is never stored", (_name, frame) => {
      expect(quotedStored(frame, posting)).toBe(false)
    })
  })
  it("QA6-B2 control: the same rows without the invisible character are caught (R23 holds on visible text)", () => {
    for (const frame of [`Your plan'${FAB}'is clear.`, `Your plan’${FAB}’is clear.`]) expect(unsourcedQuotationIn(frame, ALL_SRC), frame).not.toBeNull()
  })

  // QA6-B3. S4 (company-direction.ts:216-226) reads one code point on each side of the outer marks: a word
  // character glued on the outside, or whitespace on the inside. An unopened closer after FAB, or an unclosed
  // opener before it, escapes when the neighbour is punctuation (".”;", ".”“", ":“…", "—“—"), a space on the
  // OUTSIDE (FAB ”—“), or an invisible character. The envelope between the outer marks is a sourced run (the cited
  // AWARD fact's "analyst of the year", or empty), so S3 passes, and FAB, outside the region, is never checked.
  describe.each(STATES)("%s", (_state, flags) => {
    const posting = guardFor(flags)
    it.each([
      ["closer after a full stop, then ;", `Your plan to ${FAB}.”; the “analyst of the year” award is mine.`],
      ["closer after a full stop, opener glued", `Your plan to ${FAB}.”“analyst of the year” is my title.`],
      ["closer after !, then em dash", `Your plan to ${FAB}!”—“analyst of the year” too.`],
      ["spaced closer, then em dash", `Your plan to ${FAB} ”—“analyst of the year” too.`],
      ["unclosed opener after a colon and an ellipsis", `I won the “analyst of the year” award:“…${FAB}.`],
      ["unclosed opener between em dashes", `I won the “analyst of the year” award—“—${FAB}.`],
    ])("QA6-B3 fixed by R24 L1 and L4: %s is never stored", (_name, frame) => {
      expect(quotedStored(frame, posting)).toBe(false)
    })
    // R24 step 1 (Part A): an invisible character is a mark, so both rows are caught by the class change.
    it.each([
      ["N3 with ZWSP (renders FAB”“is)", `Your plan to ${FAB}\u200b”“\u200bis clear.`],
      ["N5 with ZWSP (renders plan”the“FAB)", `Your plan\u200b”the“\u200b${FAB}.`],
    ])("QA6-B3 fixed by R24 step 1: %s is never stored", (_name, frame) => {
      expect(quotedStored(frame, posting)).toBe(false)
    })
  })
  it("QA6-B3 fixed by R24 L1: R19's closer after a full stop then ')' is refused (another check drops this sentence end to end)", () => {
    expect(unsourcedQuotationIn(`(Your plan to ${FAB}.”) “Analyst of the year” is my title.`, AWARD_SRC)).not.toBeNull()
  })
  it("QA6-B3 control: the spaced and glued forms R23 names (N3, N5) are caught", () => {
    for (const frame of [`Your plan to ${FAB}.” “analyst of the year” is my title.`, `Your plan”the“${FAB}.`, `I won the “analyst of the year” award: “${FAB}.`]) {
      expect(unsourcedQuotationIn(frame, ALL_SRC), frame).not.toBeNull()
    }
  })

  it("R24 rule e: a trailing mark after a word not ending in s, x, z or in is plain", () => {
    expect(unsourcedQuotationIn(`Your plan’ ${FAB}’ is clear.`, ALL_SRC)).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------------------
// 2. QA5-B1, B2, B3 closed: fresh variants R23 must and does refuse, every flag state, rubber stamp.
// ---------------------------------------------------------------------------------------------------------
describe("2. R23 holds against fresh nesting, doubling, gluing, families and sentence shapes", () => {
  describe.each(STATES)("%s", (_state, flags) => {
    const posting = guardFor(flags)
    it.each([
      // nesting and doubling (QA5-B1 class)
      ["double around single", `Your plan to “‘${FAB}’” is clear.`],
      ["four deep, four families", `Your plan to «‹“‘${FAB}’”›» is clear.`],
      ["doubled straight doubles", `Your plan to ""${FAB}"" is clear.`],
      ["straight single inside straight double", `Your plan to "'${FAB}'" is clear.`],
      ["tripled corner brackets", `Your plan to 「「「${FAB}」」」 is clear.`],
      ["doubled halfwidth corners", `Your plan to ｢｢${FAB}｣｣ is clear.`],
      ["sourced shell, fabricated core (stored quote)", `Your plan to “halve “${FAB}” operational emissions by 2030” is clear.`],
      ["fabricated shell, sourced core", `Your plan to “${FAB} and “halve operational emissions by 2030”” is clear.`],
      ["sourced quote, then a fabricated one", `Your plan to “halve operational emissions by 2030” and “${FAB}” is clear.`],
      ["fabricated quote, then a sourced one", `Your plan to “${FAB}” and “halve operational emissions by 2030” is clear.`],
      ["real stored quote extended by fabricated words", `Your plan to “halve operational emissions by 2030 and ${FAB}” is clear.`],
      // gluing (QA5-B2 class)
      ["glued commas", `Your plan,“${FAB},”is clear.`],
      ["glued fullwidth singles", `Your plan＇${FAB}＇is clear.`],
      ["glued after a digit", `Your 2030'${FAB}'is clear.`],
      ["glued between digits", `Your aim of 5'${FAB}'5 is clear.`],
      ["after the one-letter word I", `Your plan I'${FAB}' is clear.`],
      ["name-mark look-alike with a lower-case word", `Your plan to O’${FAB}’ is clear.`],
      ["name mark then trailing closer", `Your plan to L'Double revenue within the decade' is clear.`],
      ["elision opener 'em then trailing closer", `Your plan to 'em ${FAB}' is clear.`],
      ["decade opener then trailing closer", `Your plan to '30s ${FAB}' is clear.`],
      ["n-unit closer", `Your plan to '${FAB} 'n' growth is clear.`],
      // families and look-alikes (QA5-B3 class)
      ["‹…› single guillemets", `Your plan to ‹${FAB}› is clear.`],
      ["⸢…⸣ half brackets", `Your plan to ⸢${FAB}⸣ is clear.`],
      ["〔…〕 tortoise shells", `Your plan to 〔${FAB}〕 is clear.`],
      ["﹝…﹞ small tortoise shells", `Your plan to ﹝${FAB}﹞ is clear.`],
      ["〖…〗 white lenticular", `Your plan to 〖${FAB}〗 is clear.`],
      ["🙶…🙷 astral sans-serif quotes", `Your plan to 🙶${FAB}🙷 is clear.`],
      ["‶…‷ reversed primes", `Your plan to ‶${FAB}‷ is clear.`],
      ["˝…˝ double acute", `Your plan to ˝${FAB}˝ is clear.`],
      ["｀…´ fullwidth grave and acute", `Your plan to ｀${FAB}´ is clear.`],
      ["❠…❟ low dingbat commas", `Your plan to ❠${FAB}❟ is clear.`],
      ["ʽ…ʾ modifier half rings", `Your plan to ʽ${FAB}ʾ is clear.`],
      ["Ꞌ…ꞌ saltillo, upper and lower", `Your plan to Ꞌ${FAB}ꞌ is clear.`],
      ["mixed: Pi opened, Ps closed", `Your plan to “${FAB}「 is clear.`],
      ["both marks the same left mark", `Your plan to “${FAB}“ is clear.`],
      // padding, digits, scripts
      ["NBSP padded", `Your plan to “\u00a0${FAB}\u00a0” is clear.`],
      ["ideographic-space padded", `Your plan to 「\u3000${FAB}\u3000」 is clear.`],
      ["Cyrillic о inside the words", `Your plan to “dоuble revenue within the decade” is clear.`],
      ["fullwidth letters", `Your plan to “ｄｏｕｂｌｅ revenue within the decade” is clear.`],
      ["ZWSP inside a word", `Your plan to “dou\u200bble revenue within the decade” is clear.`],
      ["hyphenated variant of a stored quote", `Your plan to “halve operational-emissions by 2030” is clear.`],
      ["combining mark on the opener", `Your plan to “\u0301${FAB}” is clear.`],
      ["ellipsis inside", `Your plan to “…${FAB}…” is clear.`],
      // sentences
      ["a quotation split by a sentence break", `Your plan to “Halve costs. Double revenue within the decade” is clear.`],
      ["a long sentence, quote at the end", `Having read the posting twice and spoken to two people who know the team well, and after reviewing the annual report, the sustainability report and the investor presentation, I can see your plan to “${FAB}” is clear.`],
      ["two sentences, the fabricated one second", `Your aim is “to halve operational emissions by 2030”. Your plan to “${FAB}” is clear.`],
      ["after an abbreviation that does not split", `Your plan, i.e. “${FAB}”, is clear.`],
    ])("%s: never stored, even rubber-stamped", (_name, frame) => {
      expect(quotedStored(frame, posting)).toBe(false)
    })
  })

  it("a cited fact's own quote marks around a fabricated span are checked as one envelope", () => {
    expect(unsourcedQuotationIn(`Won the "analyst of the year" award for the "${FAB}" models`, AWARD_SRC)).not.toBeNull()
  })
  it("a fabricated quote in summary, bullet and skills lines is never stored; the bullet falls back and the resume is valid", () => {
    for (const flags of STATES.map(([, f]) => f)) {
      const outcome = finish(
        resumeOf(
          [line(`Built wind farm financial models, “${FAB}” in spirit`, "WIND")],
          [line(`Won the ““analyst of the year”” award for “${FAB}” models`, "AWARD")],
          [line(`React, «${FAB}»`, "SK")]
        ),
        emptyLetter,
        { posting: guardFor(flags) }
      )
      expect(allText(outcome)).not.toContain("revenue within")
      expect(resumeTexts(outcome)).toContain(WORDING.get("AWARD"))
      expect(outcome.resumeValid).toBe(true)
    }
  })
  it("counted as `unsourced_quote` with no text", () => {
    const outcome = letterWith(`Your plan to «‹${FAB}›» is clear.`, guard([], false))
    expect(outcome.hardFails.unsourced_quote).toBeGreaterThan(0)
    expect(JSON.stringify(outcome.hardFails)).not.toMatch(/revenue|decade|«|‹/)
  })
  it("OBSERVATION (R19 token edges, caught downstream): an altered number inside a stored quote passes R19 but the number check drops it", () => {
    for (const frame of ["Your plan to “cut water use by $40 across the group” is clear.", "Your plan to “cut water use by -40% across the group” is clear."]) {
      expect(unsourcedQuotationIn(frame, QUOTES), frame).toBeNull()
      for (const flags of STATES.map(([, f]) => f)) expect(letterTexts(letterWith(frame, guardFor(flags))).join(" "), frame).not.toContain("cut water use")
    }
  })
})

// ---------------------------------------------------------------------------------------------------------
// 3. False positives: legitimate sentences still pass (fresh), costs C1-C6 behave as accepted, new costs pinned.
// ---------------------------------------------------------------------------------------------------------
describe("3. legitimate text", () => {
  it.each([
    ["I can’t wait to help."], ["We’d love that."], ["It’s Acme’s best model."], ["I’ve shipped O’Reilly’s app."], ["I led the ’22–’23 rollout."],
    ["I managed clients' accounts and partners' contracts."], ["Chris' team and Ross' project shipped."], ["I worked with O'Brien's team."],
    ["Dos and don'ts."], ["In the '20s and '30s we grew."], ["I worked with D'Angelo and O'Hara."], ["She’ll join; they’d agree; you’re right."],
    ["The firm’s 2020’s results improved."], ["I led the ‘90s revival."], ["Built the teams’ dashboards"], ["I left at 5 o'clock."],
  ])("an apostrophe, possessive, contraction, name or elision is not a quotation: %s", (text) => {
    expect(unsourcedQuotationIn(text, [])).toBeNull()
  })
  it.each([
    ["I won the “Analyst of the Year” award."],
    ["I won the 'analyst of the year' award."],
    ["I won the «analyst of the year» award."],
    ["I won the “analyst of the year.” award"],
    ["I won “analyst of the year.”"],
    ["I won the “analyst of the year”, an award."],
    ["I won the “analyst of the year” award—twice."],
    ["I won the “analyst of the year” award; it's my proudest moment."],
    ["I won the “analyst of the year” award (my manager's nomination)."],
    ["I won the “analyst of the year” award, the firm's top honour."],
    ["I won the “analyst of the year” award in ’21."],
    ["My team's work won the “analyst of the year” award."],
    ["The firm’s ‘analyst of the year’ award went to me."],
    ["I won the ‘analyst of the year’ award, which I’m proud of."],
    ["I won the “analyst of the year” award: “for the forecasting models”."],
  ])("quoting the cited fact passes: %s", (text) => {
    expect(unsourcedQuotationIn(text, AWARD_SRC)).toBeNull()
  })
  it("quoting a stored quote with a contraction elsewhere passes (direction on)", () => {
    expect(unsourcedQuotationIn("Your plan to “halve operational emissions by 2030” is clear, and it's bold.", QUOTES)).toBeNull()
  })
  it.each([
    ["Won the ““analyst of the year”” award for the forecasting models"],
    ["Won the 'analyst of the year' award for the teams' forecasting models"],
    ["Worked 9 o'clock to 5 o'clock shifts in Hawai'i and O'ahu"],
    ["Built “model ‘A’” and «model B» for clients"],
  ])("a fact's own wording passes whatever its marks (S0), so a bullet fallback never blocks: %s", (w) => {
    expect(unsourcedQuotationIn(w, [withHeading(w)])).toBeNull()
    const id = "SELF"
    const facts = new Map([...FACTS, [id, withHeading(w)]])
    const wording = new Map([...WORDING, [id, w]])
    const resume = resumeOf([], [line(`${w}, “${FAB}”`, id)])
    expect(fallBackToFactWording(resume, facts, wording, null, new Set(), guard([], false)).resume.experience[0]?.bullets.map((b) => b.text)).toEqual([w])
  })
  it("the accepted costs C1-C6 fail closed, one fresh row each", () => {
    const rows = [
      ["C1", "I won the “analyst of the year” award and the «forecasting models» prize."],
      ["C2", "In the ’80s I won the “analyst of the year” award."],
      ["C3", "I won the “analyst of the year” award for the analysts' models."],
      ["C4", "I worked with D'Arcy on the analysts' models."],
      ["C5", "I won the “ analyst of the year ” award."],
      // R24 (Part B) moved this row here from the must-pass table: the outer mark attaches to outside text
      // through a dash, so L4 refuses it (C5, widened).
      ["C5", "Rated “analyst of the year”—the top award."],
      ["C6", "With D'Arcy I won the “analyst of the year” award."],
    ] as const
    for (const [cost, text] of rows) expect(unsourcedQuotationIn(text, AWARD_SRC), `${cost}: ${text}`).not.toBeNull()
  })
  // QA6-M1 (minor, not in C1-C6): two in-word apostrophes with no contraction tail (rule d) in one sentence are
  // both active (each can open and close), so the text between them is an envelope. Ordinary prose fails closed.
  // The cost is one sentence or one tailored line; a bullet falls back (S0, see above), so nothing blocks.
  it.each([
    ["From 9 o'clock to 5 o'clock I modelled."],
    ["I built models in Hawai'i and O'ahu."],
    ["Thank y'all, ma'am."],
  ])("QA6-M1 fixed by R24 rule b′: %s passes", (text) => {
    expect(unsourcedQuotationIn(text, AWARD_SRC)).toBeNull()
  })
  it.each([["I contributed to Acme Corp.'s growth."], ["I supported the U.S.'s largest wind farm."]])(
    "OBSERVATION (cost unchanged from R22): a possessive after a full stop is a lone plain mark: %s",
    (text) => {
      expect(unsourcedQuotationIn(text, [])).not.toBeNull()
    }
  )
  it("a letter that quotes the cited fact is stored end to end under a rubber stamp, both flags off", () => {
    const outcome = letterWith("I won the ‘analyst of the year’ award, which I’m proud of.", guard([], false))
    expect(letterTexts(outcome).join(" ")).toContain("‘analyst of the year’")
  })
})

// ---------------------------------------------------------------------------------------------------------
// 4. Rubber-stamp judge, every flag state, fresh adversarial draft; then regressions with fresh inputs.
// ---------------------------------------------------------------------------------------------------------
describe("4. rubber-stamp judge and regressions", () => {
  const RESUME = resumeOf(
    [line("Built wind farm financial models for offshore projects with Snowflake", "WIND"), line("Built wind farm financial models, «‹the finest in the North Sea›»", "WIND")],
    [
      line("Mentored 14 junior developers", "MENT"),
      line("Built carbon accounting models for offshore wind farm projects", "WIND"),
      line("Spearheaded the payments migration", "PAY"),
    ]
  )
  const LETTER = letterOf(
    line(`Your plan to 〖${FAB}〗 is clear. ${WIND_SENTENCE}`, "WIND"),
    line("Your plan to “halve operational emissions by 2030” is clear. My wind farm financial models are achieving it.", "WIND"),
    MENT_P
  )
  const BAD = ["Snowflake", "finest", "14 junior", "carbon accounting models", "Spearheaded", "revenue within", "achieving it"]
  it.each(STATES)("%s: no hard-fail class is stored, none reaches the judge, both documents valid", (_name, flags) => {
    const outcome = finish(RESUME, LETTER, { posting: guardFor(flags) })
    const text = allText(outcome)
    for (const bad of BAD) expect(text, bad).not.toContain(bad)
    expect(outcome.resumeValid).toBe(true)
    expect(outcome.letterValid).toBe(true)
    for (const bad of ["Snowflake", "finest", "14 junior", "revenue within"]) expect(outcome.sent.join(" | "), bad).not.toContain(bad)
  })
  it.each(STATES)("%s: a judge that fails or refuses stores only fact wording in the resume (R8 Spearheaded falls back)", (_name, flags) => {
    for (const options of [{ judge: REFUSE_ALL }, { judgeFails: true }] as const) {
      const outcome = finish(RESUME, LETTER, { posting: guardFor(flags), ...options })
      const wordings = new Set([...WORDING.values()].map(norm))
      for (const text of resumeTexts(outcome)) expect(wordings.has(norm(text)), text).toBe(true)
      expect(allText(outcome)).not.toContain("Spearheaded")
    }
  })
  it("QA3-B1 / R17: the cap trims a judged paragraph to a re-failing sentence; it drops and the letter stays valid", () => {
    const forms = ["login", "billing", "invoice"].map((n) => line(`I tested React ${n} forms.`, "QA"))
    const outcome = finish(emptyResume, letterOf(...forms, line("I tested React refund forms with Jest. I ran regression suites.", "QA")), { keywords: REACT })
    expect(outcome.letterValid).toBe(true)
    expect(letterTexts(outcome).join(" ")).not.toContain("I ran regression suites")
    expect(outcome.settled.paragraphsDropped).toBe(1)
  })
  it("QA3-M1: a cap that leaves only a stored-quote sentence drops it (direction on)", () => {
    const p = line("I tested React audit forms. Your plan to “halve operational emissions by 2030” is clear.", "QA")
    const outcome = finish(emptyResume, letterOf(...["d", "e", "f"].map((n) => line(`I tested React ${n} forms.`, "QA")), p), { keywords: REACT })
    expect(letterTexts(outcome).join(" ")).not.toContain("halve operational")
    expect(outcome.letterValid).toBe(true)
  })
  it.each([["met"], ["surpassed"], ["Fulfilling"], ["delivering on"]])("QA3-B2 / R20 (direction on): '%s' after a stored quote is never stored", (word) => {
    const outcome = finish(emptyResume, letterOf(line(`Your plan to “halve operational emissions by 2030” is clear. My wind farm financial models ${word} it.`, "WIND"), MENT_P), { posting: guard() })
    expect(letterTexts(outcome).join(" ")).not.toContain(`${word} it`)
  })
  it("R20 leaves ordinary words alone", () => {
    for (const word of ["hitch", "realm", "deliverable", "meteor"]) expect(completionWordIn(`the ${word} list`), word).toBeNull()
  })
  it("QA3-B3 / R18 / R21 headline classes stay null; whole matches print", () => {
    for (const title of ["Sustainability Consultant Apprentice", "Assistant to the Sustainability Consultant", "Sustainability Consultant (Placement)", "Trainee Sustainability Consultant", "Sustainability Consultant / Analyst"]) {
      expect(headlineFor("Sustainability Consultant", [title]), title).toBeNull()
    }
    expect(headlineFor("Sustainability Consultant", ["Senior Sustainability Consultant"])).toBe("Sustainability Consultant")
    expect(headlineFor("Sustainability Consultant", ["Sustainability Consultant (2019–2022)"])).toBe("Sustainability Consultant")
  })
  it("R12: two titles never combine", () => {
    expect(headlineFor("Sustainability Consultant", ["Sustainability Lead", "Carbon Consultant"])).toBeNull()
  })
  it("R10: a posting name in lower case never stores, even rubber-stamped", () => {
    const outcome = finish(resumeOf([line("Built wind farm financial models for offshore projects in power bi", "WIND")]), emptyLetter)
    expect(allText(outcome).toLowerCase()).not.toContain("power bi")
  })
  it("R13: two refused rewords of one fact collapse to one fact wording", () => {
    const outcome = finish(resumeOf([], [line("Engineered wind farm financial models", "WIND"), line("Crafted wind farm financial models", "WIND")]), emptyLetter, { judge: REFUSE_ALL })
    expect(resumeTexts(outcome)).toEqual([WORDING.get("WIND")])
  })
  it("R14: four Jest paragraphs keep three and stay valid", () => {
    const outcome = finish(emptyResume, letterOf(...["p", "q", "r", "s"].map((n) => line(`I tested the ${n} module with Jest.`, "QA"))), { keywords: JEST })
    expect(letterTexts(outcome)).toHaveLength(3)
    expect(outcome.letterValid).toBe(true)
  })
  it("R16: judge down, a reworded paragraph plus a 〖…〗 unsourced quote is a claim block, not a provider error", () => {
    const outcome = finish(emptyResume, letterOf(line("I produced offshore wind farm forecasting models.", "WIND"), line("Peers called me 〖the spreadsheet sage〗.", "WIND")), { judgeFails: true })
    expect(outcome.letterValid).toBe(false)
    expect(outcome.providerError).toBe(false)
  })
  it("QA3-M2: whole-fact 'I' sentences stay mechanical with the judge down", () => {
    const p = line("I wrote Jest tests for search. I wrote Jest tests for the cart.", "J3", "J2")
    const outcome = finish(emptyResume, letterOf(p), { judgeFails: true })
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
