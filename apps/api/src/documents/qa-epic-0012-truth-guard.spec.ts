/**
 * EPIC-0012 QA gate (step 6a): adversarial tests of the tailoring truth guard, written by an independent
 * QA session. Test file only; no product code changed.
 *
 * Convention: `it` asserts behaviour the design requires and the candidate already shows. `it.fails`
 * marks a case where the candidate lets through something the owner rules or design-decisions.md say must
 * not pass. Its body asserts the REQUIRED behaviour, so it fails today and `it.fails` reports green. Each
 * one is a BLOCKER in epics/active/EPIC-0012-tailoring-rules/test-plan.md. When the defect is fixed the
 * body passes, `it.fails` turns red, and the marker must be changed to `it`.
 *
 * "judged" below means the meaning check answered supported: true for that exact line (the service puts
 * the line text in `meaningChecked`). A fake set stands in for the model: real-model behaviour is not
 * tested here.
 */
import { describe, expect, it } from "vitest"

import { type AtsKeyword, containsKeyword, normaliseForAts } from "../ats/ats-score.js"
import { factClaimsMissing } from "../career-profile/claim-check.js"
import { verifyForwardStatements } from "../discovery/posting-extraction.js"
import { withoutDirectionQuote } from "./company-direction.js"
import { dropUnsupportedSentences, fallBackToFactWording, needsMeaningCheck, postingGuard, validateDocument } from "./document-claims.js"
import { buildGenerationPrompt } from "./document-generation.js"
import type { CoverLetterContent, DocumentLine, ResumeContent } from "./document-model.js"
import { headlineDecision, headlineFor } from "./headline.js"
import { KEYWORD_LINE_LIMIT, keywordDensity, repairDenseLines, resumeLineRefs } from "./keyword-density.js"
import { meaningKey } from "./line-text.js"

const FACTS = new Map([
  ["WIND", "Built wind farm financial models for offshore projects, forecasting revenue and cost"],
  ["PAY", "Supported the payments migration"],
  ["PAY_LED_BY", "Supported a payments migration led by the platform team"],
  ["TEAM_LEAD", "Supported the team lead on the payments migration"],
  ["MANAGED_BY", "Tested a billing project managed by the finance team"],
  ["ENERGY", "Energy finance analyst building cash flow models for wind farms"],
])
// Revision 2, R10: a name is a word the posting writes capitalised and never in lower case, wherever it
// stands. The second sentence writes the domain words in lower case, as the posting in the bridge case
// does (design 1a), so only true names such as ESG, CFA, Tableau and Verdant are lent as names.
const POSTING =
  "Sustainability consulting firm. Renewable energy and climate strategy. We work on renewable energy, climate and strategy projects. Carbon accounting and sustainability reporting matter. ESG reporting and a CFA charter help. Tableau dashboards. We seek a sustainability consultant to join 40 experts at Verdant Partners."
const QUOTES = ["Our aim is to halve operational emissions by 2030", "We will cut water use by 40% across the group"]
const GAPS = ["carbon accounting", "ghg protocol"]
const GUARD = postingGuard(POSTING, "Sustainability Consultant", GAPS, true, QUOTES)
const TARGET = { employer: "Verdant Partners", roleTitle: "Sustainability Consultant" }
const FACT_LINE = "I built wind farm financial models for offshore projects, forecasting revenue and cost."
const NONE: ReadonlySet<string> = new Set()
/** The verdict key a line's text gets with the facts it cites (R15): no verdict matches on text alone. */
const judged = (text: string, factId = "WIND"): ReadonlySet<string> => new Set([meaningKey(text, [factId])])

const summary = (text: string, factId = "WIND"): ResumeContent => ({ kind: "resume", summary: [{ text, factIds: [factId] }], experience: [], skills: [], education: [] })
const bullet = (text: string, factId = "WIND"): ResumeContent => ({
  kind: "resume",
  summary: [],
  experience: [{ heading: { text: FACTS.get(factId) ?? "", factIds: [factId] }, bullets: [{ text, factIds: [factId] }] }],
  skills: [],
  education: [],
})
const line = (text: string, factId = "WIND"): DocumentLine => ({ text, factIds: [factId] })
const letter = (paragraphs: readonly string[]): CoverLetterContent => ({
  kind: "cover_letter",
  greeting: "Dear Hiring Team,",
  opening: null,
  paragraphs: paragraphs.map((text) => ({ text, factIds: ["WIND"] })),
  closingLine: null,
  closing: "Kind regards,",
})

