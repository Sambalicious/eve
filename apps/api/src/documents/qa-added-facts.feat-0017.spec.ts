import { describe, expect, it } from "vitest"

import { describeBlock } from "./blocked-claim.js"
import { containsAddedFactContactDetail } from "../added-facts/added-fact-contact-detail.js"
import { containsContactDetail } from "./contact-detail.js"
import { validateDocument, postingGuard } from "./document-claims.js"
import type { DocumentContent, DocumentLine, CoverLetterContent, ResumeContent } from "./document-model.js"
import { keywordNamed } from "./keyword-match.js"
import { meaningKey } from "./line-text.js"

/**
 * FEAT-0017 QA authoring [5e], truth-guard side. Independent of the implementation session.
 * Sources: `gherkin/added-skills-documents-truth-guard.feature` (AC 3.4, 5.2 to 5.12, 9.4, 10.1 to 10.7),
 * `api-contract.md` v1.32.0 (blocked causes, `addedFactUsed`, stale data), `architecture.md` (generation
 * section 4 and 5: added facts enter the validator map with in-memory `added:s:`/`added:o:` ids, with no
 * new `validateDocument` parameter).
 *
 * Every title names its Gherkin scenario line and its AC tag. Expected red until the candidate lands.
 */

/** Background facts of the documents Truth Guard feature (F1 to F4), plus the added facts A1 and A2. */
const FACTS = new Map([
  ["F1", "Built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd"],
  ["F2", "Senior Frontend Engineer at Brightwave Ltd, 2021 to 2024"],
  ["F3", "Mentored 6 junior developers"],
  ["F4", "Frontend Engineer at Acme Ltd, 2018 to 2021"],
  ["F5", "Familiar with Figma from design reviews at Brightwave Ltd"],
])

/** The ids generation puts in the validator map: the prefix carries the kind. */
const A1 = "added:s:00000000-0000-4000-8000-0000000000a1"
const A2 = "added:o:00000000-0000-4000-8000-0000000000a2"
const A7 = "added:o:00000000-0000-4000-8000-0000000000a7"
const ADDED = new Map([
  [A1, "Figma"],
  [A2, "Set up GitHub Actions CI/CD pipelines at Acme"],
])

const POSTING = "Build design systems with React and TypeScript. You own CI/CD pipelines and Figma handoff."
const GAPS = ["Figma", "design systems", "CI/CD pipelines"]
const GUARD = postingGuard(POSTING, "Senior Frontend Engineer", GAPS)

/** Every line of the document, as if the meaning check supported it (the judge cannot release the new rule). */
function allLineTexts(content: DocumentContent): Set<string> {
  const lines =
    content.kind === "cover_letter"
      ? content.paragraphs
      : [...content.summary, ...content.experience.flatMap((entry) => [entry.heading, ...entry.bullets]), ...content.skills, ...content.education]
  return new Set(lines.map((line) => meaningKey(line.text, line.factIds)))
}

function validateJudged(
  content: DocumentContent,
  facts: ReadonlyMap<string, string> = new Map([...FACTS, ...ADDED]),
  target: { employer: string; roleTitle: string } | null = null,
  posting: ReturnType<typeof postingGuard> | null = null
) {
  return validateDocument(content, facts, target, null, allLineTexts(content), posting)
}

function resume(line: DocumentLine, extra: Partial<ResumeContent> = {}): ResumeContent {
  return {
    kind: "resume",
    summary: [],
    experience: [{ heading: { text: "Senior Frontend Engineer, Brightwave Ltd, 2021 to 2024", factIds: ["F2"] }, bullets: [line] }],
    skills: [],
    education: [],
    ...extra,
  }
}

function bullet(text: string, factIds: readonly string[]): ResumeContent {
  return resume({ text, factIds })
}

function skills(text: string, factIds: readonly string[]): ResumeContent {
  return resume({ text: "Mentored 6 junior developers", factIds: ["F3"] }, { skills: [{ text, factIds }] })
}

function summary(text: string, factIds: readonly string[]): ResumeContent {
  return resume({ text: "Mentored 6 junior developers", factIds: ["F3"] }, { summary: [{ text, factIds }] })
}

