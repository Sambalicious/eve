/**
 * EPIC-0012 QA gate 2 (step 6a, after repair wave 1). These are fresh adversarial variants of QA-B1 to
 * QA-B6 and QA-R1, written by an independent QA session. Test file only; no product code changed.
 *
 * Convention, as in qa-epic-0012-truth-guard.spec.ts: `it` asserts required behaviour the candidate already
 * shows. `it.fails` asserts REQUIRED behaviour the candidate does not show yet: each one is a blocker in
 * epics/active/EPIC-0012-tailoring-rules/test-plan.r2.md, and once it is fixed `it.fails` turns red and
 * becomes `it`.
 *
 * "judged" means the meaning check answered supported: true for that exact line. The judge here is a fake
 * set, not the model, so real-model behaviour is not tested.
 */
import { describe, expect, it } from "vitest"

import type { AtsKeyword } from "../ats/ats-score.js"
import { factClaimsMissing } from "../career-profile/claim-check.js"
import { dropUnsupportedSentences, needsMeaningCheck, postingGuard, validateDocument } from "./document-claims.js"
import type { CoverLetterContent, ResumeContent } from "./document-model.js"
import { headlineFor } from "./headline.js"
import { keywordDensity, repairDenseLines, resumeLineRefs } from "./keyword-density.js"
import { capLetterKeywords } from "./letter-keyword-cap.js"
import { meaningKey } from "./line-text.js"

/** The validation map value the service builds: fact text, then ". title, organization, period". */
const withHeading = (fact: string, title = "Analyst", organization = "Acme") => `${fact}. ${title}, ${organization}, 2020–2023`

const FACTS = new Map([
  ["PAY", withHeading("Supported the payments migration")],
  ["PIONEER", withHeading("Supported the payments migration", "Analyst", "Pioneer Natural Resources")],
  ["LEAD_BANK", withHeading("Supported the payments migration", "Analyst", "Lead Bank")],
  ["DRIVE", withHeading("Supported the payments migration", "Analyst", "Drive Capital")],
  ["LEAD_GEN", withHeading("Built tools for sales and lead generation")],
  ["HEAD_OFFICE", withHeading("Supported billing, head office moves and audits")],
  ["JOINTLY", withHeading("Supported a migration, led jointly by two platform leads")],
  ["IN_2022", withHeading("Supported a migration, led in 2022 by the platform team")],
  ["CO_LED", withHeading("Co-led the payments migration")],
  ["AND_LED", withHeading("Built the billing service and led the API rewrite", "Engineer")],
  ["WIND", withHeading("Built wind farm financial models for offshore projects, forecasting revenue and cost")],
])
const QUOTES = ["Our aim is to halve operational emissions by 2030", "We will cut water use by 40% across the group"]
const POSTING =
  "Sustainability consulting firm. We use Workiva daily.\nTableau experience is a plus.\nTools: Snowflake, Power BI and Excel. ESG reporting matters. Carbon accounting matters."
const GUARD = postingGuard(POSTING, "Sustainability Consultant", ["carbon accounting"], true, QUOTES)
const TARGET = { employer: "Verdant", roleTitle: "Sustainability Consultant" }
const FACT_LINE = "I built wind farm financial models for offshore projects, forecasting revenue and cost."
const NONE: ReadonlySet<string> = new Set()
/** The verdict key a line's text gets with the facts it cites (R15): no verdict matches on text alone. */
const judged = (text: string, factIds: readonly string[]): ReadonlySet<string> => new Set([meaningKey(text, factIds)])

const summary = (text: string, factId: string): ResumeContent => ({ kind: "resume", summary: [{ text, factIds: [factId] }], experience: [], skills: [], education: [] })
const letter = (paragraphs: readonly string[]): CoverLetterContent => ({
  kind: "cover_letter",
  greeting: "Dear Hiring Team,",
  opening: null,
  paragraphs: paragraphs.map((text) => ({ text, factIds: ["WIND"] })),
  closingLine: null,
  closing: "Kind regards,",
})
/** A line passes unchecked: valid with no meaning check, and never sent to one. */
const passesUnchecked = (text: string, factId: string) =>
  validateDocument(summary(text, factId), FACTS, null, null, NONE, GUARD).ok && !needsMeaningCheck({ text, factIds: [factId] }, FACTS, null, null, "summary", GUARD)