describe("QA EPIC-0012 rule 2: a line may not borrow evidence from the posting", () => {
  it.each([
    ["a number", "Built wind farm financial models for 40 offshore projects, forecasting revenue and cost.", "40"],
    ["a capitalised title", "Built wind farm financial models as Sustainability Consultant for offshore projects.", "consultant"],
    ["the employer", "Built wind farm financial models for Verdant offshore projects.", "verdant"],
    ["a gap tool, lower case", "Built wind farm financial models using ghg protocol for offshore projects.", "ghg protocol"],
    ["a gap skill", "Built wind farm financial models with carbon accounting, forecasting revenue and cost.", "carbon accounting"],
    ["a capitalised acronym", "Built wind farm financial models for ESG reporting, forecasting revenue and cost.", "esg"],
    ["a listed qualification", "Certified in wind farm financial models for offshore projects.", "certified"],
    ["a seniority word", "Senior wind farm financial models for offshore projects, forecasting revenue and cost.", "senior"],
    ["the posting title's role noun", "Built wind farm financial models as a consultant, forecasting revenue and cost.", "consultant"],
    ["a role noun from ROLE_NOUNS", "Built wind farm financial models as an analyst, forecasting revenue and cost.", "analyst"],
    ["a plural role noun", "Built wind farm financial models with consultants, forecasting revenue and cost.", "consultants"],
  ])("%s fails in code even when the judge says supported", (_name, text, word) => {
    const result = validateDocument(summary(text), FACTS, null, null, judged(text), GUARD)
    expect(result).toMatchObject({ ok: false, reason: "unsupported_claim" })
    if (!result.ok) expect(result.unsupported).toContain(word)
    expect(needsMeaningCheck(line(text), FACTS, null, null, "summary", GUARD)).toBe(false)
  })

  it("'senior' cannot be added to a fact that says 'analyst'", () => {
    const text = "Senior analyst building cash flow models for wind farms"
    expect(validateDocument(summary(text, "ENERGY"), FACTS, null, null, judged(text, "ENERGY"), GUARD)).toMatchObject({ ok: false, unsupported: ["senior"] })
  })

  it("three posting terms in one line exceed the cap even when judged", () => {
    const text = "Built wind farm financial models for renewable climate strategy, forecasting revenue and cost."
    const result = validateDocument(summary(text), FACTS, null, null, judged(text), GUARD)
    expect(result).toMatchObject({ ok: false, reason: "unsupported_claim" })
    if (!result.ok) expect(result.unsupported).toEqual(["renewable", "climate", "strategy"])
  })

  it.each([
    ["skills", { kind: "resume", summary: [], experience: [], skills: [line("wind farm models, renewable energy")], education: [] }],
    ["education", { kind: "resume", summary: [], experience: [], skills: [], education: [line("wind farm models, renewable energy")] }],
    ["an experience heading", { kind: "resume", summary: [], experience: [{ heading: line("Renewable energy models"), bullets: [] }], skills: [], education: [] }],
  ] as Array<[string, ResumeContent]>)("a posting term in %s is never lent, even when judged", (_name, content) => {
    const cited = [...content.skills, ...content.education, ...content.experience.map((entry) => entry.heading)]
    expect(validateDocument(content, FACTS, null, null, new Set(cited.map((each) => meaningKey(each.text, each.factIds))), GUARD)).toMatchObject({ ok: false, reason: "unsupported_claim" })
  })

  it.each(["Led", "Managed", "Owned", "Oversaw", "Directed", "Headed", "Spearheaded"])(
    "'%s' for 'Supported' needs the judge, and falls back when the judge refuses or fails",
    (verb) => {
      const text = `${verb} the payments migration`
      expect(validateDocument(summary(text, "PAY"), FACTS, null, null, NONE, GUARD)).toMatchObject({ ok: false, reason: "unsupported_claim" })
      expect(fallBackToFactWording(bullet(text, "PAY"), FACTS, FACTS, null, NONE, GUARD).resume.experience[0]?.bullets[0]?.text).toBe("Supported the payments migration")
    }
  )

  it("a scope verb in mid-line ('and later led') also needs the judge", () => {
    const text = "Supported and later led the payments migration"
    expect(needsMeaningCheck(line(text, "PAY"), FACTS, null, null, "summary", GUARD)).toBe(true)
    expect(validateDocument(summary(text, "PAY"), FACTS, null, null, NONE, GUARD)).toMatchObject({ ok: false, unsupported: ["led"] })
  })

  // BLOCKER QA-B1: design Revision 1 R1 checks for a doer position in the cited fact's own text. A fact that
  // uses the verb about someone else ("led by the platform team", "the team lead", "managed by finance")
  // must not let the Candidate claim the scope.
  it("BLOCKER QA-B1a: 'Led' for a fact that says 'Supported a migration led by the platform team'", () => {
    const text = "Led a payments migration"
    expect(validateDocument(summary(text, "PAY_LED_BY"), FACTS, null, null, NONE, GUARD).ok).toBe(false)
  })
  it("BLOCKER QA-B1b: 'Leads' for a fact that says 'Supported the team lead'", () => {
    const text = "Leads the payments migration"
    expect(validateDocument(summary(text, "TEAM_LEAD"), FACTS, null, null, NONE, GUARD).ok).toBe(false)
  })
  it("BLOCKER QA-B1c: 'Managed' for a fact that says 'Tested a project managed by the finance team'", () => {
    const text = "Managed a billing project"
    expect(validateDocument(summary(text, "MANAGED_BY"), FACTS, null, null, NONE, GUARD).ok).toBe(false)
  })
  it("a scope verb now reaches the judge: 'Led the API rewrite' after 'and led'", () => {
    const facts = new Map([["API", "Built the billing service and led the API rewrite"]])
    const text = "Led the API rewrite"
    expect(needsMeaningCheck(line(text, "API"), facts, null, null, "summary", GUARD)).toBe(true)
    expect(validateDocument(summary(text, "API"), facts, null, null, judged(text, "API"), GUARD)).toEqual({ ok: true })
  })

  // BLOCKER QA-B2: design Revision 1 R2 makes acronyms, qualifications and gap skills hard fails in any
  // case and through hyphens and word order, because the generation prompt tells the model to write posting
  // words in lower case.
  it("BLOCKER QA-B2a: lower-case 'esg reporting' (acronym) passes when judged", () => {
    const text = "Built wind farm financial models for esg reporting, forecasting revenue and cost."
    expect(validateDocument(summary(text), FACTS, null, null, judged(text), GUARD).ok).toBe(false)
  })
  it("BLOCKER QA-B2b: lower-case 'cfa' (qualification) passes when judged", () => {
    const text = "Built wind farm financial models as a cfa charterholder, forecasting revenue and cost."
    expect(validateDocument(summary(text), FACTS, null, null, judged(text), GUARD).ok).toBe(false)
  })
  it("BLOCKER QA-B2c: gap keyword hyphenated, 'carbon-accounting', passes when judged", () => {
    const text = "Built wind farm financial models with carbon-accounting, forecasting revenue and cost."
    expect(validateDocument(summary(text), FACTS, null, null, judged(text), GUARD).ok).toBe(false)
  })
  it("BLOCKER QA-B2d: gap keyword reordered, 'accounting for carbon', passes when judged", () => {
    const text = "Built wind farm financial models with accounting for carbon, forecasting revenue and cost."
    expect(validateDocument(summary(text), FACTS, null, null, judged(text), GUARD).ok).toBe(false)
  })
  it.each([
    ["a joined gap keyword", "Built wind farm financial models with carbonaccounting, forecasting revenue and cost."],
    ["a dotted acronym", "Built wind farm financial models for e.s.g reporting, forecasting revenue and cost."],
  ])("%s is a hard fail in code and never reaches the judge", (_name, text) => {
    expect(validateDocument(summary(text), FACTS, null, null, judged(text), GUARD).ok).toBe(false)
    expect(needsMeaningCheck(line(text), FACTS, null, null, "summary", GUARD)).toBe(false)
  })
  it.each([
    ["an acronym", "Built wind farm financial models for esg reporting, forecasting revenue and cost."],
    ["a qualification", "Built wind farm financial models as a cfa charterholder, forecasting revenue and cost."],
    ["a hyphenated gap keyword", "Built wind farm financial models with carbon-accounting, forecasting revenue and cost."],
    ["a reordered gap keyword", "Built wind farm financial models with accounting for carbon, forecasting revenue and cost."],
  ])("%s fails in code and never reaches the judge", (_name, text) => {
    expect(needsMeaningCheck(line(text), FACTS, null, null, "summary", GUARD)).toBe(false)
  })
  it("a posting phrase the posting writes in lower case still reaches the judge", () => {
    const text = "Built wind farm financial models for renewable energy, forecasting revenue and cost."
    expect(needsMeaningCheck(line(text), FACTS, null, null, "summary", GUARD)).toBe(true)
    expect(validateDocument(summary(text), FACTS, null, null, judged(text), GUARD)).toEqual({ ok: true })
  })
  it("a gap keyword the cited facts state in another case is not a hard fail", () => {
    const facts = new Map([["WIND", "Built wind farm financial models for Carbon Accounting, forecasting revenue and cost"]])
    const text = "Built wind farm financial models for carbon accounting, forecasting revenue and cost."
    expect(validateDocument(summary(text, "WIND"), facts, null, null, NONE, GUARD).ok).toBe(true)
  })
})