function education(text: string, factIds: readonly string[]): ResumeContent {
  return resume({ text: "Mentored 6 junior developers", factIds: ["F3"] }, { education: [{ text, factIds }] })
}

function letter(text: string, factIds: readonly string[]): CoverLetterContent {
  return { kind: "cover_letter", greeting: "Dear team,", opening: null, paragraphs: [{ text, factIds }], closingLine: null, closing: "Regards," }
}

const TARGET = { employer: "Northwind Labs", roleTitle: "Senior Frontend Engineer" } as const

describe("QA FEAT-0017: a skill-only fact is cited only by a Skills line or a skill-only letter paragraph (@ac-5.3, @ac-10.3, @ac-10.4)", () => {
  it("documents-truth-guard:156 @ac-5.3 @ac-10.3: a resume Skills line citing a skill-only fact passes the gap check for that term", () => {
    expect(validateDocument(skills("Figma", [A1]), new Map([...FACTS, ...ADDED]), null, null, new Set(), GUARD)).toEqual({ ok: true })
  })

  it("documents-truth-guard:162 @ac-5.3 @ac-10.3: the same term with no added fact is blocked as gap", () => {
    expect(validateDocument(skills("Figma", ["F1"]), new Map([...FACTS, ...ADDED]), null, null, new Set(), GUARD)).toMatchObject({ ok: false, reason: "unsupported_claim", hardFail: "gap" })
  })

  it.each([
    ["experience bullet", "Worked with Figma at Brightwave Ltd", [A1]],
    ["experience bullet with a profile fact", "Built a React dashboard with Figma at Brightwave Ltd", ["F1", A1]],
    ["summary line", "Frontend engineer skilled in Figma", [A1]],
    ["summary line with a profile fact", "Senior frontend engineer who built dashboards with Figma", ["F2", A1]],
    ["education line", "Learned Figma at university", [A1]],
  ] as const)("documents-truth-guard:167 @ac-5.3 @ac-10.4: a %s citing a skill-only fact is blocked with the skill-only failure kind", (_kind, line, cites) => {
    const content = _kind === "experience bullet" || _kind === "experience bullet with a profile fact" ? bullet(line, [...cites]) : _kind === "summary line" || _kind === "summary line with a profile fact" ? summary(line, [...cites]) : education(line, [...cites])
    expect(validateJudged(content)).toMatchObject({ ok: false, reason: "unsupported_claim", hardFail: "skill_only_in_bullet" })
  })

  it("documents-truth-guard:183 @ac-5.3 @ac-10.4: a bullet citing a skill-only fact together with a one-liner is still blocked", () => {
    expect(validateJudged(bullet("Handed off Figma designs to 3 engineers at Acme", [A1, A2]))).toMatchObject({ ok: false, reason: "unsupported_claim", hardFail: "skill_only_in_bullet" })
  })

  it("documents-truth-guard:189 @ac-5.3 @ac-10.4: a Skills line citing a skill-only fact together with a profile fact is accepted", () => {
    expect(validateJudged(skills("React, TypeScript, Figma", ["F1", A1]), new Map([...FACTS, ...ADDED]), null, GUARD)).toEqual({ ok: true })
  })

  it("documents-truth-guard:195 @ac-5.3: the skill-only block is deterministic and ignores the meaning check", () => {
    // `allLineTexts` marks every line judged (supported), which is precisely what must not release it.
    expect(validateJudged(bullet("Worked with Figma at Brightwave Ltd", [A1]))).toMatchObject({ ok: false, hardFail: "skill_only_in_bullet" })
  })

  it("documents-truth-guard:209 @ac-5.3: an upgraded skill-only fact is no longer subject to the skill-only block", () => {
    // The upgraded fact is a one-liner that now states the sentence itself (A2's text is the CI/CD sentence, and a line
    // may say only what its cited facts say: api-contract.md, claim check).
    const A3 = "added:o:00000000-0000-4000-8000-0000000000a3"
    const upgraded = new Map([...FACTS, ...ADDED, [A3, "Handed off Figma designs to 3 engineers at Acme"]])
    expect(validateJudged(bullet("Handed off Figma designs to 3 engineers at Acme", [A3]), upgraded)).toEqual({ ok: true })
  })
})

