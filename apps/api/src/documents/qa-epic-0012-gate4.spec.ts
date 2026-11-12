/**
 * EPIC-0012 QA gate 4 (step 6a, after repair wave 3, the last). Adversarial unit tests by an independent QA
 * session. Test files only; no product code changed. Report: epics/active/EPIC-0012-tailoring-rules/test-plan.r4.md.
 *
 * Convention, as in the gate-1, 2 and 3 specs: `it` asserts behaviour the candidate shows and the design
 * requires. `it.fails` asserts REQUIRED behaviour the candidate does not show: each one is a blocker QA4-Bn or a
 * minor QA4-Mn in the report, and it turns red when the defect is fixed (then it becomes `it`). "OBSERVATION"
 * tests pin a class the design leaves to the judge (design 2.3); they pass today and fail if the class is later
 * stopped in code, which is welcome.
 *
 * Repair wave 4 (Revision 4, R21 and R22) fixed every gate-4 blocker, so this file now holds no `it.fails`: each
 * flipped assertion is a normal `it`, and the rows R21 made stricter were updated with the design.
 *
 * The judge is a plain function (rubber stamp = `() => true`), not a model. `finish` replays the service's
 * post-model pipeline in the service's order (documents.service.ts generate(): hard fails, judge, fallback,
 * sentence drop, A6 orphan drop, R14 cap, R17 settle, density repair, validation, R16), so what it returns is what
 * the service would store. Fresh inputs only: no row here repeats a gate-3 input.
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
import { headlineFor } from "./headline.js"
import { keywordDensity, repairDenseLines, resumeLineRefs } from "./keyword-density.js"
import { capLetterKeywords } from "./letter-keyword-cap.js"
import { meaningKey, mechanicalKey } from "./line-text.js"

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
// 1. QA3-B1 (R17): the letter cap never blocks and never waves trimmed text through. Fresh inputs.
// ---------------------------------------------------------------------------------------------------------
describe("1. QA3-B1 / R17: the cap never blocks a true letter (fresh variants)", () => {
  const reactForms = ["login", "signup", "billing"].map((n) => line(`I tested React ${n} forms.`, "QA"))

  it("a judged paragraph trimmed on a different keyword (React) whose kept sentence opens with the fact's own second verb: dropped, letter valid", () => {
    const p4 = line("I tested React settings forms with Jest. I ran regression suites.", "QA")
    const outcome = finish(emptyResume, letterOf(...reactForms, p4), { keywords: REACT })
    expect(outcome.cap.dropped).toBe(1)
    expect(outcome.settled.paragraphsDropped).toBe(1)
    expect(outcome.settled.restored).toBe(0)
    expect(outcome.letterValid).toBe(true)
    // never waved through: the re-checked text that fails R8 is not stored
    expect(letterTexts(outcome)).not.toContain("I ran regression suites.")
    expect(letterTexts(outcome)).toHaveLength(3)
  })

  it("the same paragraph trimmed when the keyword is lower case in the line (case trick): still settled, valid", () => {
    const p4 = line("I tested react settings forms with Jest. I ran regression suites.", "QA")
    const outcome = finish(emptyResume, letterOf(...reactForms, p4), { keywords: REACT })
    expect(outcome.letterValid).toBe(true)
    expect(letterTexts(outcome).join(" ")).not.toContain("I ran regression suites")
  })

  it("a mechanical two-sentence fact (a different one) trimmed to its second sentence has no verdict: dropped, letter valid", () => {
    const outcome = finish(emptyResume, letterOf(...["login", "signup", "billing"].map((n) => line(`I tested the ${n} suite with Jest.`, "QA")), line("Reduced Jest suite runtime by 40%. Wrote onboarding guides.", "DOCS")), { keywords: JEST })
    expect(outcome.cap.dropped).toBe(1)
    expect(outcome.settled.paragraphsDropped).toBe(1)
    expect(outcome.letterValid).toBe(true)
    expect(letterTexts(outcome).join(" ")).not.toContain("Wrote onboarding guides")
  })

  it("the only paragraph, mechanical whole facts joined, trimmed to text that is no longer mechanical: its untrimmed form is restored, valid, over the cap", () => {
    const only = line("Wrote Jest tests for the checkout. Wrote Jest tests for the cart. Wrote Jest tests for search. Cut report preparation time by 30% using Jest. Trained the finance team.", "J1", "J2", "J3", "TWO")
    const outcome = finish(emptyResume, letterOf(only), { keywords: JEST })
    expect(outcome.cap.dropped).toBe(1)
    expect(outcome.settled.restored).toBe(1)
    expect(outcome.settled.paragraphsDropped).toBe(0)
    expect(outcome.letterValid).toBe(true)
    expect(letterTexts(outcome)).toEqual([only.text])
  })

  it("a judged paragraph trimmed to a passing subset keeps the carried verdict; a refused paragraph never gets one", () => {
    const p4 = line("I tested React settings forms. I tested the regression runs too.", "QA")
    const judged = finish(emptyResume, letterOf(...reactForms, p4), { keywords: REACT })
    expect(judged.letterValid).toBe(true)
    expect(judged.settled.paragraphsDropped).toBe(0)
    expect(letterTexts(judged).at(-1)).toBe("I tested the regression runs too.")
    // refused: the reworded sentences never reached the cap, so nothing is carried
    const refused = finish(emptyResume, letterOf(...reactForms, p4, MENT_P), { keywords: REACT, judge: REFUSE_ALL })
    expect(letterTexts(refused).join(" ")).not.toContain("regression runs too")
  })

  it("a trimmed paragraph's verdict comes only from the same text and fact ids (R15 key): a verdict on another fact never carries", () => {
    const judgeOnlyMent: Judge = (_t, ids) => ids.includes("MENT")
    const p4 = line("I tested React settings forms. I tested the regression runs too.", "QA")
    const outcome = finish(emptyResume, letterOf(...reactForms, p4, MENT_P), { keywords: REACT, judge: judgeOnlyMent })
    expect(letterTexts(outcome).join(" ")).not.toContain("regression runs too")
  })

  it("QA3-M1 fresh (direction on): the cap leaves only the second stored quote's sentence: dropped, never stored alone", () => {
    const q = "Your target to “cut water use by 40% across the group” is clear."
    const p = line(`${q} I tested React settings forms.`, "QA")
    const outcome = finish(emptyResume, letterOf(...reactForms, p, MENT_P), { keywords: REACT, posting: guard() })
    expect(letterTexts(outcome).some((t) => norm(t) === norm(q))).toBe(false)
    expect(outcome.letterValid).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------------------
// 2. QA3-B2 (R20): completion words in other forms, direction on. Fresh forms.
// ---------------------------------------------------------------------------------------------------------
describe("2. QA3-B2 / R20: completion forms after a direction quote (direction on)", () => {
  const QUOTE = "Your plan to “halve operational emissions by 2030” is clear."
  const stored = (tie: string, judge: Judge = RUBBER_STAMP) => {
    const outcome = finish(emptyResume, letterOf(line(`${QUOTE} ${tie}`, "WIND"), MENT_P), { posting: guard(), judge })
    return letterTexts(outcome).join(" ").includes(tie)
  }
  it.each([
    ["accomplishes", "My wind farm financial model accomplishes it."],
    ["surpassing", "My wind farm financial models are surpassing it."],
    ["realising", "My wind farm financial models are realising it."],
    ["realizes", "My wind farm financial model realizes it."],
    ["fulfilling", "My wind farm financial models are fulfilling it."],
    ["fulfills", "My wind farm financial model fulfills it."],
    ["completing", "My wind farm financial models are completing it."],
    ["exceeds", "My wind farm financial model exceeds it."],
    ["surpasses", "My wind farm financial model surpasses it."],
    ["meets", "My wind farm financial model meets it."],
    ["hitting", "My wind farm financial models are hitting it."],
    ["over-delivering (hyphen)", "My wind farm financial models are over-delivering on it."],
    ["Delivering (sentence start)", "Delivering it is what my wind farm financial models do."],
    ["ACHIEVING (upper case)", "My wind farm financial models are ACHIEVING it."],
    ["accomplishing", "My wind farm financial models are accomplishing it."],
  ])("'%s' is a hard fail: the sentence is never stored, even rubber-stamped", (_name, tie) => {
    expect(stored(tie)).toBe(false)
  })
  it("completionWordIn reads the forms directly", () => {
    for (const word of ["achieving", "reaches", "meeting", "fulfils", "fulfilled", "surpassing", "hits", "hitting", "realises", "completes"]) expect(completionWordIn(`x ${word} y`)).not.toBeNull()
    for (const word of ["advanced", "contributed", "aiming", "support", "helped", "doing", "meetings"]) expect(completionWordIn(`x ${word} y`)).toBeNull()
  })
  it.each([
    ["attained", "My wind farm financial models attained it."],
    ["secured", "My wind farm financial models secured it."],
    ["landed", "My wind farm financial models landed it."],
    ["beat", "My wind farm financial models beat it."],
    ["overdelivered (one word)", "My wind farm financial models overdelivered on it."],
    ["noun 'achievement'", "My wind farm financial models were an achievement toward it."],
  ])("OBSERVATION (R20 accepted scope): synonym '%s' has no listed stem, so only the judge stops it", (_name, tie) => {
    expect(stored(tie)).toBe(true)
    expect(stored(tie, REFUSE_ALL)).toBe(false)
  })
  it("OBSERVATION (R11 is paragraph-scoped): a completion word in the NEXT paragraph is the judge's call", () => {
    const outcome = finish(emptyResume, letterOf(line(`${QUOTE} ${WIND_SENTENCE}`, "WIND"), line("My wind farm financial models are achieving that goal.", "WIND")), { posting: guard() })
    expect(letterTexts(outcome).join(" ")).toContain("achieving that goal")
    const refused = finish(emptyResume, letterOf(line(`${QUOTE} ${WIND_SENTENCE}`, "WIND"), line("My wind farm financial models are achieving that goal.", "WIND"), MENT_P), { posting: guard(), judge: REFUSE_ALL })
    expect(letterTexts(refused).join(" ")).not.toContain("achieving that goal")
  })
  it("direction off: the same completion form does not matter, the quote sentence itself fails on 2030", () => {
    const outcome = finish(emptyResume, letterOf(line(`${QUOTE} My wind farm financial models are achieving it.`, "WIND"), MENT_P), { posting: guard([]) })
    expect(letterTexts(outcome).join(" ")).not.toContain("halve operational")
  })
})

// ---------------------------------------------------------------------------------------------------------
// 3. QA3-B3 (R18): the headline prints only a title the Candidate held. Fresh variants.
// ---------------------------------------------------------------------------------------------------------
describe("3. QA3-B3 / R18: the headline (both flags off; no flag gates it)", () => {
  const P = "Head of Finance"
  it.each([
    ["Executive Assistant supporting the Head of Finance"],
    ["Analyst serving the Head of Finance"],
    ["Chief of Staff to the Head of Finance"],
    ["EA TO THE HEAD OF FINANCE"],
    ["Business Partner reporting into the Head of Finance"],
    ["Coordinator assisting the Head of Finance"],
    ["Analyst (supports Head of Finance)"],
    ["Assistant to the Head-of-Finance"],
    ["Interim Deputy Head of Finance"],
    ["Vice Head of Finance"],
    ["Acting Assistant Head of Finance"],
    ["Head of Finance Apprentice"],
    ["Head of Finance Designate"],
    ["Head of Finance Office Manager"],
    ["Head of Finance Intern 2023"],
    ["Head of Finance Trainee II"],
  ])("'%s' never yields 'Head of Finance'", (title) => {
    expect(headlineFor(P, [title])).toBeNull()
  })

  it.each([
    ["Head of Finance from 2023", P],
    ["Head of Finance since March", P],
    ["Head of Finance II", P],
    ["Head of Finance (2021–present)", P],
    ["Senior Head of Finance", P],
  ])("'%s' still prints (R18 effects, unchanged design 3e)", (title, expected) => {
    expect(headlineFor(P, [title])).toBe(expected)
  })
  // R21: "for EMEA" is one more word the segment keeps, and a bracketed second title makes the entry a
  // multi-title entry. Neither is the posting title whole, so neither prints.
  it.each([
    ["Head of Finance for EMEA"],
    ["Sustainability Analyst (Head of Finance from 2023)"],
  ])("'%s' prints nothing now (Revision 4, R21)", (title) => {
    expect(headlineFor(P, [title])).toBeNull()
  })
  it("step-down words still print the posting title; step-up or sideways words never do", () => {
    expect(headlineFor("Engineer", ["Lead Engineer"])).toBe("Engineer")
    expect(headlineFor("Engineer", ["Principal Engineer"])).toBe("Engineer")
    expect(headlineFor("Engineer", ["Staff Engineer"])).toBe("Engineer")
    expect(headlineFor("Engineer", ["Engineering Manager"])).toBeNull()
    expect(headlineFor("Engineer", ["Associate Engineer"])).toBeNull()
    expect(headlineFor("Senior Engineer", ["Junior Engineer"])).toBeNull()
  })
  it("R18 accepted deviation: a relation word that ends the title is part of it ('Head of Sustainability Reporting' prints nothing)", () => {
    expect(headlineFor("Head of Sustainability", ["Head of Sustainability Reporting"])).toBeNull()
    expect(headlineFor("Head of Finance", ["Head of Finance Reporting"])).toBeNull()
  })

  // QA4-B1. The accepted deviation cuts at a relation word whenever any text follows it. "Reporting" and
  // "Support" are also title nouns, so a step-up title with anything after its last word (a bracket, a dash, a
  // second noun) is cut back to "Head of …" and prints. headline.ts:135-141 (`relationCut`): the test is only
  // `/\S/.test(rest)`. Both flags off; this ships now.
  it.each([
    ["Head of Sustainability Reporting (EMEA)", "Head of Sustainability"],
    ["Head of Sustainability Reporting - London", "Head of Sustainability"],
    ["Head of Sustainability Reporting & Assurance", "Head of Sustainability"],
    ["Head of Finance Reporting and Analysis", "Head of Finance"],
    ["Head of Finance Reporting, EMEA", "Head of Finance"],
    ["Head of Finance Reporting Systems", "Head of Finance"],
  ])("BLOCKER QA4-B1: '%s' must not print '%s' (a step up the deviation's own null case forbids)", (title, posting) => {
    expect(headlineFor(posting, [title])).toBeNull()
  })

  // QA4-B2. R18 made "Head of Finance Intern / Trainee" print nothing, but the same qualifier written after a
  // separator (bracket, dash, comma, pipe) is its own segment, and the segment "Head of Finance" prints.
  // "Software Engineer – Intern" / "(Intern)" is the common way to write it. headline.ts:39 (TITLE_SEGMENT_BREAK)
  // splits first, then `runEnds` (:233) sees a bare "head of finance" segment. Both flags off.
  it.each([
    ["Head of Finance (Intern)"],
    ["Head of Finance – Intern"],
    ["Head of Finance - Trainee"],
    ["Head of Finance, Deputy"],
    ["Head of Finance | Assistant"],
    ["Head of Finance [Apprentice]"],
  ])("BLOCKER QA4-B2: '%s' must not print 'Head of Finance' (QA3-B3 class: a qualifier after a separator)", (title) => {
    expect(headlineFor(P, [title])).toBeNull()
  })
  it("the same check on a common engineering title: 'Software Engineer (Intern)' prints nothing now (Revision 4, R21)", () => {
    expect(headlineFor("Software Engineer", ["Software Engineer (Intern)"])).toBeNull()
    expect(headlineFor("Software Engineer", ["Software Engineer Intern"])).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------------------
// 4. QA3-B4 (R19): a quotation must come from somewhere. Fresh variants, both flags off and on.
// ---------------------------------------------------------------------------------------------------------
describe("4. QA3-B4 / R19: quotation provenance", () => {
  const FAB = "double revenue within the decade"
  const letterWith = (frame: string, posting: PostingGuard) => finish(emptyResume, letterOf(line(`${frame} ${WIND_SENTENCE}`, "WIND"), MENT_P), { posting })
  const quotedStored = (frame: string, posting: PostingGuard) => letterTexts(letterWith(frame, posting)).join(" ").toLowerCase().includes("revenue within")

  describe.each(STATES)("%s", (_state, flags) => {
    const posting = guardFor(flags)
    it.each([
      ["straight double", `Your plan to "${FAB}" is clear.`],
      ["curly double", `Your plan to “${FAB}” is clear.`],
      ["guillemets", `Your plan to «${FAB}» is clear.`],
      ["German low-high", `Your plan to „${FAB}“ is clear.`],
      ["curly single", `Your plan to ‘${FAB}’ is clear.`],
      ["straight single", `Your plan to '${FAB}' is clear.`],
      ["upper case", `Your plan to “${FAB.toUpperCase()}” is clear.`],
      ["a fragment glued to a real quote word", `Your plan to “halve revenue within the decade” is clear.`],
      ["unbalanced", `Your plan to “${FAB} is clear.`],
      ["spans two sentences", `Your plan to “double revenue. Within the decade” is clear.`],
      ["in brackets", `Your plan (“${FAB}”) is clear.`],
      ["the posting's own words, never a stored quote", `Your plan to “${FAB}” is clear.`],
    ])("%s: never stored, even rubber-stamped", (_name, frame) => {
      expect(quotedStored(frame, posting)).toBe(false)
    })
  })

  // QA4-B3. Quote marks the R19 span finder does not pair: a German low mark closed by a right mark, two right
  // marks (Swedish/Finnish style, and common in auto-corrected text), reversed guillemets (German/Danish), single
  // guillemets, CJK corner brackets, a right single mark used as the opener, an opener after a dash or colon, and
  // a single-quoted span holding an apostrophe. Each has an even count of double marks (or none), so the
  // unbalanced rule does not fire either. company-direction.ts:181-191 (`quotedSpans`). A rubber-stamp judge stores
  // each with both flags off: the employer is quoted saying words it never wrote.
  describe.each(STATES)("%s", (_state, flags) => {
    const posting = guardFor(flags)
    it.each([
      ["„…” (low-9 closed by a right mark)", `Your plan to „${FAB}” is clear.`],
      ["”…” (two right marks)", `Your plan to ”${FAB}” is clear.`],
      ["“…“ (two left marks)", `Your plan to “${FAB}“ is clear.`],
      ["»…« (reversed guillemets)", `Your plan to »${FAB}« is clear.`],
      ["‹…› (single guillemets)", `Your plan to ‹${FAB}› is clear.`],
      ["「…」 (corner brackets)", `Your plan to 「${FAB}」 is clear.`],
      ["’…’ (right single marks)", `Your plan to ’${FAB}’ is clear.`],
      ["a single-quoted span holding an apostrophe", `Your plan to ‘double the team’s revenue within the decade’ is clear.`],
      ["an opening single mark after an en dash (the service rewrites only em dashes)", `Your plan–‘${FAB}’–is clear.`],
      ["an opening single mark after a colon", `Your plan:'${FAB}' is clear.`],
    ])("BLOCKER QA4-B3: %s is never stored", (_name, frame) => {
      expect(quotedStored(frame, posting)).toBe(false)
    })
  })

  it("the unsourced span is counted as `unsourced_quote` in hard_fail reasons, never as text", () => {
    const outcome = letterWith(`Your plan to “${FAB}” is clear.`, guard([], false))
    expect(outcome.hardFails.unsourced_quote).toBeGreaterThan(0)
    expect(JSON.stringify(outcome.hardFails)).not.toContain("revenue")
  })

  it("resume lines: an unsourced quote in a summary, bullet or skills line is never stored, even rubber-stamped", () => {
    for (const flags of STATES.map(([, f]) => f)) {
      const outcome = finish(
        resumeOf([line(`Built wind farm financial models, praised as “best in class”`, "WIND")], [line(`Built wind farm financial models for offshore projects, “forecasting the decade”`, "WIND")], [line(`React, “TypeScript expert”`, "SK")]),
        emptyLetter,
        { posting: guardFor(flags) }
      )
      expect(allText(outcome)).not.toContain("best in class")
      expect(allText(outcome)).not.toContain("forecasting the decade")
      expect(allText(outcome)).not.toContain("expert")
    }
  })

  describe("false positives: legitimate text still passes", () => {
    it.each([
      ["I'm", "I'm proud of the wind farm financial models I built for offshore projects."],
      ["teams' (plural possessive)", "I built the teams' shared forecasting models."],
      ["team's (possessive)", "I built my team's wind farm financial models for offshore projects."],
      ["two possessives in one sentence", "My team's models served the firm's offshore projects."],
    ])("an apostrophe is not a quotation: %s", (_name, text) => {
      expect(unsourcedQuotationIn(text, [])).toBeNull()
    })
    it("a quotation of a cited fact's own words passes, in any mark style and case", () => {
      for (const text of ["I won the “analyst of the year” award.", "I won the 'Analyst of the Year' award.", "I won the «analyst of the year» award.", 'I won the "analyst of the year" award.']) {
        expect(unsourcedQuotationIn(text, [FACTS.get("AWARD")!])).toBeNull()
      }
    })
    it("a resume bullet repeating a fact's own quotation is stored under a rubber stamp", () => {
      const outcome = finish(resumeOf([], [line("Won the “analyst of the year” award for the forecasting models", "AWARD")]), emptyLetter, { posting: guard([], false) })
      expect(resumeTexts(outcome).map(norm)).toContain(norm("Won the “analyst of the year” award for the forecasting models"))
    })
    it("direction on: the stored quote, whole or as a whole-token run, with edge punctuation, in another mark style, passes and is stored", () => {
      for (const frame of [
        "Your plan to “halve operational emissions by 2030” is clear.",
        "Your plan to 'halve operational emissions by 2030' is clear.",
        "Your target is «halve operational emissions by 2030».",
      ]) {
        expect(unsourcedQuotationIn(frame, QUOTES)).toBeNull()
      }
      const outcome = letterWith("Your plan to “halve operational emissions by 2030” is clear.", guard())
      expect(letterTexts(outcome).join(" ")).toContain("halve operational emissions by 2030")
    })
    it("direction off: the same stored quote is not a source (nothing may be quoted from the posting)", () => {
      expect(quotedStored("Your plan to “cut water use by 40% across the group” is clear.", guard([], false))).toBe(false)
      expect(unsourcedQuotationIn("Your plan to “halve operational emissions by 2030” is clear.", [])).not.toBeNull()
    })
    it("R24 C10: a wordless envelope (an empty pair of marks) fails closed", () => {
      expect(unsourcedQuotationIn("I built models “” for offshore projects.", [])).not.toBeNull()
    })
  })

  it("OBSERVATION (R19 design: a cited fact is a source): the Candidate's own fact words can be quoted as the employer's plan; only the judge stops it", () => {
    expect(quotedStored("Your plan to “forecasting revenue and cost” is clear.", guard([], false))).toBe(false) // "revenue within" absent by construction
    const frame = "Your plan to “forecasting revenue and cost” is clear."
    const stamped = letterTexts(letterWith(frame, guard([], false))).join(" ")
    expect(stamped).toContain("“forecasting revenue and cost”")
    const refused = finish(emptyResume, letterOf(line(`${frame} ${WIND_SENTENCE}`, "WIND"), MENT_P), { posting: guard([], false), judge: REFUSE_ALL })
    expect(letterTexts(refused).join(" ")).not.toContain("forecasting revenue and cost”")
  })
})

// ---------------------------------------------------------------------------------------------------------
// 5. QA3-M2 (M2): the mechanical key drops every sentence's leading "I". Fresh variants.
// ---------------------------------------------------------------------------------------------------------
describe("5. QA3-M2: 'I' + fact sentences stay mechanical with the judge down", () => {
  it("three 'I' sentences, one after '!' and one lower-case 'i', with the judge down: kept, no provider error", () => {
    const p = line("I wrote Jest tests for the checkout! i wrote Jest tests for the cart. I wrote Jest tests for search.", "J1", "J2", "J3")
    const outcome = finish(emptyResume, letterOf(p), { judgeFails: true })
    expect(outcome.letterValid).toBe(true)
    expect(outcome.providerError).toBe(false)
  })
  it("the key strips only the pronoun: 'In', 'It', 'Iterated' are not stripped, and a scope verb after 'I' is not made mechanical", () => {
    expect(mechanicalKey("In 2021 I wrote tests.", true)).toContain("in 2021")
    expect(mechanicalKey("I wrote tests. It ran. Iterated.", true)).toContain("it ran")
    // not mechanical: it goes to the judge (R8 reads only the first verb, a known gate-3 risk), and with the judge
    // down the reworded sentence is lost, never stored unjudged
    expect(needsMeaningCheck(line("I supported the payments migration. I led the payments migration.", "PAY"), FACTS, TARGET, null, "letter_paragraph", guard(), WORDING)).toBe(true)
    const outcome = finish(emptyResume, letterOf(line("I supported the payments migration. I led the payments migration.", "PAY"), MENT_P), { judgeFails: true })
    expect(letterTexts(outcome).join(" ")).not.toContain("I led")
  })
})

// ---------------------------------------------------------------------------------------------------------
// 6. A judge that approves everything, in each flag state: what code still stops (fresh lines).
// ---------------------------------------------------------------------------------------------------------
describe("6. rubber-stamp judge in every flag state", () => {
  const RESUME = resumeOf(
    [line("Spearheaded the payments migration", "PAY"), line("Built wind farm financial models for offshore projects in SNOWFLAKE", "WIND")],
    [
      line("Built wind farm financial models and did carbon-accounting work", "WIND"),
      line("Mentored 16 junior developers", "MENT"),
      line("Built wind farm financial models for offshore projects as a sustainability consultant", "WIND"),
      line("Built wind farm financial models for offshore projects, “the best in the region”", "WIND"),
    ]
  )
  const LETTER = letterOf(
    line("I headed the payments migration.", "PAY"),
    line(`Your plan to „double revenue within the decade“ is clear. ${WIND_SENTENCE}`, "WIND"),
    line("Your plan to “halve operational emissions by 2030” is clear. My wind farm financial models are achieving it.", "WIND"),
    MENT_P
  )
  it.each(STATES)("%s: no hard-fail class is stored", (_name, flags) => {
    const outcome = finish(RESUME, LETTER, { posting: guardFor(flags) })
    const text = allText(outcome)
    for (const bad of ["Spearheaded", "SNOWFLAKE", "carbon-accounting", "16 junior", "as a sustainability consultant", "best in the region", "I headed", "double revenue", "achieving it"]) {
      expect(text, bad).not.toContain(bad)
    }
    expect(outcome.resumeValid).toBe(true)
    expect(outcome.letterValid).toBe(true)
    // hard-failed lines never reach the judge
    for (const bad of ["SNOWFLAKE", "carbon-accounting", "16 junior", "best in the region", "double revenue"]) expect(outcome.sent.join(" | ")).not.toContain(bad)
  })
  it.each(STATES)("%s: a judge that fails or refuses stores only fact wording in the resume", (_name, flags) => {
    for (const options of [{ judge: REFUSE_ALL }, { judgeFails: true }] as const) {
      const outcome = finish(RESUME, LETTER, { posting: guardFor(flags), ...options })
      const wordings = new Set([...WORDING.values()].map(norm))
      for (const text of resumeTexts(outcome)) expect(wordings.has(norm(text))).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------------------------------------
// 7. Regressions: QA2-B1..B8 and R8..R16, fresh inputs.
// ---------------------------------------------------------------------------------------------------------
describe("7. regressions R8 to R16 (fresh inputs)", () => {
  it("R8: 'I helmed' / 'Steered' / 'Fronted' for 'Supported…': hard fail or judge, never stored when refused", () => {
    for (const text of ["Steered the payments migration", "Fronted the payments migration", "Headed up the payments migration"]) {
      const outcome = finish(resumeOf([], [line(text, "PAY")]), emptyLetter, { judge: REFUSE_ALL })
      expect(resumeTexts(outcome)).toEqual([WORDING.get("PAY")])
    }
  })
  it("R10: a borrowed name in an odd case or position fails even rubber-stamped (Excel, power-bi, TABLEAU)", () => {
    for (const text of ["Built wind farm financial models for offshore projects in eXcel", "Built wind farm financial models for offshore projects, power bi included", "TABLEAU: built wind farm financial models"]) {
      const outcome = finish(resumeOf([line(text, "WIND")]), emptyLetter)
      expect(allText(outcome)).not.toContain(text)
    }
  })
  it("R12/R18: joined forms still never combine", () => {
    expect(headlineFor("Head of Sustainability", ["Head of Finance / Sustainability Lead"])).toBeNull()
    expect(headlineFor("Head of Sustainability", ["Sustainability (Head of Finance)"])).toBeNull()
  })
  it("R13: dedupe after fallback (two refused rewords of one fact collapse to one fact wording)", () => {
    const outcome = finish(resumeOf([], [line("Made wind farm financial models", "WIND"), line("Produced wind farm financial models", "WIND")]), emptyLetter, { judge: REFUSE_ALL })
    expect(resumeTexts(outcome)).toEqual([WORDING.get("WIND")])
  })
  it("R14: one-sentence paragraphs over the cap with an alias keep three mentions", () => {
    const outcome = finish(emptyResume, letterOf(...["a", "b", "c", "d", "e"].map((n) => line(`I tested the ${n} page with Jest.`, "QA"))), { keywords: JEST })
    expect(letterTexts(outcome)).toHaveLength(3)
    expect(outcome.letterValid).toBe(true)
  })
  it("R15: a verdict on (text, F1) is not a verdict on (text, F1+F2)", () => {
    expect(meaningKey("x", ["MENT"])).not.toBe(meaningKey("x", ["MENT", "WIND"]))
  })
  it("R16: judge down, a reworded paragraph plus an unsourced-quote paragraph: the quote is a claim block, not a provider error", () => {
    const outcome = finish(emptyResume, letterOf(line("I created financial models for offshore wind farm projects.", "WIND"), line("I was called “the best modeller”.", "WIND")), { judgeFails: true })
    expect(outcome.letterValid).toBe(false)
    expect(outcome.providerError).toBe(false)
  })
})