describe("QA-B1 variants: scope verbs (Revision 1, R1)", () => {
  it.each(["Spearheaded", "Championed", "Steered", "Orchestrated", "Established", "Founded", "Ran", "Architected", "Supervised", "Owned", "Directed"])(
    "'%s' for 'Supported' is unsupported until judged",
    (verb) => {
      const text = `${verb} the payments migration`
      expect(validateDocument(summary(text, "PAY"), FACTS, null, null, NONE, GUARD).ok).toBe(false)
    }
  )

  it("'Led' for 'Co-led' needs the judge", () => {
    expect(needsMeaningCheck({ text: "Led the payments migration", factIds: ["CO_LED"] }, FACTS, null, null, "summary", GUARD)).toBe(true)
  })

  it("the design's pass case: 'Led the API rewrite' citing '…and led the API rewrite' now reaches the judge", () => {
    const text = "Led the API rewrite"
    const line = { text, factIds: ["AND_LED"] }
    expect(needsMeaningCheck(line, FACTS, null, null, "summary", GUARD)).toBe(true)
    expect(validateDocument(summary(text, "AND_LED"), FACTS, null, null, judged(text, ["AND_LED"]), GUARD)).toEqual({ ok: true })
  })

  it("the whole fact text is exempt, and adds nothing", () => {
    expect(passesUnchecked("Supported the payments migration", "PAY")).toBe(true)
  })

  // BLOCKER QA2-B1a: R1 says only the fact's own text counts, but `unsupportedScopeVerbs` scans the
  // validation value, which carries the section heading. The organisation follows ", " (a clause start),
  // so an employer named "Pioneer…", "Lead…" or "Drive…" makes the verb the Candidate's own.
  it.each([
    ["Pioneered the payments migration", "PIONEER", "Pioneer Natural Resources"],
    ["Led the payments migration", "LEAD_BANK", "Lead Bank"],
    ["Drove the payments migration", "DRIVE", "Drive Capital"],
  ])("BLOCKER QA2-B1a: '%s' for 'Supported…' at %s (employer %s)", (text, factId) => {
    expect(passesUnchecked(text, factId)).toBe(false)
  })

  // BLOCKER QA2-B1b: the doer test reads a noun as a verb after "and" or a comma, and checks "by" only
  // as the very next word.
  it.each([
    ["Led sales tools", "LEAD_GEN", "fact: 'Built tools for sales and lead generation'"],
    ["Supported billing and headed office moves", "HEAD_OFFICE", "fact: 'Supported billing, head office moves and audits'"],
    ["Led a migration", "JOINTLY", "fact: 'Supported a migration, led jointly by two platform leads'"],
    ["Led a migration", "IN_2022", "fact: 'Supported a migration, led in 2022 by the platform team'"],
  ])("BLOCKER QA2-B1b: '%s' (%s), %s", (text, factId) => {
    expect(passesUnchecked(text, factId)).toBe(false)
  })
})

describe("QA-B2 variants: borrowed names, acronyms and gaps (Revision 1, R2)", () => {
  it.each([
    ["esg-reporting (hyphen)", "Built wind farm financial models for esg-reporting, forecasting revenue and cost."],
    ["e.s.g. (dotted, lower case)", "Built wind farm financial models for e.s.g. reporting, forecasting revenue and cost."],
    ["workiva (capitalised mid-sentence in the posting)", "Built wind farm financial models in workiva for offshore projects."],
    ["power bi (after a colon, but BI is an acronym)", "Built wind farm financial models in power bi for offshore projects."],
    ["excel (mid-list)", "Built wind farm financial models in excel for offshore projects."],
    ["acca (listed qualification, not in the posting)", "Built wind farm financial models as an acca member for offshore projects."],
  ])("%s fails even when judged", (_name, text) => {
    expect(validateDocument(summary(text, "WIND"), FACTS, null, null, judged(text, ["WIND"]), GUARD).ok).toBe(false)
  })

  // BLOCKER QA2-B2: `borrowedNames` skips a capitalised word at a line start or after a colon (it reads it as
  // sentence case). A posting that lists its tools as "Tableau experience is a plus." or "Tools: Snowflake, …"
  // lends them in lower case, and the judge decides.
  it.each([
    ["tableau (line start in the posting)", "Built wind farm financial models in tableau for offshore projects."],
    ["snowflake (after 'Tools:' in the posting)", "Built wind farm financial models in snowflake for offshore projects."],
  ])("BLOCKER QA2-B2: %s fails even when judged", (_name, text) => {
    expect(validateDocument(summary(text, "WIND"), FACTS, null, null, judged(text, ["WIND"]), GUARD).ok).toBe(false)
  })
})