describe("QA FEAT-0017: in the cover letter a skill-only fact is a plain mention only (@ac-5.4, @ac-10.4)", () => {
  it("documents-truth-guard:219 @ac-5.4 @ac-10.4: a cover letter line that names the skill passes", () => {
    expect(validateJudged(letter("I also work in Figma.", [A1]), new Map([...FACTS, ...ADDED]), TARGET, GUARD)).toEqual({ ok: true })
  })

  it.each([
    ["employer", "I used Figma at Brightwave Ltd."],
    ["role", "As a Senior Frontend Engineer I used Figma."],
    ["period", "I used Figma from 2021 to 2024."],
    ["number", "I handed off 40 Figma files."],
    ["outcome", "I cut design review time with Figma."],
    ["level", "I am an expert in Figma."],
  ])("documents-truth-guard:225 @ac-5.4 @ac-10.4: a letter line crediting the skill to a %s is blocked", (_credit, line) => {
    expect(validateJudged(letter(line, [A1]), new Map([...FACTS, ...ADDED]), TARGET, GUARD)).toMatchObject({ ok: false })
  })

  it("documents-truth-guard:240 @ac-5.4 (Decided, OD-19): a mixed citation that credits a skill to an employer is a hard fail", () => {
    expect(validateJudged(letter("At Brightwave Ltd I built a React dashboard and used Figma.", ["F1", A1]), new Map([...FACTS, ...ADDED]), TARGET, GUARD)).toMatchObject({ ok: false, hardFail: "skill_only_in_bullet" })
  })

  it("documents-truth-guard:247 @ac-5.4 @ac-3.4: a letter may not describe a skill-only fact with hedge wording", () => {
    expect(validateJudged(letter("I am familiar with Figma.", [A1]), new Map([...FACTS, ...ADDED]), TARGET, GUARD)).toMatchObject({ ok: false, hardFail: "added_fact_hedge" })
  })
})

describe("QA FEAT-0017: a cited added fact id is valid only for its own Application (@ac-5.2, @ac-10.5)", () => {
  it("documents-truth-guard:107 @ac-5.2: a line citing an added fact of this Application is not unknown_fact", () => {
    expect(validateJudged(bullet("Set up GitHub Actions CI/CD pipelines at Acme", [A2]))).not.toMatchObject({ reason: "unknown_fact" })
  })

  it.each([
    ["an added fact id of a different Application", A7],
    ["an id that exists nowhere", "added:o:00000000-0000-4000-8000-0000000000ff"],
    ["an id in neither namespace", "X1"],
    ["a Career Profile fact id of an unapproved draft", "F9"],
    ["an empty citation", ""],
  ])("documents-truth-guard:113 @ac-5.2 @ac-10.5: a citation naming %s is blocked as unknown_fact", (_case, id) => {
    expect(validateJudged(bullet("Set up CI/CD pipelines at Acme", [id]))).toMatchObject({ ok: false, reason: "unknown_fact" })
  })

  it("documents-truth-guard:127 @ac-5.2 @ac-10.5: a line citing a removed added fact is blocked as unknown_fact", () => {
    expect(validateJudged(bullet("Set up GitHub Actions CI/CD pipelines at Acme", [A2]), new Map([...FACTS, [A1, "Figma"]]))).toMatchObject({ ok: false, reason: "unknown_fact" })
  })

  it("documents-truth-guard:139 @ac-5.2: the accepted set is the approved facts plus this Application's added facts, no more", () => {
    // A draft F9 and another Application's A7 are both outside the map the service builds.
    expect(validateJudged(bullet("Set up GitHub Actions CI/CD pipelines at Acme", ["F9"]))).toMatchObject({ ok: false, reason: "unknown_fact" })
    expect(validateJudged(bullet("Set up GitHub Actions CI/CD pipelines at Acme", [A7]))).toMatchObject({ ok: false, reason: "unknown_fact" })
  })

  it("documents-truth-guard:147 @ac-5.2: a line that cites no fact is blocked, as today", () => {
    expect(validateJudged(bullet("Enjoys hard problems", []))).toMatchObject({ ok: false, reason: "no_fact" })
  })
})