describe("QA EPIC-0012 rule 4: the quoted direction sentence", () => {
  const passes = (text: string) => validateDocument(letter([text]), FACTS, TARGET, null, NONE, GUARD).ok

  it.each([
    ["an altered year", `Your plan to “halve operational emissions by 2035” is clear. ${FACT_LINE}`],
    ["an unquoted year", `Your plan to halve operational emissions by 2030 is clear. ${FACT_LINE}`],
    ["an invented programme", `Your “35 by 35” plan is clear. ${FACT_LINE}`],
    ["a quoted claim that is no stored substring (design 2g)", `Your aim fits with “I cut emissions by 40%” in my record. ${FACT_LINE}`],
    ["a first-person ambition claim", `I will deliver your 2030 agenda. ${FACT_LINE}`],
    ["a first-person sentence around a real quote", `I will deliver “halve operational emissions by 2030” for you. ${FACT_LINE}`],
    ["two quoted spans in one sentence", `Your aims to “halve operational emissions by 2030” and “cut water use by 40%” are clear. ${FACT_LINE}`],
    ["a quote with changed case", `Your plan to “Halve Operational Emissions by 2030” is clear. ${FACT_LINE}`],
    ["single quotation marks", `Your plan to 'halve operational emissions by 2030' is clear. ${FACT_LINE}`],
    ["no you/your in the sentence", `The plan to “halve operational emissions by 2030” is clear. ${FACT_LINE}`],
    ["a contracted first person (we've)", `Your plan to “halve operational emissions by 2030” is one we've shared. ${FACT_LINE}`],
    ["a number outside the span", `Your aim to “halve operational emissions by 2030” matches 40 offshore projects.`],
    ["a gap skill outside the span", `Your aim to “halve operational emissions by 2030” needs carbon accounting, which these wind farm financial models offer.`],
  ])("%s fails", (_name, text) => {
    expect(passes(text)).toBe(false)
    // Even a supportive judge cannot release a number, a capital or a gap skill.
    expect(validateDocument(letter([text]), FACTS, TARGET, null, judged(text), GUARD).ok).toBe(false)
  })

  it("a 2-word span is not stripped: its words stay in and need the judge", () => {
    const text = `Your plan to “operational emissions” is clear. ${FACT_LINE}`
    expect(withoutDirectionQuote(text, QUOTES, { used: false })).toBeNull()
    expect(passes(text)).toBe(false)
  })

  it("a quote naming the employer blocks the whole letter (names_target) and is kept out of the prompt", () => {
    const text = `Your aim at Verdant Partners to “halve operational emissions by 2030” is clear. ${FACT_LINE}`
    expect(validateDocument(letter([text]), FACTS, TARGET, null, NONE, GUARD)).toMatchObject({ ok: false, reason: "names_target" })
    const prompt = buildGenerationPrompt([], { roleTitle: "Sustainability Consultant", company: "Verdant Partners", text: POSTING }, [], [], ["Verdant Partners will reach net zero by 2030"])
    expect(prompt).not.toContain("<company_direction>")
  })

  it("a quoted span in the resume is never stripped", () => {
    const text = "Your plan to “halve operational emissions by 2030” is clear."
    expect(validateDocument(summary(text), FACTS, null, null, judged(text), GUARD)).toMatchObject({ ok: false, unsupported: ["2030"] })
  })

  it("a second direction sentence in another paragraph drops, the first stays", () => {
    const first = `Your plan to “halve operational emissions by 2030” is clear. ${FACT_LINE}`
    const second = `Your plan to “cut water use by 40% across the group” is clear. ${FACT_LINE}`
    const result = dropUnsupportedSentences(letter([first, second]), FACTS, TARGET, null, judged(first), GUARD)
    expect(result.letter.paragraphs.map((paragraph) => paragraph.text)).toEqual([first, FACT_LINE])
  })

  // R3: isCopied tests whole tokens, so a span cut inside a number is not a copied quote.
  it("BLOCKER QA-B3: a span cut inside a number ('cut water use by 4' from 'by 40%') is not a copied quote", () => {
    expect(passes(`Your plan to “cut water use by 4” is clear. ${FACT_LINE}`)).toBe(false)
  })

  // R4: a word outside the span that is not a frame word blocks the strip, so the sentence fails in code
  // on the quote's number and never reaches the judge.
  it("BLOCKER QA-B4a: 'Your plan to “...2030” was met by these wind farm financial models' fails in code", () => {
    const text = "Your plan to “halve operational emissions by 2030” was met by these wind farm financial models built for offshore projects."
    expect(needsMeaningCheck({ text, factIds: ["WIND"] }, FACTS, TARGET, null, "letter_paragraph", GUARD) || !passes(text)).toBe(true)
  })
  it("BLOCKER QA-B4b: 'Your plan to “...2030” is what these wind farm financial models delivered' fails in code", () => {
    const text = "Your plan to “halve operational emissions by 2030” is what these wind farm financial models delivered."
    expect(needsMeaningCheck({ text, factIds: ["WIND"] }, FACTS, TARGET, null, "letter_paragraph", GUARD) || !passes(text)).toBe(true)
  })

  it("a direction sentence that keeps only frame words is stripped and passes when judged", () => {
    const text = `Your stated goal to “halve operational emissions by 2030” is clear. ${FACT_LINE}`
    expect(withoutDirectionQuote(text, QUOTES, { used: false })?.replace(/\s+/g, " ")).toContain("Your stated goal to is clear.")
    expect(validateDocument(letter([text]), FACTS, TARGET, null, judged(text), GUARD).ok).toBe(true)
  })
})

