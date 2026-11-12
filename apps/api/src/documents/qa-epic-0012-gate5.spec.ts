/**
 * EPIC-0012 QA gate 5 (after owner-approved repair wave 4: R21 whole-title headline, R22 quote marks by class).
 * Adversarial unit tests by an independent QA session. Test files only; no product code changed. Report:
 * epics/active/EPIC-0012-tailoring-rules/test-plan.r5.md.
 *
 * Convention, as in the gate-1 to 4 specs: `it` asserts behaviour the candidate shows and the design requires.
 * `it.fails` asserts REQUIRED behaviour the candidate does not show: each one is a blocker QA5-Bn in the report, and
 * it turns red when the defect is fixed (then it becomes `it`). "OBSERVATION" tests pin a class the design accepts
 * or leaves to the judge; they pass today.
 *
 * The judge is a plain function (rubber stamp = `() => true`), not a model. `finish` is the gate-4 helper,
 * unchanged: it replays documents.service.ts generate() in the service's order (hard fails, judge, fallback,
 * sentence drop, A6, R14 cap, R17 settle, density repair, validation, R16). Fresh inputs only: no row repeats a
 * gate-4 input.
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
import { completionWordIn, unsourcedQuotationIn } from "./company-direction.js"
import { headlineDecision, headlineFor } from "./headline.js"
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


// ---------------------------------------------------------------------------------------------------------
// 1. QA4-B1 / QA4-B2 (R21): the whole profile title, or nothing. Fresh inputs; both flags off (no flag gates it).
// ---------------------------------------------------------------------------------------------------------
describe("1. R21 headline: a title the Candidate never held never prints", () => {
  const PM = "Product Manager"
  it.each([
    // an extra word
    ["Product Manager Payments"],
    ["Product Manager Shadow"],
    ["Product Manager Student"],
    ["Former Product Manager"],
    // a bracket qualifier
    ["Product Manager (Acting)"],
    ["Product Manager (contract)"],
    ["Product Manager (Volunteer)"],
    ["Product Manager（Intern）"],
    ["Product Manager{Intern}"],
    ["Product Manager <Trainee>"],
    ["Product Manager (2020) (Intern)"],
    // a separated qualifier
    ["Product Manager — Trainee"],
    ["Product Manager · Intern"],
    ["Product Manager: Placement"],
    ["Product Manager ~ Intern"],
    ["Product Manager/Intern"],
    ["Product Manager｜Intern"],
    ["Product Manager\tIntern"],
    ["Product Manager — Intern 2021"],
    ["Product Manager (Jan 2020 – present) – Intern"],
    ["Product Manager 2020, Apprentice"],
    // a relation phrase
    ["Product Manager to be"],
    ["Product Manager in Training"],
    ["Product Manager-in-waiting"],
    ["Executive Assistant for the Product Manager"],
    ["Analyst under the Product Manager"],
    ["Secretary to the Product Manager"],
    ["Coordinator supporting Product Manager"],
    // a multi-title entry
    ["Intern → Product Manager"],
    ["Product Manager (Intern) → Product Manager"],
    ["Analyst; Product Manager"],
    ["Lead/Product Manager"],
    ["Product Manager & Product Owner"],
    // a step up in front
    ["Associate Product Manager"],
    ["Senior Associate Product Manager"],
    ["Lead Associate Product Manager"],
    ["Trainee Product Manager"],
    ["Deputy Product Manager"],
    ["Junior Product Manager"],
    ["Jr. Product Manager"],
  ])("'%s' never yields 'Product Manager'", (title) => {
    expect(headlineFor(PM, [title])).toBeNull()
  })

  it.each([
    ["PRODUCT MANAGER"],
    ["product-manager"],
    ["Product  Manager."],
    ["Product Manager;"],
    ["ProductManager"],
    ["Product Managers"],
    ["Sr. Product Manager"],
    ["Staff Product Manager"],
    ["Principal Product Manager"],
    ["Lead Senior Product Manager"],
    ["Product Manager (2019 – 2021)"],
    ["Product Manager, 2019–2021"],
    ["Product Manager III"],
    ["Product Manager (Jan 2020 – present)"],
    ["Product Manager | 2020"],
    ["Product Manager until 2021"],
    ["Product Manager (2020 to date)"],
    ["Product Manager — 2021"],
    ["Senior Product Manager (2019–2021)"],
  ])("'%s' prints 'Product Manager' (a real whole-title match)", (title) => {
    expect(headlineFor(PM, [title])).toBe(PM)
  })

  it("'junior' is not a step-down word, but a junior title matches a junior posting whole (jr maps to junior)", () => {
    expect(headlineFor("Data Engineer", ["Junior Data Engineer"])).toBeNull()
    expect(headlineFor("Data Engineer", ["Jr Data Engineer"])).toBeNull()
    expect(headlineFor("Junior Data Engineer", ["Jr Data Engineer"])).toBe("Junior Data Engineer")
    expect(headlineFor("Junior Data Engineer", ["Junior Data Engineer (2022–2024)"])).toBe("Junior Data Engineer")
    expect(headlineFor("Senior Data Engineer", ["Junior Data Engineer"])).toBeNull()
    expect(headlineFor("Senior Data Engineer", ["Data Engineer"])).toBeNull()
  })

  it("other titles: a step-down word only in front, never a vice/assistant/elect qualifier", () => {
    expect(headlineFor("Principal", ["Vice Principal"])).toBeNull()
    expect(headlineFor("Principal", ["Assistant Principal"])).toBeNull()
    expect(headlineFor("Head of Tax", ["Head of Tax Elect"])).toBeNull()
    expect(headlineFor("Head of Tax", ["Head of Tax-designate"])).toBeNull()
    expect(headlineFor("Head of Tax", ["Ex-Head of Tax"])).toBeNull()
    expect(headlineFor("Head of Tax", ["Model UN Head of Tax"])).toBeNull()
    expect(headlineFor("Lead", ["Team Lead"])).toBeNull()
    expect(headlineFor("Senior Engineer", ["Senior Engineer Intern"])).toBeNull()
    expect(headlineFor("Senior Engineer", ["Lead Senior Engineer"])).toBe("Senior Engineer")
  })

  it("several profile entries: one entry that is the title whole prints; entries never combine", () => {
    expect(headlineFor(PM, ["Intern", "Product Manager"])).toBe(PM)
    expect(headlineFor(PM, ["Product Manager Intern", "Product Analyst"])).toBeNull()
    expect(headlineFor(PM, ["Product Owner", "Engineering Manager"])).toBeNull()
  })

  it("approved alternates: unsplit and uncut, the same whole-title test (3h)", () => {
    expect(headlineFor(PM, ["Platform Analyst"], ["Senior Product Manager"])).toBe(PM)
    expect(headlineFor(PM, ["Platform Analyst"], ["Product Manager Intern"])).toBeNull()
    expect(headlineFor(PM, ["Platform Analyst"], ["Associate Product Manager"])).toBeNull()
    expect(headlineFor(PM, ["Platform Analyst"], ["Analyst / Product Manager"])).toBeNull()
    expect(headlineFor(PM, ["Platform Analyst"], ["Junior Product Manager"])).toBeNull()
    expect(headlineFor("Head of Sales & Marketing", ["Platform Analyst"], ["Head of Sales & Marketing"])).toBe("Head of Sales & Marketing")
    expect(headlineFor("Head of Sales & Marketing", ["Head of Sales & Marketing"])).toBeNull() // posting-title segment rule unchanged
  })

  it("log count (`missing`): meaningful posting words no single segment states; zero whenever it prints", () => {
    expect(headlineDecision(PM, ["Platform Analyst"])).toEqual({ headline: null, missing: 2 })
    expect(headlineDecision(PM, ["Product Analyst"])).toEqual({ headline: null, missing: 1 })
    expect(headlineDecision(PM, ["Senior Product Manager"])).toEqual({ headline: PM, missing: 0 })
    expect(headlineDecision(null, ["Product Manager"])).toEqual({ headline: null, missing: 0 })
    // OBSERVATION (R21 design: missing is taken per segment, without any cut): a qualifier entry counts zero
    // missing words, so the `documents.headline_unsupported` line (fired only when missing > 0) stays silent.
    expect(headlineDecision(PM, ["Product Manager (Intern)"])).toEqual({ headline: null, missing: 0 })
    expect(headlineDecision(PM, ["Product Manager Intern"])).toEqual({ headline: null, missing: 0 })
  })

  // OBSERVATION: false closes R21 accepts (fail closed, never a wrong title). Pinned so a later change is seen.
  it.each([
    ["Product Manager for Payments"],
    ["Product Manager, Payments"],
    ["Product Manager @ Acme"],
    ["Product Manager (part time)"],
    ["Product Manager (4 months)"],
    ["Product Manager to date"],
    ["Product Manager from Jan 2020 to Mar 2021"],
    ["Product Manager / Senior Product Manager"],
  ])("OBSERVATION (R21 accepted cost): '%s' prints nothing", (title) => {
    expect(headlineFor(PM, [title])).toBeNull()
  })
  it("OBSERVATION: a period word in brackets is dropped as a period segment (harmless: it states no title)", () => {
    expect(headlineFor(PM, ["Product Manager (May)"])).toBe(PM)
    expect(headlineFor(PM, ["Product Manager (now)"])).toBe(PM)
  })
})

// ---------------------------------------------------------------------------------------------------------
// 2. QA4-B3 (R22): quote marks by class. Fresh mark styles, orientations and contexts, every flag state.
// ---------------------------------------------------------------------------------------------------------
describe("2. R22 quotation marks", () => {
  const FAB = "double revenue within the decade"
  const letterWith = (frame: string, posting: PostingGuard, judge: Judge = RUBBER_STAMP) =>
    finish(emptyResume, letterOf(line(`${frame} ${WIND_SENTENCE}`, "WIND"), MENT_P), { posting, judge })
  const quotedStored = (frame: string, posting: PostingGuard) => letterTexts(letterWith(frame, posting)).join(" ").toLowerCase().includes("revenue within")

  describe.each(STATES)("%s", (_state, flags) => {
    const posting = guardFor(flags)
    it.each([
      ["‚…‘ (German single low-high)", `Your plan to ‚${FAB}‘ is clear.`],
      ["‛…’ (reversed-9 single)", `Your plan to ‛${FAB}’ is clear.`],
      ["’…‘ (single, both reversed)", `Your plan to ’${FAB}‘ is clear.`],
      ["'…’ (straight opened, curly closed)", `Your plan to '${FAB}’ is clear.`],
      ["“…' (paired opened, single closed)", `Your plan to “${FAB}' is clear.`],
      ["′…′ (primes)", `Your plan to ′${FAB}′ is clear.`],
      ["´…´ (acute accents)", `Your plan to ´${FAB}´ is clear.`],
      ["＇…＇ (fullwidth single)", `Your plan to ＇${FAB}＇ is clear.`],
      ["ʼ…ʼ (modifier apostrophe)", `Your plan to ʼ${FAB}ʼ is clear.`],
      ["ʻ…ʻ (turned comma)", `Your plan to ʻ${FAB}ʻ is clear.`],
      ["`…` (backticks)", `Your plan to \`${FAB}\` is clear.`],
      ["‟…” (reversed-9 double)", `Your plan to ‟${FAB}” is clear.`],
      ["〝…〟 (CJK double prime)", `Your plan to 〝${FAB}〟 is clear.`],
      ["『…』 (white corner brackets)", `Your plan to 『${FAB}』 is clear.`],
      ["﹁…﹂ (vertical corner brackets)", `Your plan to ﹁${FAB}﹂ is clear.`],
      ["＂…＂ (fullwidth double)", `Your plan to ＂${FAB}＂ is clear.`],
      ["''…'' (doubled straight singles)", `Your plan to ''${FAB}'' is clear.`],
      ["after an em dash", `Your plan—'${FAB}'—is clear.`],
      ["after an ellipsis", `Your plan…'${FAB}'… is clear.`],
      ["after a slash", `Your plan/'${FAB}'/ is clear.`],
      ["after a colon, closing the sentence", `Your plan:‘${FAB}’.`],
      ["holding a plural possessive", `Your plan to 'double the teams' revenue within the decade' is clear.`],
      ["holding a possessive near the end", `Your plan to 'double revenue within the decade's end' is clear.`],
      ["ending in a full stop inside the mark", `Your plan to '${FAB}.' It is clear.`],
      ["a sourced span then an unsourced one", `Your 'analyst of the year' plan to '${FAB}' is clear.`],
      ["unbalanced curly single", `Your plan to ‘${FAB} is clear.`],
      ["three paired marks", `Your plan to «${FAB}» » is clear.`],
      ["opened by an elision word but closed", `Your plan to 'Twas ${FAB}' is clear.`],
    ])("%s: never stored, even rubber-stamped", (_name, frame) => {
      expect(quotedStored(frame, posting)).toBe(false)
    })
  })

  // QA5-B1. Paired marks pair strictly in order (company-direction.ts:217-224). Two adjacent paired marks, as in a
  // doubled or nested quotation, pair with each other into EMPTY spans, which `unsourcedQuotationIn` skips
  // (company-direction.ts:169). The real quotation sits between mark 2 and mark 3 and is never checked. R22's
  // stated cost ("a nested quotation … is read as the outer text, which is then usually unsourced") does not hold.
  describe.each(STATES)("%s", (_state, flags) => {
    const posting = guardFor(flags)
    it.each([
      ["““…”” (doubled curly)", `Your plan to ““${FAB}”” is clear.`],
      ["«“…”» (nested, two families)", `Your plan to «“${FAB}”» is clear.`],
      ["\"“…”\" (straight around curly)", `Your plan to "“${FAB}”" is clear.`],
      ["“ “…” ” (doubled, spaced)", `Your plan to “ “${FAB}” ” is clear.`],
      ["„„…““ (doubled German)", `Your plan to „„${FAB}““ is clear.`],
    ])("BLOCKER QA5-B1: %s is never stored", (_name, frame) => {
      expect(quotedStored(frame, posting)).toBe(false)
    })
  })
  it("BLOCKER QA5-B1: a fabricated quotation nested inside a sourced one is never stored (both flags off)", () => {
    // marks 1-2 hold "analyst of the year " and 3-4 hold " award": both are runs of the cited AWARD fact
    const frame = `I won the “analyst of the year “${FAB}” award” too.`
    expect(unsourcedQuotationIn(frame, [FACTS.get("AWARD")!])).not.toBeNull()
  })

  // QA5-B2. Single marks by context (company-direction.ts:269-290). A mark between two letters that is not a
  // contraction is a soft opener, and a soft opener with no closer is ignored (:254-257). When BOTH marks of a
  // quotation touch a letter on each side, both are soft openers, so neither closes and the span is never read.
  // A mark after a one-letter word is an apostrophe (:289, for l'Oréal), so a quotation opened right after "a",
  // "d" or "l" is skipped too, and its closer has no opener.
  describe.each(STATES)("%s", (_state, flags) => {
    const posting = guardFor(flags)
    it.each([
      ["straight marks glued on both sides", `Your plan'${FAB}'is clear.`],
      ["right single marks glued on both sides", `Your plan’${FAB}’is clear.`],
      ["opened after the one-letter word 'a'", `Your plan is a'${FAB}' goal.`],
      ["opened after the one-letter word 'l'", `Your plan l’${FAB}’ is clear.`],
    ])("BLOCKER QA5-B2: %s is never stored", (_name, frame) => {
      expect(quotedStored(frame, posting)).toBe(false)
    })
  })

  // QA5-B3. R22 lists the paired marks as a closed set (company-direction.ts:180). Quotation marks outside it are
  // not marks at all, so the span is never read: the halfwidth corner brackets ｢｣ (the same marks as 「」, which
  // gate 4 named), the dingbat quotes ❝❞ ❛❜, CJK angle and title brackets 〈〉 《》, the modifier double apostrophe
  // ˮ, the ditto mark 〃 and the double low-reversed-9 ⹂.
  describe.each(STATES)("%s", (_state, flags) => {
    const posting = guardFor(flags)
    it.each([
      ["｢…｣ (halfwidth corner brackets)", `Your plan to ｢${FAB}｣ is clear.`],
      ["❝…❞ (dingbat double)", `Your plan to ❝${FAB}❞ is clear.`],
      ["❛…❜ (dingbat single)", `Your plan to ❛${FAB}❜ is clear.`],
      ["〈…〉 (CJK angle brackets)", `Your plan to 〈${FAB}〉 is clear.`],
      ["《…》 (CJK title brackets)", `Your plan to 《${FAB}》 is clear.`],
      ["ˮ…ˮ (modifier double apostrophe)", `Your plan to ˮ${FAB}ˮ is clear.`],
      ["〃…〃 (ditto marks)", `Your plan to 〃${FAB}〃 is clear.`],
      ["⹂…⹂ (double low-reversed-9)", `Your plan to ⹂${FAB}⹂ is clear.`],
    ])("BLOCKER QA5-B3: %s is never stored", (_name, frame) => {
      expect(quotedStored(frame, posting)).toBe(false)
    })
  })

  it("resume lines in new mark styles: summary, bullet and skills quotes are never stored, every flag state", () => {
    for (const flags of STATES.map(([, f]) => f)) {
      const outcome = finish(
        resumeOf(
          [line("Built wind farm financial models, called ‚world class‘", "WIND")],
          [line("Built wind farm financial models for offshore projects, 『the region’s finest』", "WIND")],
          [line("React, ′TypeScript guru′", "SK")]
        ),
        emptyLetter,
        { posting: guardFor(flags) }
      )
      expect(allText(outcome)).not.toContain("world class")
      expect(allText(outcome)).not.toContain("finest")
      expect(allText(outcome)).not.toContain("guru")
    }
  })

  it("counted as `unsourced_quote`, never as text", () => {
    const outcome = letterWith(`Your plan to ‚${FAB}‘ is clear.`, guard([], false))
    expect(outcome.hardFails.unsourced_quote).toBeGreaterThan(0)
    expect(JSON.stringify(outcome.hardFails)).not.toMatch(/revenue|decade|‚/)
  })

  describe("legitimate text still passes", () => {
    it.each([
      ["We'll"], ["They're ready."], ["I'd like to help."], ["Yes, ma'am."], ["See y'all."], ["I worked at McDonald's."], ["Jones' report was clear."],
      ["James’ team shipped it."], ["The ’80s were busy."], ["The class of '09 met."], ["The ’19 cohort graduated."], ["I love rock’n’roll."], ["It isn’t the team’s model."],
      ["O’Neill and I met."], ["I couldn't've done it alone."], ["The 5' cable."],
    ])("an apostrophe, possessive, contraction or elision is not a quotation: %s", (text) => {
      expect(unsourcedQuotationIn(text, [])).toBeNull()
    })
    it("a cited fact's own quotation passes in the new mark styles", () => {
      for (const text of ["I was named ‛analyst of the year’.", "I was named 『analyst of the year』.", "I was named 〝Analyst of the Year〞.", "I was named ‚analyst of the year‘.", "I was named ’analyst of the year’."]) {
        expect(unsourcedQuotationIn(text, [FACTS.get("AWARD")!]), text).toBeNull()
      }
    })
    it("a resume bullet quoting the cited fact in ‚…‘ is stored under a rubber stamp", () => {
      const text = "Won the ‚analyst of the year‘ award for the forecasting models"
      const outcome = finish(resumeOf([], [line(text, "AWARD")]), emptyLetter, { posting: guard([], false) })
      expect(resumeTexts(outcome)).toContain(text)
    })
    it("direction on: a stored quote in „…”, ”…” or »…« is a source (R19 passes)", () => {
      for (const frame of ["Your plan to „cut water use by 40% across the group” is clear.", "Your plan to ”cut water use by 40% across the group” is clear.", "Your plan to »cut water use by 40% across the group« is clear."]) {
        expect(unsourcedQuotationIn(frame, QUOTES), frame).toBeNull()
      }
    })
    it("direction on: a stored quote in “…” passes and is stored end to end (control)", () => {
      const outcome = letterWith("Your plan to “cut water use by 40% across the group” is clear.", guard())
      expect(letterTexts(outcome).join(" ")).toContain("cut water use by 40% across the group")
    })
  })

  it("OBSERVATION (R22 accepted cost): a stored quote in an unusual mark passes R19 but is not stripped, so its words are claims and it drops", () => {
    const outcome = letterWith("Your plan to »cut water use by 40% across the group« is clear.", guard())
    expect(letterTexts(outcome).join(" ")).not.toContain("40%")
  })
  it("OBSERVATION (R23 loosens R22): rock 'n' roll is not a quotation", () => {
    expect(unsourcedQuotationIn("I like rock 'n' roll.", [FACTS.get("AWARD")!])).toBeNull()
  })
  it.each([
    ["a quote and a later plural possessive", "I won the 'Analyst of the Year' and the teams' award."],
    ["a contraction with a left mark", "I‘m proud of the models."],
  ])("OBSERVATION (R23 accepted cost, fail closed): %s is read as unbalanced", (_name, text) => {
    expect(unsourcedQuotationIn(text, [FACTS.get("AWARD")!])).not.toBeNull()
  })
  it.each([
    ["'tis", `Your plan to 'tis ${FAB} is clear.`],
    ["'cause", `Your plan to 'cause ${FAB} is clear.`],
    ["'20 (two digits)", "Your plan to '20 percent growth is clear."],
  ])("OBSERVATION (R22 elisions): an unclosed mark before %s is not a quotation (no closing mark, nothing is quoted)", (_name, text) => {
    expect(unsourcedQuotationIn(text, [])).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------------------
// 3. A judge that approves everything, in each flag state (fresh adversarial draft).
// ---------------------------------------------------------------------------------------------------------
describe("3. rubber-stamp judge in every flag state", () => {
  const RESUME = resumeOf(
    [line("Built wind farm financial models for offshore projects in Tableau", "WIND"), line("Built wind farm financial models, ‚the sharpest in Europe‘", "WIND")],
    [
      line("Mentored 9 junior developers", "MENT"),
      line("Built carbon accounting wind farm financial models", "WIND"),
      // judge only: "energy analyst" is not the posting's role noun, so code does not stop it (design 2.3)
      line("Built wind farm financial models for offshore projects as an energy analyst", "WIND"),
    ]
  )
  const LETTER = letterOf(
    line(`Your plan to 〝double revenue within the decade〞 is clear. ${WIND_SENTENCE}`, "WIND"),
    line("Your plan to “cut water use by 40% across the group” is clear. My wind farm financial models are reaching it.", "WIND"),
    MENT_P
  )
  const BAD = ["Tableau", "sharpest", "9 junior", "carbon accounting wind", "double revenue", "reaching it"]
  it.each(STATES)("%s: no hard-fail class is stored, and none reaches the judge", (_name, flags) => {
    const outcome = finish(RESUME, LETTER, { posting: guardFor(flags) })
    const text = allText(outcome)
    for (const bad of BAD) expect(text, bad).not.toContain(bad)
    expect(outcome.resumeValid).toBe(true)
    expect(outcome.letterValid).toBe(true)
    for (const bad of ["Tableau", "sharpest", "9 junior", "double revenue"]) expect(outcome.sent.join(" | "), bad).not.toContain(bad)
  })
  it.each(STATES)("%s: a judge that fails or refuses stores only fact wording in the resume", (_name, flags) => {
    for (const options of [{ judge: REFUSE_ALL }, { judgeFails: true }] as const) {
      const outcome = finish(RESUME, LETTER, { posting: guardFor(flags), ...options })
      const wordings = new Set([...WORDING.values()].map(norm))
      for (const text of resumeTexts(outcome)) expect(wordings.has(norm(text)), text).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------------------------------------
// 4. Regressions: QA3-B1..B4, M1, M2, QA2-B1..B8 and R8..R20, fresh inputs.
// ---------------------------------------------------------------------------------------------------------
describe("4. regressions (fresh inputs)", () => {
  it("QA3-B1 / R17: a judged paragraph the cap trims to a re-failing sentence is dropped, the letter stays valid", () => {
    const forms = ["profile", "search", "export"].map((n) => line(`I tested React ${n} forms.`, "QA"))
    const outcome = finish(emptyResume, letterOf(...forms, line("I tested React upload forms with Jest. I ran regression suites.", "QA")), { keywords: REACT })
    expect(outcome.letterValid).toBe(true)
    expect(letterTexts(outcome).join(" ")).not.toContain("I ran regression suites")
    expect(outcome.settled.paragraphsDropped).toBe(1)
  })
  it("QA3-M1: a cap that leaves only a stored quote sentence drops the paragraph (direction on)", () => {
    const p = line("I tested React history forms. Your plan to “cut water use by 40% across the group” is clear.", "QA")
    const outcome = finish(emptyResume, letterOf(...["a", "b", "c"].map((n) => line(`I tested React ${n} forms.`, "QA")), p), { keywords: REACT })
    expect(letterTexts(outcome).join(" ")).not.toContain("cut water use")
    expect(outcome.letterValid).toBe(true)
  })
  it.each([["reached"], ["realised"], ["fulfilled"], ["exceeded"], ["Accomplishing"]])("QA3-B2 / R20 (direction on): '%s' after a stored quote is never stored", (word) => {
    const frame = `Your plan to “cut water use by 40% across the group” is clear. My wind farm financial models ${word} it.`
    const outcome = letterWith2(frame)
    expect(letterTexts(outcome).join(" ")).not.toContain(`${word} it`)
  })
  it("R20 does not reach ordinary words", () => {
    for (const word of ["reachable", "meetup", "deliverables", "completeness", "achiever"]) expect(completionWordIn(`the ${word} list`), word).toBeNull()
  })
  it("QA3-B3 / R18 classes stay null under R21", () => {
    for (const title of ["PA to the Sustainability Consultant", "Analyst reporting to the Sustainability Consultant", "Sustainability Consultant Intern 2024", "Acting Sustainability Consultant"]) {
      expect(headlineFor("Sustainability Consultant", [title]), title).toBeNull()
    }
  })
  it("R8: a scope-upgrade verb for 'Supported…' never stores when refused", () => {
    for (const text of ["Directed the payments migration", "Owned the payments migration", "Drove the payments migration"]) {
      const outcome = finish(resumeOf([], [line(text, "PAY")]), emptyLetter, { judge: REFUSE_ALL })
      expect(resumeTexts(outcome)).toEqual([WORDING.get("PAY")])
    }
  })
  it("R10: a posting name in an odd case never stores, even rubber-stamped", () => {
    for (const text of ["Built wind farm financial models for offshore projects in SnowFlake", "Built wind farm financial models for offshore projects with workiva"]) {
      const outcome = finish(resumeOf([line(text, "WIND")]), emptyLetter)
      expect(allText(outcome)).not.toContain(text)
    }
  })
  it("R12: two profile titles never combine", () => {
    expect(headlineFor("Sustainability Consultant", ["Sustainability Analyst", "Energy Consultant"])).toBeNull()
  })
  it("R13: two refused rewords of one fact collapse to one fact wording", () => {
    const outcome = finish(resumeOf([], [line("Designed wind farm financial models", "WIND"), line("Authored wind farm financial models", "WIND")]), emptyLetter, { judge: REFUSE_ALL })
    expect(resumeTexts(outcome)).toEqual([WORDING.get("WIND")])
  })
  it("R14: four one-sentence Jest paragraphs keep three mentions and stay valid", () => {
    const outcome = finish(emptyResume, letterOf(...["w", "x", "y", "z"].map((n) => line(`I tested the ${n} screen with Jest.`, "QA"))), { keywords: JEST })
    expect(letterTexts(outcome)).toHaveLength(3)
    expect(outcome.letterValid).toBe(true)
  })
  it("R15: a verdict carries only on the same text and the same fact ids", () => {
    expect(meaningKey("I built models.", ["WIND"])).not.toBe(meaningKey("I built models.", ["WIND", "MENT"]))
  })
  it("R16: judge down, a reworded paragraph plus a ‚…‘ unsourced quote paragraph is a claim block, not a provider error", () => {
    const outcome = finish(emptyResume, letterOf(line("I produced offshore wind farm financial models.", "WIND"), line("Colleagues called me ‚the model whisperer‘.", "WIND")), { judgeFails: true })
    expect(outcome.letterValid).toBe(false)
    expect(outcome.providerError).toBe(false)
  })
  it("QA3-M2: 'I' + whole-fact sentences after '?' and ';' stay mechanical with the judge down", () => {
    const p = line("I wrote Jest tests for the checkout. I wrote Jest tests for the cart.", "J1", "J2")
    const outcome = finish(emptyResume, letterOf(p), { judgeFails: true })
    expect(outcome.letterValid).toBe(true)
    expect(letterTexts(outcome)).toEqual([p.text])
  })
})

function letterWith2(frame: string) {
  return finish(emptyResume, letterOf(line(frame, "WIND"), MENT_P), { posting: guard() })
}