describe("QA FEAT-0017: every claim check except the source quote applies to added facts (@ac-5.5, @ac-5.8, @ac-5.9, @ac-10.2)", () => {
  it("documents-truth-guard:257 @ac-5.5 @ac-10.2: a bullet citing only a one-liner passes when its claims are in the fact's text", () => {
    expect(validateJudged(bullet("Set up GitHub Actions CI/CD pipelines at Acme", [A2]))).toEqual({ ok: true })
  })

  it.each([
    ["a number", "Set up 12 GitHub Actions CI/CD pipelines at Acme"],
    ["a name", "Set up GitHub Actions CI/CD pipelines at Contoso Ltd"],
    ["a technology", "Set up GitHub Actions CI/CD pipelines with Docker at Acme"],
    ["a date", "Set up GitHub Actions CI/CD pipelines at Acme in 2019"],
    ["a title", "As a Staff Engineer I set up GitHub Actions CI/CD pipelines at Acme"],
  ])("documents-truth-guard:263 @ac-5.5 @ac-10.2 @ac-5.8: a bullet citing a one-liner with %s is blocked", (_added, line) => {
    expect(validateJudged(bullet(line, [A2]))).toMatchObject({ ok: false })
  })

  it("documents-truth-guard:277 @ac-5.5: a one-liner may be cited by the Skills line and in the cover letter", () => {
    expect(validateJudged(skills("CI/CD pipelines", [A2]), new Map([...FACTS, ...ADDED]), null, GUARD)).toEqual({ ok: true })
    expect(validateJudged(letter("I set up GitHub Actions CI/CD pipelines at Acme.", [A2]), new Map([...FACTS, ...ADDED]), TARGET, GUARD)).toEqual({ ok: true })
  })

  it("documents-truth-guard:321 @ac-5.8: an added fact is not subject to the source-quote check", () => {
    // No sourceQuote exists for an added fact; quoting the fact's own words is a legal source.
    expect(validateJudged(letter('I set up "GitHub Actions CI/CD" pipelines at Acme.', [A2]))).not.toMatchObject({ hardFail: "unsourced_quote" })
  })

  it.each([
    ["a number, a period and an extra employer", "Set up GitHub Actions CI/CD pipelines at Acme for 14 teams, 2018 to 2021"],
    ["another tool", "Set up GitHub Actions and Jenkins CI/CD pipelines at Acme"],
  ])("documents-truth-guard:328 @ac-5.8: a line citing an added and a profile fact may add nothing for %s", (_case, line) => {
    expect(validateJudged(bullet(line, [A2, "F4"]))).toMatchObject({ ok: false })
  })

  it("documents-truth-guard:328 @ac-5.8: a role verb the cited facts do not state is left to the meaning check, never passed unjudged", () => {
    // The deterministic claim check is word based; "Led a team" is the judge's call (architecture, generation section 4).
    // With every line marked judged-supported it passes by design, so the rule is asserted on the unjudged path.
    const line = bullet("Led a team that set up GitHub Actions CI/CD pipelines at Acme", [A2, "F4"])
    expect(validateDocument(line, new Map([...FACTS, ...ADDED]), null, null, new Set(), GUARD)).toMatchObject({ ok: false })
  })

  it("documents-truth-guard:340 @ac-5.8 @ac-10.7: the meaning check applies to lines citing an added fact", () => {
    const unsupported = new Map([...FACTS, ...ADDED])
    expect(validateDocument(bullet("Owned the CI/CD pipelines at Acme", [A2]), unsupported, null, null, new Set(), GUARD)).toMatchObject({ ok: false })
  })

  it("documents-truth-guard:351 @ac-5.9: a posting keyword is citable only because the Candidate ticked or wrote it", () => {
    expect(validateJudged(skills("CI/CD pipelines", [A1]), new Map([...FACTS, ...ADDED]), null, GUARD)).toMatchObject({ ok: false, hardFail: "gap" })
  })

  it("documents-truth-guard:357 @ac-5.9: the gap check passes a line only when its cited facts state the keyword", () => {
    expect(validateJudged(skills("CI/CD pipelines, Figma", [A2]), new Map([...FACTS, ...ADDED]), null, GUARD)).toMatchObject({ ok: false, hardFail: "gap" })
  })

  it("documents-truth-guard:363 @ac-5.9: a line citing an added fact may not name the target company or role", () => {
    expect(validateJudged(letter("I set up GitHub Actions CI/CD pipelines at Acme and want to join Northwind Labs.", [A2]), new Map([...FACTS, ...ADDED]), TARGET, GUARD)).toMatchObject({ ok: false, reason: "names_target" })
  })

  it("documents-truth-guard:369 @ac-5.9: a posting term the Candidate did not state is still blocked", () => {
    expect(validateJudged(letter("I also work in Figma and Kubernetes.", [A1]), new Map([...FACTS, ...ADDED]), TARGET, GUARD)).toMatchObject({ ok: false })
  })
})