describe("QA-B3 variants: direction span on whole tokens (Revision 1, R3)", () => {
  const passes = (text: string) => validateDocument(letter([text]), FACTS, TARGET, null, NONE, GUARD).ok
  it.each([
    ["number cut ('by 40' from '40%')", `Your plan to “cut water use by 40” is clear. ${FACT_LINE}`],
    ["word cut at the start ('ut')", `Your plan to “ut water use by 40%” is clear. ${FACT_LINE}`],
  ])("%s fails", (_name, text) => {
    expect(passes(text)).toBe(false)
  })
  it("a whole-token run passes when judged", () => {
    const text = `Your plan to “water use by 40%” is clear. ${FACT_LINE}`
    expect(validateDocument(letter([text]), FACTS, TARGET, null, judged(text, ["WIND"]), GUARD).ok).toBe(true)
  })
})

describe("QA-B4 variants: a direction sentence carries no claim (Revision 1, R4)", () => {
  const passes = (text: string) => validateDocument(letter([text]), FACTS, TARGET, null, NONE, GUARD).ok
  it.each([
    ["'was delivered'", `Your plan to “halve operational emissions by 2030” was delivered. ${FACT_LINE}`],
    ["'was led by me'", `Your plan to “halve operational emissions by 2030” was led by me. ${FACT_LINE}`],
    ["a frame-word clause linking the goal to the Candidate", `Your mission is “to halve operational emissions by 2030”, a goal this model met. ${FACT_LINE}`],
  ])("%s keeps the quote in and fails", (_name, text) => {
    expect(passes(text)).toBe(false)
  })
  it("frame words only pass when judged: 'Your stated public target is “…”.'", () => {
    const text = `Your stated public target is “halve operational emissions by 2030”. ${FACT_LINE}`
    expect(validateDocument(letter([text]), FACTS, TARGET, null, judged(text, ["WIND"]), GUARD).ok).toBe(true)
  })

  // BLOCKER QA2-B4: R4 moves the link to a separate sentence "checked like any line". That sentence can
  // present the goal as met using only free words ("that", "target", "was", "met", fact words), so the
  // letter still says the Candidate met the employer's 2030 goal, with no meaning check.
  it.each([
    ["That target was met", "Your plan to “halve operational emissions by 2030” is clear. That target was met by these wind farm financial models built for offshore projects."],
    ["It was met", "Your plan to “halve operational emissions by 2030” is clear. It was met by these wind farm financial models built for offshore projects."],
  ])("BLOCKER QA2-B4: '%s' in the next sentence reaches the judge", (_name, text) => {
    expect(needsMeaningCheck({ text, factIds: ["WIND"] }, FACTS, TARGET, null, "letter_paragraph", GUARD) || !passes(text)).toBe(true)
  })
})

describe("Everyday words added for R4 (career-profile/everyday-words.ts)", () => {
  it.each([
    ["Public Target Programme lead", ["public", "target", "programme"]],
    ["Stated Aim: Net Zero", ["stated", "aim", "net", "zero"]],
    ["Met the public pledge for 40% cuts", ["met", "40"]],
  ])("profile claim check: '%s' still reports its claims", (fact, claims) => {
    const missing = factClaimsMissing(fact, "Built models")
    for (const claim of claims) expect(missing).toContain(claim)
  })

  // BLOCKER QA2-B7: the words are shared with every document line, so "public", "pledge", "stated aim" and
  // "targets" are now free in a resume bullet and never reach the judge. "public offshore projects" claims a
  // sector the fact does not state.
  it.each([
    ["public", "Built wind farm financial models for public offshore projects, forecasting revenue and cost."],
    ["a public pledge", "Built wind farm financial models for offshore projects under a public pledge, forecasting revenue and cost."],
    ["targets", "Built wind farm financial models for offshore projects, forecasting revenue and cost targets."],
  ])("BLOCKER QA2-B7: '%s' added to a fact line reaches the judge", (_name, text) => {
    expect(passesUnchecked(text, "WIND")).toBe(false)
  })
})

describe("QA-B5 variants: headline segments (Revision 1, R5)", () => {
  it.each([
    ["', later'", "Sustainability Analyst, later Head of Finance"],
    ["' and '", "Sustainability Analyst and Head of Finance"],
    ["' + '", "Sustainability Analyst + Head of Finance"],
    ["' – '", "Sustainability Analyst – Head of Finance"],
  ])("one entry split at %s never yields 'Head of Sustainability'", (_name, title) => {
    expect(headlineFor("Head of Sustainability", [title])).toBeNull()
  })
  it("duplicate entries never combine", () => {
    expect(headlineFor("Head of Sustainability", ["Head of Finance", "Sustainability Analyst", "Head of Finance"])).toBeNull()
  })

  // QA2-B5, fixed by Revision 2, R12: the posting title must sit inside one profile segment as one
  // contiguous run, so a separator outside R5's list cannot leave two titles combining into a third.
  it.each([
    ["'then'", "Sustainability Analyst then Head of Finance"],
    ["an em dash with no spaces", "Sustainability Analyst—Head of Finance"],
    ["'&' with no spaces", "Sustainability Analyst&Head of Finance"],
    ["brackets", "Sustainability Analyst (Head of Finance from 2023)"],
    ["'(promoted: …)'", "Sustainability Analyst (promoted: Head of Finance)"],
    ["a full stop", "Sustainability Analyst. Head of Finance"],
  ])("BLOCKER QA2-B5: one entry joined by %s never yields 'Head of Sustainability'", (_name, title) => {
    expect(headlineFor("Head of Sustainability", [title])).toBeNull()
  })

  // R5 says a posting title with more than one segment gives null. Revision 2, M1 moved the check before
  // the match loop, so a supported multi-segment title never prints either.
  it("QA2-M1: a posting title in two segments prints nothing (R5)", () => {
    expect(headlineFor("Analyst, Sustainability", ["Sustainability Analyst"])).toBeNull()
  })
})