describe("QA EPIC-0012: the 'you/your' opener in career-profile/claim-check.ts opens no claim path", () => {
  it.each([
    ["Your Kubernetes platform team", "Led the platform team", ["kubernetes"]],
    ["Your Google Cloud migration", "Migrated services", ["google", "cloud"]],
    ["Your team grew 40%", "Grew the team", ["40"]],
    ["You Led AWS migration", "Migrated services", ["led", "aws"]],
    ["Your Staff Engineer title", "Engineer", ["staff", "title"]],
  ])("profile extraction: %s still reports its invented claims", (fact, quote, claims) => {
    for (const claim of claims) if (claim !== "title") expect(factClaimsMissing(fact, quote)).toContain(claim)
  })

  it("the opener word itself is the only thing exempted", () => {
    expect(factClaimsMissing("Your platform team", "Led the platform team")).toEqual([])
  })

  it("a letter sentence opened by 'Your' with an invented capitalised fact still fails", () => {
    const text = `Your Kubernetes rollout is clear. ${FACT_LINE}`
    const result = validateDocument(letter([text]), FACTS, TARGET, null, judged(text), GUARD)
    expect(result).toMatchObject({ ok: false, reason: "unsupported_claim" })
    if (!result.ok) expect(result.unsupported).toContain("kubernetes")
  })
})