describe("QA FEAT-0017: the validator is unchanged for inputs that cite no added fact (@ac-10.1)", () => {
  it.each([
    ["experience bullet", "Built a React and TypeScript merchant dashboard at Brightwave Ltd", ["F1"], true],
    ["experience bullet", "Built a Vue merchant dashboard at Brightwave Ltd", ["F1"], false],
    ["experience bullet", "Mentored 9 junior developers", ["F3"], false],
    ["resume Skills line", "React, TypeScript", ["F1"], true],
    ["resume Skills line", "Figma", ["F1"], false],
  ] as const)("documents-truth-guard:384 @ac-10.1: a %s decided as before (%s)", (kind, line, cites, accepted) => {
    const content = kind === "resume Skills line" ? skills(line, [...cites]) : bullet(line, [...cites])
    const result = validateJudged(content, new Map([...FACTS, ...ADDED]), null, GUARD)
    if (accepted) expect(result).toEqual({ ok: true })
    else expect(result).toMatchObject({ ok: false })
  })

  it("documents-truth-guard:398 @ac-10.1: adding a fact never makes an unrelated line pass", () => {
    expect(validateJudged(bullet("Mentored 9 junior developers", ["F3"]))).toMatchObject({ ok: false })
  })
})

describe("QA FEAT-0017: documents never turn an added fact into aspiration (@ac-3.4, @ac-10.7)", () => {
  it.each([
    ["Learning Figma", A1],
    ["Familiar with Figma", A1],
    ["Exposure to GitHub Actions CI/CD pipelines at Acme", A2],
    ["Currently studying CI/CD pipelines at Acme", A2],
  ])("documents-truth-guard:408 @ac-3.4 @ac-10.7: a line %j citing an added fact is blocked", (line, id) => {
    const result = validateJudged(bullet(line, [id]))
    expect(result).toMatchObject({ ok: false })
    // A skill-only citation in a bullet is already forbidden; a one-liner citation reaches the hedge rule itself.
    if (id === A2) expect(result).toMatchObject({ hardFail: "added_fact_hedge" })
  })

  it("documents-truth-guard:421 @ac-3.4: hedge wording is allowed when a Career Profile fact already says it", () => {
    expect(validateJudged(skills("Familiar with Figma", ["F5"]), new Map([...FACTS, ...ADDED]), null, GUARD)).toEqual({ ok: true })
  })
})

describe("QA FEAT-0017: the two new blocked causes map to their own records (@ac-5.3, @ac-3.4, OD-19, A-8)", () => {
  const failed = (hardFail: string) =>
    ({ ok: false, reason: "unsupported_claim", claim: "Worked with Figma at Brightwave Ltd", unsupported: ["figma"], hardFail }) as unknown as Parameters<typeof describeBlock>[0]

  it("documents-truth-guard:202 @ac-5.3: skill_only_in_bullet stores its own cause and no terms", () => {
    expect(describeBlock(failed("skill_only_in_bullet"))).toEqual({ cause: "skill_only_in_bullet", terms: null, moreTerms: null })
  })

  it("documents-truth-guard:247 @ac-3.4 (A-8): added_fact_hedge stores its own cause, so the alert offers no add-a-fact action", () => {
    expect(describeBlock(failed("added_fact_hedge"))).toEqual({ cause: "added_fact_hedge", terms: null, moreTerms: null })
  })
})