describe("QA-B6 and QA-R1 variants: density repair and the letter cap (Revision 1, R6, R7)", () => {
  const kw = (name: string): AtsKeyword => ({ keyword: name, kind: "technology", group: `one:${name.toLowerCase()}` })
  const KEYS = [kw("React"), kw("TypeScript"), kw("Jest"), kw("Node")]
  const WORDING = new Map([
    ["R1", "Built a React dashboard for merchants"],
    ["R3", "Tested React components with Jest"],
  ])

  // BLOCKER QA2-B6: `repairDenseLines` only compares a repaired line with lines kept before it. A crowded
  // first bullet repaired to the fact's wording, followed by the model's verbatim copy of that fact, prints twice.
  it("BLOCKER QA2-B6: a repaired line never duplicates a later unrepaired line", () => {
    const content: ResumeContent = {
      kind: "resume",
      summary: [],
      experience: [
        {
          heading: { text: "Frontend Engineer", factIds: ["R1"] },
          bullets: [
            { text: "Used React, TypeScript, Jest and Node.", factIds: ["R3"] },
            { text: "Tested React components with Jest.", factIds: ["R3"] },
          ],
        },
      ],
      skills: [],
      education: [],
    }
    const repaired = repairDenseLines(content, keywordDensity(resumeLineRefs(content), KEYS).lineIds, WORDING).resume
    const texts = repaired.experience[0]!.bullets.map((bullet) => bullet.text.replace(/\.$/, "").toLowerCase())
    expect(new Set(texts).size).toBe(texts.length)
  })

  const mentions = (content: CoverLetterContent) => content.paragraphs.map((paragraph) => (paragraph.text.match(/\breact\b/gi) ?? []).length).reduce((a, b) => a + b, 0)
  const sentences = (count: number) => ["one", "two", "three", "four", "five", "six"].slice(0, count).map((n) => `I built React screens number ${n}.`)

  it("six mentions in one paragraph are cut to three", () => {
    expect(mentions(capLetterKeywords(letter([sentences(6).join(" ")]), [kw("React")]).letter)).toBe(3)
  })
  it("aliases count as mentions ('ReactJS', 'React.js', lower case)", () => {
    const capped = capLetterKeywords(letter(["I built React screens. I tested ReactJS code. I shipped React.js apps. I wrote react docs. Done here."]), [kw("React")])
    expect(capped.letter.paragraphs[0]?.text).toBe("I built React screens. I tested ReactJS code. I shipped React.js apps. Done here.")
  })

  // QA2-B8, fixed by Revision 2, R14 (owner decision D4: the cap of 3 is enforced in code by dropping the
  // extra sentence): a paragraph left empty is dropped while another body paragraph remains.
  it("BLOCKER QA2-B8a: six mentions in six one-sentence paragraphs are cut to three", () => {
    expect(mentions(capLetterKeywords(letter(sentences(6)), [kw("React")]).letter)).toBeLessThanOrEqual(3)
  })
  it("BLOCKER QA2-B8b: the 4th mention, alone in its paragraph, is not kept", () => {
    const capped = capLetterKeywords(letter(["I built React screens. I tested React code.", "I shipped React apps. I like plain work.", "I wrote React docs."]), [kw("React")])
    expect(mentions(capped.letter)).toBeLessThanOrEqual(3)
  })
})

describe("QA-B4 end to end in the letter repair: the dropped quote sentence leaves a clean letter", () => {
  it("'…was delivered.' is dropped and the fact sentence stays", () => {
    const text = `Your plan to “halve operational emissions by 2030” was delivered. ${FACT_LINE}`
    expect(dropUnsupportedSentences(letter([text]), FACTS, TARGET, null, NONE, GUARD).letter.paragraphs.map((paragraph) => paragraph.text)).toEqual([FACT_LINE])
  })
})