describe("QA EPIC-0012 rule 1: headline support", () => {
  it.each([
    ["dotted posting title", "E.S.G. Analyst", ["ESG Analyst"], null],
    ["partial overlap", "Senior Sustainability Analyst", ["Sustainability Analyst"], null],
    ["Lead vs Senior", "Lead Analyst", ["Senior Analyst"], null],
    ["two titles combined", "Sustainability Analyst and Head of Finance", ["Sustainability Analyst", "Head of Finance"], null],
    ["Head of Sustainability from two titles", "Head of Sustainability", ["Sustainability Analyst", "Head of Finance"], null],
    ["digits", "Analyst Level 2", ["Analyst Level 2"], null],
    ["9 words", "Senior Sustainability Analyst for Energy Finance Group Europe North", ["Senior Sustainability Analyst for Energy Finance Group Europe North"], null],
    ["location with a dash", "Sustainability Analyst – Remote", ["Sustainability Analyst"], null],
    ["location with a comma", "Sustainability Analyst, London", ["Sustainability Analyst"], null],
    ["location in brackets", "Sustainability Analyst [London]", ["Sustainability Analyst"], null],
    ["a second role after a slash", "Sustainability Analyst / Consultant", ["Sustainability Analyst"], null],
    ["a contact detail", "Sustainability Analyst https://x.io", ["Sustainability Analyst"], null],
    ["a supported subset", "Sustainability Analyst", ["Senior Sustainability Analyst"], "Sustainability Analyst"],
  ] as Array<[string, string, string[], string | null]>)("%s", (_name, title, profile, expected) => {
    expect(headlineFor(title, profile)).toBe(expected)
  })

  it("partial overlap logs only a count of missing words", () => {
    expect(headlineDecision("Head of Sustainability", ["Sustainability Analyst", "Head of Finance"])).toEqual({ headline: null, missing: 1 })
  })

  // R5: one profile entry may hold two titles, and their words never combine into a third.
  it("BLOCKER QA-B5a: 'Head of Sustainability' from one entry 'Sustainability Analyst / Head of Finance'", () => {
    expect(headlineFor("Head of Sustainability", ["Sustainability Analyst / Head of Finance"])).toBeNull()
  })
  it("BLOCKER QA-B5b: 'Senior Data Engineer' from one entry 'Data Analyst to Senior Software Engineer'", () => {
    expect(headlineFor("Senior Data Engineer", ["Data Analyst to Senior Software Engineer"])).toBeNull()
  })
  it("R5: an '&' title prints only from an owner-approved alternate, never from the profile entry", () => {
    const title = "Head of Research & Development"
    expect(headlineFor(title, [title])).toBeNull()
    expect(headlineFor(title, [], [title])).toBe(title)
  })
})