describe("QA FEAT-0017: keywordNamed, the one matcher behind OD-12, OD-19 and AC 2.3 (@ac-2.3, @ac-7.2)", () => {
  it.each<[string, string, boolean?]>([
    ["Set up GitHub Actions CI/CD pipelines at Acme", "CI/CD pipelines"],
    ["Set up the release workflow at Acme", "CI/CD pipelines", false],
    ["Wrote frontend tests with Jest and Testing Library at Acme", "frontend testing"],
    ["Maintained a design system of 40 components at Acme", "design systems"],
    ["Handed off Figma designs to 3 engineers at Acme", "Figma"],
    ["Own the design process end to end", "Figma", false],
    ["Experience with Figma", "Figma"],
    ["Experience designing interfaces", "Figma", false],
    ["Production CI/CD pipeline work", "CI/CD pipelines"],
    ["Build and maintain our Figma-based design handoff", "Figma"],
    ["Write frontend tests", "frontend testing"],
    ["Own CI/CD pipelines for the web app", "CI/CD pipelines"],
    ["shipped FIGMA handoffs", "Figma"],
  ])("one-liners:101 @ac-2.3 / match-and-queue:85 @ac-7.2: keywordNamed(%j, %j) is %s", (text: string, term: string, expected: boolean | undefined) => {
    expect(keywordNamed(text, term)).toBe(expected ?? true)
  })

  it("match-and-queue:129 @ac-7.2 (OD-19): a one-word skill-only term backs a multi-word requirement that contains it", () => {
    expect(keywordNamed("Maintain a component library", "library")).toBe(true)
  })

  it("match-and-queue:92 @ac-7.2: a skill-only term never backs a requirement that does not name it", () => {
    expect(keywordNamed("Own the design process end to end", "Figma")).toBe(false)
    expect(keywordNamed("Mentor junior engineers", "design systems")).toBe(false)
  })
})

describe("QA FEAT-0017: rewrite coverage at the validator seam (@ac-5.2, @ac-2.5)", () => {
  it("documents-truth-guard:133 @ac-5.2 @ac-10.5: a line citing another Application's added fact is blocked even when the text would be true", () => {
    // A7 belongs to another Application. Generation builds the validator map from this Application's added facts only
    // (architecture, generation section 4), so A7 is absent from the map even though its sentence equals A2's.
    const own = new Map([...FACTS, ...ADDED])
    expect(validateDocument(bullet("Set up GitHub Actions CI/CD pipelines at Acme", [A7]), own, null, null, new Set(), GUARD)).toMatchObject({ ok: false, reason: "unknown_fact" })
  })

  it("added-skills-one-liners:163 @ac-2.5: the contact-detail check is the same detector the Career Profile uses", () => {
    // Lead ruling: the shared `containsContactDetail` is unchanged (flag-off decisions stay as they were). The link rule
    // applies to added-fact text only, through `containsAddedFactContactDetail`.
    const shared = [
      "Set up CI/CD at Acme, write to ada@example.com",
      "Set up CI/CD at Acme, call +234 801 234 5678",
    ]
    const link = "Set up CI/CD at Acme, see https://github.com/acme/pipelines"
    for (const text of shared) expect(containsContactDetail(text, null)).toBe(true)
    expect(containsContactDetail(link, null)).toBe(false)
    for (const text of [...shared, link, "Set up CI/CD at Acme, see www.example.com/pipelines"]) expect(containsAddedFactContactDetail(text, null)).toBe(true)
    expect(containsAddedFactContactDetail("Built a Node.js build pipeline at Acme", null)).toBe(false)
    for (const text of shared) expect(validateDocument(letter(text, [A2]), new Map([...FACTS, ...ADDED]), TARGET, null, new Set(), GUARD)).toMatchObject({ reason: "contact_detail" })
  })
})