describe("QA EPIC-0012 rule 3: keyword caps", () => {
  const kw = (name: string): AtsKeyword => ({ keyword: name, kind: "technology", group: `one:${name.toLowerCase()}` })
  const KEYS = [kw("React"), kw("TypeScript"), kw("Jest"), kw("Node")]
  const WORDING = new Map([
    ["R1", "Built a React dashboard for merchants"],
    ["R2", "Migrated the React app to TypeScript"],
    ["R3", "Tested React components with Jest"],
  ])
  const resume = (bullets: readonly DocumentLine[], skills: readonly DocumentLine[] = []): ResumeContent => ({
    kind: "resume",
    summary: [],
    experience: [{ heading: { text: "Frontend Engineer", factIds: ["R1"] }, bullets }],
    skills,
    education: [],
  })

  it("a skills line with every keyword is never flagged or changed", () => {
    const skills = [{ text: "React, TypeScript, Jest, Node, React Native", factIds: ["R1"] }]
    const content = resume([{ text: "Built a React dashboard.", factIds: ["R1"] }], skills)
    const density = keywordDensity(resumeLineRefs(content), KEYS)
    expect(density.lineIds).toEqual([])
    expect(repairDenseLines(content, density.lineIds, WORDING).resume.skills).toEqual(skills)
  })

  it("a keyword in three body lines flags the third; an alias counts", () => {
    const content = resume([
      { text: "Built a React dashboard.", factIds: ["R1"] },
      { text: "Moved the app to React.", factIds: ["R2"] },
      { text: "Tested ReactJS components.", factIds: ["R3"] },
    ])
    expect(keywordDensity(resumeLineRefs(content), KEYS).lineIds).toEqual(["experience:0:bullet:2"])
  })

  it("a four-keyword bullet is crowded and repaired to its fact wording, never blocked", () => {
    const content = resume([{ text: "Used React, TypeScript, Jest and Node.", factIds: ["R3"] }])
    const density = keywordDensity(resumeLineRefs(content), KEYS)
    expect(density.crowdedLineIds).toEqual(["experience:0:bullet:0"])
    expect(repairDenseLines(content, density.lineIds, WORDING).resume.experience[0]?.bullets[0]?.text).toBe("Tested React components with Jest")
  })

  // QA-B6 (fixed in Revision 1, R6): repairDenseLines now shares `sameLine` with fallBackToFactWording,
  // so two bullets citing one fact never print the same text twice.
  it("BLOCKER QA-B6: density repair never prints the same bullet twice", () => {
    const content = resume([
      { text: "Built a React dashboard.", factIds: ["R1"] },
      { text: "Moved the React app to TypeScript.", factIds: ["R2"] },
      { text: "Tested React components with Jest.", factIds: ["R3"] },
      { text: "Used React, TypeScript, Jest and Node in one place.", factIds: ["R3"] },
    ])
    const repaired = repairDenseLines(content, keywordDensity(resumeLineRefs(content), KEYS).lineIds, WORDING).resume
    const texts = repaired.experience[0]!.bullets.map((each) => each.text)
    expect(new Set(texts).size).toBe(texts.length)
  })

  // QA-R1 (owner decision: option A). The cap of 2 counts only keyword uses the model added. A line
  // that falls back to the fact's own wording is the Candidate's text, never stuffing, so a resume may
  // show a core keyword 3+ times when the profile states it. The test asserts that no model-added use
  // survives over the cap, and that the profile's own wording is kept.
  it("QA-R1 (option A): after repair no model-added keyword use is over the cap", () => {
    const content = resume([
      { text: "Built a React dashboard.", factIds: ["R1"] },
      { text: "Moved the React app to TypeScript.", factIds: ["R2"] },
      { text: "Tested React components with Jest.", factIds: ["R3"] },
    ])
    const repaired = repairDenseLines(content, keywordDensity(resumeLineRefs(content), KEYS).lineIds, WORDING).resume
    // A keyword present in the cited fact's own wording is not an added use.
    const added = KEYS.map(({ keyword }) =>
      resumeLineRefs(repaired).filter(({ line }) => {
        const cited = normaliseForAts(line.factIds.map((factId) => WORDING.get(factId) ?? "").join(" "))
        return containsKeyword(normaliseForAts(line.text), keyword) && !containsKeyword(cited, keyword)
      }).length
    )
    expect(added.every((count) => count <= KEYWORD_LINE_LIMIT)).toBe(true)
    // The fact wording survives: each fact states React, so the resume shows it three times.
    expect(keywordDensity(resumeLineRefs(repaired), KEYS).repeated).toContainEqual({ keyword: "React", count: 3 })
  })
})

describe("QA EPIC-0012 rule 4 source: forward statements from the posting only", () => {
  const POST = "Our aim is to halve operational emissions by 2030. You will join our team. Call +44 20 7946 0000 about our 2030 plan today."

  it.each([
    ["an altered quote", "Our aim is to halve operational emissions by 2035"],
    ["a requirement on the applicant", "You will join our team."],
    ["a contact detail", "Call +44 20 7946 0000 about our 2030 plan today."],
    ["a quote too short", "by 2030"],
  ])("drops %s", (_name, quote) => {
    expect(verifyForwardStatements([quote], POST)).toEqual([])
  })

  it("keeps an exact quote", () => {
    expect(verifyForwardStatements(["Our aim is to halve operational emissions by 2030"], POST)).toEqual(["Our aim is to halve operational emissions by 2030"])
  })

  it("a posting with no forward statements gives no company_direction block", () => {
    const prompt = buildGenerationPrompt([], { roleTitle: "Analyst", company: "Verdant", text: "Build models." }, [], [], [])
    expect(prompt).not.toContain("<company_direction>")
  })
})
