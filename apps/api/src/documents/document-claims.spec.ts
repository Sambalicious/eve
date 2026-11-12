import { describe, expect, it } from "vitest"

import type { AtsKeyword } from "../ats/ats-score.js"
import type { CoverLetterContent, DocumentContent, DocumentLine, ResumeContent } from "./document-model.js"
import { dropUnsupportedSentences, fallBackToFactWording, needsMeaningCheck, postingGuard, postingTerms, refusedSentence, settleCappedLetter, validateDocument } from "./document-claims.js"
import { capLetterKeywords } from "./letter-keyword-cap.js"
import { meaningKey } from "./line-text.js"

/** Gherkin r5 tailored-documents.feature background. */
const FACTS = new Map([
  ["F1", "Built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd"],
  ["F2", "Senior Frontend Engineer at Brightwave Ltd, 2021–2024"],
  ["F3", "Mentored 6 junior developers"],
  ["F4", "Cut release cycle from 2 weeks to 3 days"],
])

/** Every line in the document, as if the meaning check supported it (Revision 2, R15: text plus its facts). */
function allLineTexts(content: DocumentContent): Set<string> {
  const lines = content.kind === "cover_letter" ? content.paragraphs : [
    ...content.summary,
    ...content.experience.flatMap((entry) => [entry.heading, ...entry.bullets]),
    ...content.skills,
    ...content.education,
  ]
  return new Set(lines.map((line) => meaningKey(line.text, line.factIds)))
}

/** Validate a document whose reworded lines the judge supported. */
function validateJudged(
  content: DocumentContent,
  facts: ReadonlyMap<string, string> = FACTS,
  target: { employer: string; roleTitle: string } | null = null,
  posting: ReturnType<typeof postingGuard> | null = null
) {
  return validateDocument(content, facts, target, null, allLineTexts(content), posting)
}

function resume(line: string, factIds: readonly string[]): ResumeContent {
  return {
    kind: "resume",
    summary: [],
    experience: [{ heading: { text: "Senior Frontend Engineer, Brightwave Ltd, 2021–2024", factIds: ["F2"] }, bullets: [{ text: line, factIds }] }],
    skills: [],
    education: [],
  }
}

describe("every claim maps to a Career Profile fact (AC 5.3)", () => {
  it("a faithful resume passes", () => {
    const content: ResumeContent = {
      kind: "resume",
      summary: [{ text: "Senior Frontend Engineer who builds from scratch to production and mentors developers.", factIds: ["F1", "F2", "F3"] }],
      experience: [
        {
          heading: { text: "Senior Frontend Engineer, Brightwave Ltd, 2021–2024", factIds: ["F2"] },
          bullets: [
            { text: "Built a React and TypeScript merchant dashboard from scratch to production.", factIds: ["F1"] },
            { text: "Cut the release cycle from 2 weeks to 3 days.", factIds: ["F4"] },
            { text: "Mentored 6 junior developers.", factIds: ["F3"] },
          ],
        },
      ],
      skills: [{ text: "React, TypeScript", factIds: ["F1"] }],
      education: [],
    }
    expect(validateJudged(content)).toEqual({ ok: true })
  })

  it("rephrasing and reordering is allowed (gherkin: maps to F1)", () => {
    expect(validateJudged(resume("Shipped a merchant dashboard from zero to production in React and TypeScript", ["F1"]))).toEqual({ ok: true })
  })

  it.each([
    "10 years of Kubernetes experience",
    "Increased revenue by 40%",
    "Senior Frontend Engineer, 2018–2024",
    "AWS Certified Solutions Architect",
    "Staff Engineer at Brightwave Ltd",
    "Led a team of 15 engineers",
    "10 years of kubernetes experience",
    "Expert in rust and golang",
  ])("an unsourced claim is blocked and returned: %s", (claim) => {
    const result = validateDocument(resume(claim, ["F1", "F2"]), FACTS)
    expect(result).toMatchObject({ ok: false, claim })
  })

  it("a line that cites a fact ID outside the approved profile is blocked", () => {
    expect(validateDocument(resume("Built a React and TypeScript merchant dashboard", ["F99"]), FACTS)).toMatchObject({ ok: false, reason: "unknown_fact" })
  })

  it("a claim-bearing line that cites no fact is blocked", () => {
    expect(validateDocument(resume("Mentored 6 junior developers", []), FACTS)).toMatchObject({ ok: false, reason: "no_fact" })
  })

  it("a heading with a changed title or date is blocked", () => {
    const content: ResumeContent = { ...resume("Mentored 6 junior developers", ["F3"]) }
    const changed: ResumeContent = {
      ...content,
      experience: [{ ...content.experience[0]!, heading: { text: "Staff Engineer, Brightwave Ltd, 2021–2024", factIds: ["F2"] } }],
    }
    expect(validateDocument(changed, FACTS)).toMatchObject({ ok: false, claim: "Staff Engineer, Brightwave Ltd, 2021–2024" })
  })

  it("one unsourced claim among 12 sourced ones blocks the cover letter (boundary)", () => {
    const sourced = Array.from({ length: 12 }, () => ({ text: "I mentored 6 junior developers.", factIds: ["F3"] }))
    const letter: CoverLetterContent = {
      kind: "cover_letter",
      greeting: "Dear Hiring Team at Acme Payments,",
      opening: null,
      paragraphs: [...sourced, { text: "I led a team of 15 engineers.", factIds: ["F3"] }],
      closingLine: null,
      closing: "Kind regards,",
    }
    expect(validateDocument(letter, FACTS)).toMatchObject({ ok: false, claim: "I led a team of 15 engineers." })
  })

  it("a cover letter greeting that names the employer is not a claim", () => {
    const letter: CoverLetterContent = {
      kind: "cover_letter",
      greeting: "Dear Hiring Team at Acme Payments,",
      opening: "I am applying for the Senior Frontend Engineer role at Acme Payments.",
      paragraphs: [{ text: "I mentored 6 junior developers.", factIds: ["F3"] }],
      closingLine: "I would welcome the chance to discuss how I can contribute to Acme Payments.",
      closing: "Kind regards,",
    }
    expect(validateJudged(letter, FACTS, { employer: "Acme Payments", roleTitle: "Senior Frontend Engineer" })).toEqual({ ok: true })
  })

  it("a model line naming the target employer is blocked", () => {
    const letter: CoverLetterContent = {
      kind: "cover_letter",
      greeting: "Dear Hiring Team at Acme Payments,",
      opening: null,
      paragraphs: [{ text: "I would bring my Kubernetes work to Acme Payments.", factIds: ["F1"] }],
      closingLine: null,
      closing: "Kind regards,",
    }
    expect(validateDocument(letter, FACTS, { employer: "Acme Payments", roleTitle: "Senior Frontend Engineer" })).toMatchObject({ ok: false })
  })

  it("no mentoring fact means a mentoring line is blocked (AC 5.4 sad path)", () => {
    const withoutMentoring = new Map([...FACTS].filter(([id]) => id !== "F3"))
    expect(validateDocument(resume("Mentored 6 junior developers", ["F1"]), withoutMentoring)).toMatchObject({ ok: false })
  })

  it("a draft-only fact never validates (only approved facts are passed in)", () => {
    expect(validateDocument(resume("Staff Engineer at Brightwave Ltd", ["F9"]), FACTS)).toMatchObject({ ok: false, reason: "unknown_fact" })
  })
})

describe("repair wave 3: no model-written line may name the target employer or role (SEC-403 r2, F-QA4-05, F-QA4-06)", () => {
  const PROBE_FACTS = new Map([
    ["F1", "Built a React and TypeScript merchant dashboard used by 40 merchants. Frontend Developer, Brightwave Ltd, 2021-2024"],
    ["F2", "Mentored two junior developers. Frontend Developer, Brightwave Ltd, 2021-2024"],
  ])
  const T = { employer: "Acme Payments", roleTitle: "Senior Frontend Engineer" }
  const TS = { employer: "Acme", roleTitle: "Staff Engineer" }
  const TK = { employer: "Docker", roleTitle: "AWS Certified Staff Engineer" }
  const TG = { employer: "Google", roleTitle: "Principal Engineer, PhD required" }
  const TB = { employer: "Brightwave Health", roleTitle: "Senior Frontend Engineer" }
  const letter = (text: string, factIds: string[]): CoverLetterContent => ({
    kind: "cover_letter",
    greeting: "Dear Hiring Team,",
    opening: null,
    paragraphs: [{ text, factIds }],
    closingLine: null,
    closing: "Kind regards,",
  })

  it.each([
    // Security recheck r2 (security-probes/r2/bypass*-probe.log): the 11 bypasses.
    ["In my Senior Frontend Engineer role at Brightwave Ltd I built a React and TypeScript merchant dashboard used by 40 merchants", ["F1"], T],
    ["I held the Senior Frontend Engineer position at Brightwave Ltd from 2021-2024", ["F1"], T],
    ["I loved my job with Acme Payments", [], T],
    ["Since joining Acme Payments I have built React dashboards", ["F1"], T],
    ["As a Staff Engineer post holder I mentored two junior developers", ["F2"], TS],
    ["I am an AWS Certified Staff Engineer role model for two junior developers", ["F2"], TK],
    ["I led the team at Docker", [], TK],
    ["In my previous role at Acme Payments I built a React and TypeScript merchant dashboard used by 40 merchants", ["F1"], T],
    ["in my Staff Engineer job at Brightwave Ltd I built a React and TypeScript merchant dashboard used by 40 merchants", ["F1"], TS],
    ["I led the team at Acme for years", [], TS],
    ["I was a Staff Engineer role model and led the team at Acme", [], TS],
    ["I am applying for the Principal Engineer, PhD required role at Google", [], TG],
    ["as a Principal Engineer, PhD required position holder I built a React and TypeScript merchant dashboard used by 40 merchants", ["F1"], TG],
    // Wave 2 lines, still blocked.
    ["As a Senior Frontend Engineer at Brightwave Ltd I built a React and TypeScript merchant dashboard used by 40 merchants", ["F1"], T],
    ["I have worked as a Senior Engineer for Acme Payments", [], T],
    ["I have worked at Acme Payments before", ["F1"], T],
    // F-QA4-05.
    ["I am applying for the Senior Frontend Engineer role at Acme Payments, where I worked before.", [], T],
    // The model may not address the application either: the backend writes that sentence.
    ["I am applying for the Senior Frontend Engineer role at Acme Payments.", [], T],
    ["I would welcome the chance to join Acme Payments as a Senior Frontend Engineer.", [], T],
    // F-QA4-06 closings written by the model.
    ["I would welcome the chance to bring this experience to Brightwave Health.", [], TB],
    ["I look forward to speaking with the Brightwave Health team.", [], TB],
    ["I'm excited about Brightwave Health's mission.", [], TB],
    ["I would be glad to contribute to Brightwave Health.", [], TB],
    // Case, spacing and invisible characters don't hide the name.
    ["I am applying for the staff engineer role at acme", [], TS],
    ["I am applying for the STAFF ENGINEER role at ACME", [], TS],
    ["I am applying for the Staff\nEngineer role at Acme", [], TS],
    ["I am applying for the Staff\u200bEngineer role at Acme", [], TS],
  ] as const)("blocked: %s", (text, factIds, target) => {
    expect(validateDocument(letter(text, [...factIds]), PROBE_FACTS, target)).toMatchObject({ ok: false, reason: "names_target" })
  })

  it("part of the role title not backed by the cited facts is an unsupported claim", () => {
    expect(validateDocument(letter("I am a senior engineer", ["F1"]), PROBE_FACTS, T)).toMatchObject({ ok: false, reason: "unsupported_claim", unsupported: ["senior"] })
  })

  it("a role title the cited facts back is still blocked: the model never names the role", () => {
    const facts = new Map([["F1", "Senior Frontend Engineer at Brightwave Ltd, 2021-2024"]])
    expect(validateDocument(letter("As a Senior Frontend Engineer I built dashboards", ["F1"]), facts, T)).toMatchObject({ ok: false, reason: "names_target" })
  })

  it("a past employer that shares a word with the target is checked as a claim, not as the target", () => {
    expect(validateJudged(letter("I built a React and TypeScript merchant dashboard used by 40 merchants at Brightwave Ltd", ["F1"]), PROBE_FACTS, TB)).toEqual({ ok: true })
  })

  it.each(["Brightwave Health", "brightwave health", "BRIGHTWAVE HEALTH"])("the employer is matched as a whole phrase: %s", (name) => {
    expect(validateDocument(letter(`I admire ${name}`, []), PROBE_FACTS, TB)).toMatchObject({ ok: false, reason: "names_target" })
  })

  it("body paragraphs from the facts pass, and the backend's opening and closing are not validated", () => {
    const full: CoverLetterContent = {
      kind: "cover_letter",
      greeting: "Dear Hiring Team at Acme Payments,",
      opening: "I am applying for the Senior Frontend Engineer role at Acme Payments.",
      paragraphs: [
        { text: "I built a React and TypeScript merchant dashboard used by 40 merchants.", factIds: ["F1"] },
        { text: "I mentored two junior developers.", factIds: ["F2"] },
      ],
      closingLine: "I would welcome the chance to discuss how I can contribute to Acme Payments.",
      closing: "Kind regards,",
    }
    expect(validateJudged(full, PROBE_FACTS, T)).toEqual({ ok: true })
  })
})

describe("repair wave 2: contact details never appear in a document line (SEC-401)", () => {
  const CONTACT = { name: "Ada Okafor", lines: ["Lagos, Nigeria", "12 Admiralty Way, Lekki", "ada@example.com", "+234 800 000 0000"] }
  it.each([
    "Reach me at ada@example.com about the React dashboard.",
    "Call +234 800 000 0000 to discuss the merchant dashboard.",
    "Email someone.else@mail.co for references on the dashboard.",
    "Phone (415) 555-0134 for the merchant dashboard.",
  ])("a line with an email or phone is blocked: %s", (text) => {
    expect(validateDocument(resume(text, ["F1"]), FACTS, null, CONTACT)).toMatchObject({ ok: false, reason: "contact_detail" })
  })

  it("a line with the Candidate's own street address is blocked", () => {
    const facts = new Map([...FACTS, ["F1", "Built a React dashboard from 12 Admiralty Way, Lekki"]])
    expect(validateDocument(resume("Built a React dashboard from 12 Admiralty Way, Lekki.", ["F1"]), facts, null, CONTACT)).toMatchObject({ ok: false, reason: "contact_detail" })
  })

  it("a city or country alone is not a contact detail", () => {
    const facts = new Map([...FACTS, ["F1", "Built a React dashboard in Lagos, Nigeria"]])
    expect(validateJudged(resume("Built a React dashboard in Lagos, Nigeria.", ["F1"]), facts)).toEqual({ ok: true })
  })

  it.each(["linkedin.com/in/ada-okafor", "github.com/ada", "ada.dev", "https://ada.dev/cv"])("a contact line with a dotted host or path is identifying: %s (SEC-401 residual)", (link) => {
    const contact = { name: "Ada Okafor", lines: ["Lagos, Nigeria", link] }
    const facts = new Map([...FACTS, ["F1", `Built a React dashboard, portfolio at ${link}`]])
    expect(validateDocument(resume(`Built a React dashboard, portfolio at ${link}`, ["F1"]), facts, null, contact)).toMatchObject({ ok: false, reason: "contact_detail" })
  })

  it("dates and ranges are not phone numbers", () => {
    expect(validateJudged(resume("Senior Frontend Engineer at Brightwave Ltd, 2021–2024", ["F2"]))).toEqual({ ok: true })
  })
})

describe("repair wave 2: more number forms and small capitals (SEC-405, SEC-406)", () => {
  it.each([
    "Mentored a hundred junior developers",
    "Mentored dozens of junior developers",
    "Mentored a dozen junior developers",
    "Mentored ٦ junior developers and ٤٠٠ more",
    "Mentored ६ junior developers and a score of others",
  ])("blocked: %s", (text) => {
    expect(validateDocument(resume(text, ["F3"]), FACTS)).toMatchObject({ ok: false })
  })

  it("Arabic-Indic digits matching the fact pass", () => {
    expect(validateJudged(resume("Mentored ٦ junior developers", ["F3"]))).toEqual({ ok: true })
  })

  it.each(["Built the dashboard at ɢᴏᴏɢʟᴇ", "Built the dashboard at sᴛʀɪᴘᴇ"])("small capitals are a proper noun: %s", (text) => {
    expect(validateDocument(resume(text, ["F1"]), FACTS)).toMatchObject({ ok: false })
  })
})

// F-QA4-07 (qa-report.r4.md, logs/qa/r4-false-blocks.json): a capitalised first
// word that carries no claim must not block a natural body line. Facts and lines
// are QA's realistic CV (qa-e2e/fixtures.mts realCvReply, run4.mts R4-N), with the
// section heading appended as documents.service factsOf does.
describe("repair: natural sentence openers in cover-letter body lines (F-QA4-07)", () => {
  const PAYSTACK = "Staff Software Engineer, Paystack-like Payments Ltd, Jun 2021 – Present"
  const QA_FACTS = new Map([
    ["M14", `Led the migration of 14 services from Heroku to AWS ECS, cutting hosting costs by 31%. ${PAYSTACK}`],
    ["WH", `Designed an idempotent webhook pipeline handling about 2.5 million events per day. ${PAYSTACK}`],
    ["MEN", `Mentored 6 engineers, 3 of whom were promoted to senior within 18 months. ${PAYSTACK}`],
    ["P95", "Reduced p95 latency from 820 ms to 190 ms with Redis caching and query tuning. Senior Backend Engineer, Kobo Logistics, Mar 2018 – May 2021"],
    ["SHIP", "Shipped React and Node.js features for US fintech clients. Software Engineer, Andela, 2015–2018"],
    ["SK", "TypeScript, Go, Node.js, React, PostgreSQL, Redis, Kafka. Skills"],
    ["BENG", "BEng Electrical Engineering, Second Class Upper. BEng Electrical Engineering, Obafemi Awolowo University, 2010–2015"],
    ["AWS", "AWS Certified Solutions Architect – Associate, 2022. Certifications"],
  ])
  const TB = { employer: "Brightwave Health", roleTitle: "Senior Frontend Engineer" }
  const letter = (text: string, factIds: string[]): CoverLetterContent => ({
    kind: "cover_letter",
    greeting: "Dear Hiring Team at Brightwave Health,",
    opening: "I am applying for the Senior Frontend Engineer role at Brightwave Health.",
    paragraphs: [{ text, factIds }],
    closingLine: "I would welcome the chance to discuss how I can contribute to Brightwave Health.",
    closing: "Kind regards,",
  })

  it.each([
    // QA's 8 realistic lines (3 were blocked on d95ee20).
    ["My strongest work has been in payments infrastructure, where I led the migration of 14 services from Heroku to AWS ECS.", "M14"],
    ["I care about reliability: I designed an idempotent webhook pipeline handling about 2.5 million events per day.", "WH"],
    ["Mentoring matters to me; I mentored 6 engineers and 3 were promoted to senior within 18 months.", "MEN"],
    ["I enjoy hard performance problems, and I cut p95 latency from 820 ms to 190 ms with Redis caching and query tuning.", "P95"],
    ["Earlier, I shipped React and Node.js features for US fintech clients.", "SHIP"],
    ["I work across TypeScript, Go, Node.js, React, PostgreSQL, Redis and Kafka.", "SK"],
    ["I hold a BEng in Electrical Engineering, Second Class Upper.", "BENG"],
    ["I am an AWS Certified Solutions Architect – Associate (2022).", "AWS"],
    // QA's wider probe openers.
    ["Recently, I led the migration of 14 services from Heroku to AWS ECS.", "M14"],
    ["Most recently, I led the migration of 14 services from Heroku to AWS ECS.", "M14"],
    ["Notably, I reduced p95 latency from 820 ms to 190 ms.", "P95"],
    ["Ultimately, 3 of the 6 engineers I mentored were promoted to senior.", "MEN"],
    ["My proudest result: I cut p95 latency from 820 ms to 190 ms.", "P95"],
    ["Previously, I shipped React and Node.js features for US fintech clients.", "SHIP"],
    ["Our webhook pipeline handled about 2.5 million events per day.", "WH"],
    ["This pipeline handled about 2.5 million events per day.", "WH"],
    ["During that time I mentored 6 engineers.", "MEN"],
  ])("passes: %s", (text, factId) => {
    expect(validateJudged(letter(text, [factId]), QA_FACTS, TB)).toEqual({ ok: true })
  })

  it.each([
    // A capitalised word after the first word is still a claim.
    ["My Google team led the migration of 14 services from Heroku to AWS ECS.", "M14", ["google"]],
    ["Recently, Google hired me after I led the migration of 14 services.", "M14", ["google"]],
    ["Earlier, as Head of Engineering, I shipped React and Node.js features.", "SHIP", ["head", "engineering"]],
    ["Mentoring at Stripe, I mentored 6 engineers.", "MEN", ["stripe"]],
    ["Notably, I was promoted to Director within 18 months.", "MEN", ["director"]],
    ["Our CTO role: I led the migration of 14 services.", "M14", ["cto"]],
    // Titles and employers are never openers, and lower-case title words stay claims.
    ["Director of the migration of 14 services from Heroku to AWS ECS.", "M14", ["director"]],
    ["Stripe engineers and I led the migration of 14 services.", "M14", ["stripe"]],
    ["Principal work: I led the migration of 14 services.", "M14", ["principal"]],
    ["Ultimately, as a principal engineer I led the migration of 14 services.", "M14", ["principal"]],
    // A gerund only restates its own fact's verb: "Kubernetesing" or "Managing" are claims.
    ["Managing 6 engineers, I mentored them.", "MEN", ["managing"]],
    ["Architecting the webhook pipeline, I designed it.", "WH", ["architecting"]],
  ])("blocked: %s", (text, factId, unsupported) => {
    expect(validateDocument(letter(text, [factId]), QA_FACTS, TB)).toMatchObject({ ok: false, reason: "unsupported_claim", unsupported })
  })
})

// SEC-404 + CR4-01 (slice 5 prework, Candidate default): every noun in a line
// must appear in its cited facts apart from everyday English words, and the
// line's numbers must all come, in order, from one cited fact.
describe("SEC-404: lower-case nouns must come from the cited facts", () => {
  it.each([
    ["Built the merchant dashboard in elixir.", ["F1"], ["elixir"]],
    ["Built a dashboard with webassembly and grpc.", ["F1"], ["webassembly", "grpc"]],
    ["Built a merchant dashboard at google.", ["F1"], ["google"]],
    ["Built dashboards for stripe and meta.", ["F1"], ["stripe", "meta"]],
    ["Mentored 6 junior developers in blockchain.", ["F3"], ["blockchain"]],
    ["Mentored 6 junior developers in kotlinx and ktor.", ["F3"], ["kotlinx", "ktor"]],
  ])("blocked: %s", (line, ids, unsupported) => {
    expect(validateDocument(resume(line, ids), FACTS)).toMatchObject({ ok: false, reason: "unsupported_claim", unsupported })
  })

  it.each([
    ["Built a merchant dashboard from scratch.", ["F1"]],
    ["Shipped the merchant dashboards to production.", ["F1"]],
    ["Mentoring junior developers is part of how I work.", ["F3"]],
    ["I really enjoy building products from scratch with my team.", ["F1"]],
  ])("passes: %s", (line, ids) => {
    expect(validateJudged(resume(line, ids))).toEqual({ ok: true })
  })
})

describe("CR4-01: numbers come in order from one cited fact", () => {
  it.each([
    ["Cut release cycle from 3 weeks to 2 days", ["F4"]],
    ["Cut release cycle from 6 weeks to 3 days", ["F3", "F4"]],
    ["Mentored 3 junior developers in 2 weeks", ["F3", "F4"]],
  ])("blocked: %s", (line, ids) => {
    expect(validateDocument(resume(line, ids), FACTS)).toMatchObject({ ok: false, reason: "unsupported_claim" })
  })

  it.each([
    ["Cut the release cycle from 2 weeks to 3 days.", ["F4"]],
    ["Cut the release cycle to 3 days.", ["F4"]],
    ["Cut the release cycle to 3 days and mentored junior developers.", ["F3", "F4"]],
    ["Mentored 6 junior developers.", ["F3", "F4"]],
    // Each clause takes its numbers from one fact (deviation from the whole-line reading, see backend report).
    ["Mentored 6 junior developers and cut release cycle from 2 weeks to 3 days", ["F3", "F4"]],
    ["I cut our release cycle from 2 weeks to 3 days and mentored 6 junior developers.", ["F3", "F4"]],
    ["As a Senior Frontend Engineer at Brightwave Ltd from 2021 to 2024, I cut our release cycle from 2 weeks to 3 days.", ["F2", "F4"]],
  ])("passes: %s", (line, ids) => {
    expect(validateJudged(resume(line, ids))).toEqual({ ok: true })
  })
})

describe("a tailored line that goes too far falls back instead of blocking", () => {
  it("a resume bullet with an unsupported claim takes its first fact's wording, and the resume passes", () => {
    const { resume: fixed, replaced } = fallBackToFactWording(resume("Cut release cycle from 2 weeks to 3 days using Kubernetes.", ["F4"]), FACTS, FACTS, null)
    expect(replaced).toBe(1)
    expect(fixed.experience[0]?.bullets).toEqual([{ text: "Cut release cycle from 2 weeks to 3 days", factIds: ["F4"] }])
    expect(validateDocument(fixed, FACTS)).toEqual({ ok: true })
  })

  it("keeps a bullet's passing sentences before using the fact's wording", () => {
    const { resume: fixed } = fallBackToFactWording(resume("Mentored 6 junior developers. Expert in Kubernetes.", ["F3"]), FACTS, FACTS, null)
    expect(fixed.experience[0]?.bullets[0]?.text).toBe("Mentored 6 junior developers.")
  })

  it("doesn't split a bullet after an abbreviation", () => {
    const { resume: fixed } = fallBackToFactWording(resume("Mentored 6 junior developers, e.g. Ada and Bo, in Kubernetes.", ["F3"]), FACTS, FACTS, null)
    expect(fixed.experience[0]?.bullets[0]?.text).toBe("Mentored 6 junior developers")
  })

  it("drops a failing summary line rather than putting a role's fact there", () => {
    const withSummary: ResumeContent = { ...resume("Mentored 6 junior developers.", ["F3"]), summary: [{ text: "World-class Kubernetes expert.", factIds: ["F1"] }] }
    expect(fallBackToFactWording(withSummary, FACTS, FACTS, null).resume.summary).toEqual([])
  })

  it("leaves passing lines, unknown facts and headings untouched", () => {
    const passing = resume("Mentored 6 junior developers.", ["F3"])
    expect(fallBackToFactWording(passing, FACTS, FACTS, null)).toEqual({ resume: passing, replaced: 0 })
    const unknown = resume("Led 40 engineers.", ["F99"])
    expect(fallBackToFactWording(unknown, FACTS, FACTS, null).resume.experience[0]?.bullets[0]?.text).toBe("Led 40 engineers.")
    expect(validateDocument(fallBackToFactWording(unknown, FACTS, FACTS, null).resume, FACTS).ok).toBe(false)
  })

  it("drops a fallback that would repeat a bullet already in the role", () => {
    const twice: ResumeContent = {
      ...resume("Mentored 6 junior developers", ["F3"]),
      experience: [{ heading: { text: "Senior Frontend Engineer, Brightwave Ltd, 2021–2024", factIds: ["F2"] }, bullets: [{ text: "Mentored 6 junior developers", factIds: ["F3"] }, { text: "Mentored 6 junior developers in Rust.", factIds: ["F3"] }] }],
    }
    expect(fallBackToFactWording(twice, FACTS, FACTS, null).resume.experience[0]?.bullets).toEqual([{ text: "Mentored 6 junior developers", factIds: ["F3"] }])
  })

  it("a cover letter drops only the unsupported sentence, and a paragraph with nothing supported", () => {
    const letter: CoverLetterContent = {
      kind: "cover_letter",
      greeting: "Dear Hiring Team at Acme,",
      opening: null,
      closingLine: null,
      closing: "Kind regards,",
      paragraphs: [
        { text: "I mentored 6 junior developers. Leadership is a skill I rely on.", factIds: ["F3"] },
        { text: "I am a world-class Kubernetes expert.", factIds: ["F1"] },
        { text: "I cut our release cycle from 2 weeks to 3 days.", factIds: ["F4"] },
      ],
    }
    const target = { employer: "Acme", roleTitle: "Engineer" }
    const supported = new Set([meaningKey("I cut our release cycle from 2 weeks to 3 days.", ["F4"])])
    const { letter: fixed, dropped } = dropUnsupportedSentences(letter, FACTS, target, null, supported)
    expect(dropped).toBe(2)
    expect(fixed.paragraphs.map((p) => p.text)).toEqual(["I mentored 6 junior developers.", "I cut our release cycle from 2 weeks to 3 days."])
    expect(validateJudged(fixed, FACTS, target)).toEqual({ ok: true })
  })

  it("never trims a letter line that names the target employer", () => {
    const letter: CoverLetterContent = {
      kind: "cover_letter", greeting: "Dear Hiring Team at Acme,", opening: null, closingLine: null, closing: "Kind regards,",
      paragraphs: [{ text: "I mentored 6 junior developers. I love Acme.", factIds: ["F3"] }],
    }
    const target = { employer: "Acme", roleTitle: "Engineer" }
    expect(dropUnsupportedSentences(letter, FACTS, target, null).letter).toEqual(letter)
    expect(validateDocument(letter, FACTS, target).ok).toBe(false)
  })
})

describe("smarter word matching and the meaning check", () => {
  const WORDS = new Map([
    ...FACTS,
    ["F7", "Applied functional patterns to improve code predictability and re-use"],
    ["F8", "Identified and resolved stability issues"],
  ])
  it("accepts derived forms and plain verbs of the facts' own words", () => {
    expect(validateJudged(resume("Applied functional patterns to make code predictable and reusable.", ["F7"]), WORDS)).toEqual({ ok: true })
    expect(validateJudged(resume("Fixed stability issues.", ["F8"]), WORDS)).toEqual({ ok: true })
  })

  it("sends only lines whose numbers and names already come from their facts", () => {
    const line = (text: string, factIds: string[]) => ({ text, factIds })
    expect(needsMeaningCheck(line("Mentored 6 junior developers through weekly pairing.", ["F3"]), FACTS, null, null)).toBe(true)
    expect(needsMeaningCheck(line("Mentored 9 junior developers.", ["F3"]), FACTS, null, null)).toBe(false)
    expect(needsMeaningCheck(line("Mentored 6 junior developers in Kubernetes.", ["F3"]), FACTS, null, null)).toBe(false)
    expect(needsMeaningCheck(line("Mentored 6 junior developers.", ["F3"]), FACTS, null, null)).toBe(false)
    expect(needsMeaningCheck(line("Mentored 6 developers weekly.", []), FACTS, null, null)).toBe(false)
  })

  it("a meaning-checked line still needs its numbers from one fact", () => {
    const checked = new Set([meaningKey("Mentored 6 junior developers weekly for 3 days.", ["F3"])])
    expect(validateDocument(resume("Mentored 6 junior developers weekly for 3 days.", ["F3"]), FACTS, null, null, checked).ok).toBe(false)
  })

  // Review fix (post-R26): a verdict is keyed by the line's text and the facts it cites (R15). A set holding
  // the bare text released any line with that text, whatever it cited, so the fallback is gone.
  it("a verdict for the text alone releases nothing", () => {
    const text = "Applied functional patterns to make code predictable and reusable."
    expect(validateDocument(resume(text, ["F7"]), WORDS, null, null, new Set([text])).ok).toBe(false)
    expect(validateDocument(resume(text, ["F7"]), WORDS, null, null, new Set([meaningKey(text, ["F7"])])).ok).toBe(true)
  })
})

// EPIC-0012 rule 2 (design 1a to 1f): the posting lends lower-case wording only, and only when the
// meaning check says the same work is described. Every other borrowed word fails in code first. The
// service passes an empty `meaningChecked` set both when the judge answers false and when the call fails.
describe("EPIC-0012 rule 2: posting terms, hard fails and the scope-verb fix", () => {
  const FACTS = new Map([
    ["WIND", "Built wind farm financial models for offshore projects, forecasting revenue and cost"],
    ["PAY", "Supported the payments migration"],
  ])
  const POSTING =
    "Renewable energy developer. Build wind farm models and report on renewable energy projects. Carbon accounting and sustainability reporting matter. We seek a sustainability consultant."
  const GUARD = postingGuard(POSTING, "Sustainability Consultant", ["carbon accounting"])
  const BRIDGE = "Built wind farm financial models for renewable energy projects, forecasting revenue and cost."

  const summary = (text: string, factId = "WIND"): ResumeContent => ({ kind: "resume", summary: [{ text, factIds: [factId] }], experience: [], skills: [], education: [] })
  const bullet = (text: string, factId = "WIND"): ResumeContent => ({
    kind: "resume",
    summary: [],
    experience: [{ heading: { text: "Built wind farm financial models", factIds: [factId] }, bullets: [{ text, factIds: [factId] }] }],
    skills: [],
    education: [],
  })
  const line = (text: string, factId = "WIND"): DocumentLine => ({ text, factIds: [factId] })
  const checked = (text: string): Set<string> => new Set([meaningKey(text, ["WIND"])])

  it("derives at most two posting terms from the line and the posting", () => {
    expect(postingTerms(line(BRIDGE), FACTS, GUARD)).toEqual(["renewable", "energy"])
    expect(postingTerms(line(BRIDGE), FACTS, postingGuard(POSTING, "Sustainability Consultant", [], false))).toEqual([])
  })

  it("reads the posting title for its role noun, skipping brackets, stop words and a level", () => {
    expect(postingGuard(POSTING, "Sustainability Consultant (m/f/d)").roleNouns).toContain("consultant")
    expect(postingGuard(POSTING, "Head of Finance").roleNouns).toContain("finance")
    expect(postingGuard(POSTING, "Software Engineer II").roleNouns).toContain("engineer")
    expect(postingGuard(POSTING, "Software Engineer II").roleNouns).not.toContain("ii")
  })

  it("a supported bridge passes only after supported: true, and falls back when refused or the call fails", () => {
    expect(validateDocument(summary(BRIDGE), FACTS, null, null, new Set(), GUARD)).toMatchObject({
      ok: false,
      reason: "unsupported_claim",
      unsupported: ["renewable", "energy"],
    })
    expect(needsMeaningCheck(line(BRIDGE), FACTS, null, null, "summary", GUARD)).toBe(true)
    // supported: true, so the meaning check reported the line supported.
    expect(validateDocument(summary(BRIDGE), FACTS, null, null, checked(BRIDGE), GUARD)).toEqual({ ok: true })
    expect(fallBackToFactWording(bullet(BRIDGE), FACTS, FACTS, null, checked(BRIDGE), GUARD)).toMatchObject({ replaced: 0 })
    // false and a failed call both arrive as an empty set, and the bullet takes its fact's wording.
    const refused = fallBackToFactWording(bullet(BRIDGE), FACTS, FACTS, null, new Set(), GUARD)
    expect(refused.replaced).toBe(1)
    expect(refused.resume.experience[0]?.bullets[0]).toEqual({ text: FACTS.get("WIND"), factIds: ["WIND"] })
  })

  it.each([
    ["a number", "Built wind farm financial models for 40 renewable energy projects.", "40"],
    ["a capitalised title", "Built wind farm financial models for Renewable Energy programmes.", "renewable"],
    ["an employer", "Built wind farm financial models for Orsted renewable energy projects.", "orsted"],
    ["a tool", "Built wind farm financial models in Rust for renewable energy projects.", "rust"],
    ["a qualification", "Certified in wind farm financial models for renewable energy projects.", "certified"],
  ])("fails in code before any meaning check: %s", (_name, text, unsupported) => {
    const result = validateDocument(summary(text), FACTS, null, null, checked(text), GUARD)
    expect(result).toMatchObject({ ok: false, reason: "unsupported_claim" })
    if (!result.ok) expect(result.unsupported).toContain(unsupported)
    expect(needsMeaningCheck(line(text), FACTS, null, null, "summary", GUARD)).toBe(false)
  })

  it("Led for Supported is support-role inflation: a hard fail that falls back", () => {
    const text = "Led the payments migration"
    expect(validateDocument(summary(text, "PAY"), FACTS, null, null, new Set(), GUARD)).toMatchObject({ ok: false, reason: "unsupported_claim", unsupported: ["led"] })
    expect(needsMeaningCheck(line(text, "PAY"), FACTS, null, null, "summary", GUARD)).toBe(false)
    expect(validateDocument(summary(text, "PAY"), FACTS, null, null, checked(text), GUARD)).toMatchObject({ ok: false, reason: "unsupported_claim" })
    expect(fallBackToFactWording(bullet(text, "PAY"), FACTS, FACTS, null, new Set(), GUARD).resume.experience[0]?.bullets[0]?.text).toBe(FACTS.get("PAY"))
  })

  it("an ATS gap keyword is a hard fail, even when the meaning check would accept the line", () => {
    const text = "Built wind farm models with carbon accounting, forecasting revenue and cost."
    expect(validateDocument(summary(text), FACTS, null, null, checked(text), GUARD)).toMatchObject({ ok: false, reason: "unsupported_claim", unsupported: ["carbon accounting"] })
    expect(needsMeaningCheck(line(text), FACTS, null, null, "summary", GUARD)).toBe(false)
  })

  it("a role noun the facts do not state is a hard fail: sustainability consultant for an energy analyst", () => {
    const text = "Built wind farm financial models as a sustainability consultant, forecasting revenue and cost."
    expect(validateDocument(summary(text), FACTS, null, null, checked(text), GUARD)).toMatchObject({ ok: false, reason: "unsupported_claim", unsupported: ["consultant"] })
  })

  it("a posting term in a skills line is never lent", () => {
    const content: ResumeContent = { kind: "resume", summary: [], experience: [], skills: [{ text: "wind farm models, renewable energy", factIds: ["WIND"] }], education: [] }
    expect(validateDocument(content, FACTS, null, null, checked("wind farm models, renewable energy"), GUARD)).toMatchObject({
      ok: false,
      reason: "unsupported_claim",
      unsupported: ["renewable", "energy"],
    })
  })

  it("a posting term in an experience heading or an education line is never lent", () => {
    const heading: ResumeContent = {
      kind: "resume",
      summary: [],
      experience: [{ heading: { text: "Renewable energy models", factIds: ["WIND"] }, bullets: [] }],
      skills: [],
      education: [],
    }
    expect(validateDocument(heading, FACTS, null, null, checked("Renewable energy models"), GUARD)).toMatchObject({ ok: false, reason: "unsupported_claim" })
    const education: ResumeContent = { kind: "resume", summary: [], experience: [], skills: [], education: [{ text: "wind farm models, renewable energy", factIds: ["WIND"] }] }
    expect(validateDocument(education, FACTS, null, null, checked("wind farm models, renewable energy"), GUARD)).toMatchObject({ ok: false, reason: "unsupported_claim" })
  })

  it("three posting terms in one line exceed the cap and fall back even when supported is true", () => {
    const text = "Built wind farm models for renewable energy projects with carbon accounting and sustainability reporting."
    const guard = postingGuard("renewable energy carbon accounting sustainability reporting", "Sustainability Consultant", [])
    const result = validateDocument(summary(text), FACTS, null, null, checked(text), guard)
    expect(result).toMatchObject({ ok: false, reason: "unsupported_claim" })
    if (!result.ok) expect(result.unsupported.length).toBeGreaterThan(2)
    expect(needsMeaningCheck(line(text), FACTS, null, null, "summary", guard)).toBe(false)
  })
})

// EPIC-0012 rule 4 (design 2c to 2g, Revision 1 R3/R4): one sentence of the cover letter may quote the
// employer's own verified direction, word for word, in a "you/your" sentence with no first person. The
// span is a run of whole quote tokens, and every word left around it must be a frame word; then the span
// leaves the claim and number checks. The resume and a second direction sentence never get the allowance.
describe("EPIC-0012 rule 4: one quoted direction sentence in the cover letter", () => {
  const FACTS = new Map([["WIND", "Built wind farm financial models for offshore projects, forecasting revenue and cost"]])
  const POSTING = "Our aim is to halve operational emissions by 2030. We will cut water use by 40% across the group."
  const QUOTES = ["Our aim is to halve operational emissions by 2030", "We will cut water use by 40% across the group"]
  const GUARD = postingGuard(POSTING, "Sustainability Consultant", [], true, QUOTES)
  const TARGET = { employer: "Acme Payments", roleTitle: "Sustainability Consultant" }
  const FACT_LINE = "I built wind farm financial models for offshore projects, forecasting revenue and cost."
  const letter = (paragraphs: readonly string[]): CoverLetterContent => ({
    kind: "cover_letter",
    greeting: "Dear Hiring Team,",
    opening: null,
    paragraphs: paragraphs.map((text) => ({ text, factIds: ["WIND"] })),
    closingLine: null,
    closing: "Kind regards,",
  })
  /** A meaning-check verdict belongs to a line's text and its cited facts (R15); every paragraph cites WIND. */
  const judged = (text: string): Set<string> => new Set([meaningKey(text, ["WIND"])])

  it("a copied span passes when judged, with the next sentence tied to a fact", () => {
    const text = `Your plan to “halve operational emissions by 2030” is clear. ${FACT_LINE}`
    expect(validateDocument(letter([text]), FACTS, TARGET, null, judged(text), GUARD)).toEqual({ ok: true })
  })

  it("a word outside the span that is not a frame word keeps the quote in, so it fails in code", () => {
    const text = `Your aim to “halve operational emissions by 2030” sets a clear test for any model. ${FACT_LINE}`
    expect(needsMeaningCheck({ text, factIds: ["WIND"] }, FACTS, TARGET, null, "letter_paragraph", GUARD)).toBe(false)
    expect(validateDocument(letter([text]), FACTS, TARGET, null, new Set(), GUARD)).toMatchObject({ ok: false })
    expect(validateDocument(letter([text]), FACTS, TARGET, null, judged(text), GUARD)).toMatchObject({ ok: false })
  })

  it("no stored quote means no allowance: the same line fails on its year", () => {
    const text = `Your plan to “halve operational emissions by 2030” is clear. ${FACT_LINE}`
    const bare = postingGuard(POSTING, "Sustainability Consultant", [], true, [])
    expect(validateDocument(letter([text]), FACTS, TARGET, null, new Set(), bare)).toMatchObject({ ok: false, reason: "unsupported_claim" })
  })

  it.each([
    // An invented year or programme is in no stored quote and in no fact.
    ["an invented year", `Your plan to “35 by 35” is clear. ${FACT_LINE}`],
    ["an unquoted year", `Your plan for 2030 is clear. ${FACT_LINE}`],
    ["an altered quote", `Your plan to “halve operational emissions by 2035” is clear. ${FACT_LINE}`],
  ])("%s stays in the line and fails", (_name, text) => {
    const result = validateDocument(letter([text]), FACTS, TARGET, null, new Set(), GUARD)
    expect(result).toMatchObject({ ok: false, reason: "unsupported_claim" })
  })

  it("an unquoted year the facts do not state is reported as a number", () => {
    const result = validateDocument(letter([`Your plan for 2030 is clear. ${FACT_LINE}`]), FACTS, TARGET, null, new Set(), GUARD)
    expect(result).toMatchObject({ ok: false, reason: "unsupported_claim", unsupported: ["2030"] })
  })

  it("a direction sentence that claims first person delivery is not stripped", () => {
    const text = `Your aim to “halve operational emissions by 2030” is one I helped deliver. ${FACT_LINE}`
    expect(validateDocument(letter([text]), FACTS, TARGET, null, judged(text), GUARD)).toMatchObject({ ok: false, reason: "unsupported_claim" })
  })

  it("a second direction sentence is not stripped and drops, leaving the first in place", () => {
    const first = `Your plan to “halve operational emissions by 2030” is clear. ${FACT_LINE}`
    const second = "Your next target to “cut water use by 40%” is clear."
    const result = dropUnsupportedSentences(letter([first, second]), FACTS, TARGET, null, judged(first), GUARD)
    expect(result.dropped).toBe(1)
    expect(result.letter.paragraphs.map((paragraph) => paragraph.text)).toEqual([first])
    expect(validateDocument(letter([first, second]), FACTS, TARGET, null, new Set(), GUARD)).toMatchObject({ ok: false })
    expect(validateDocument(result.letter, FACTS, TARGET, null, judged(first), GUARD)).toEqual({ ok: true })
  })

  it("two direction sentences in one paragraph leave one: the second drops", () => {
    const first = "Your plan to “halve operational emissions by 2030” is clear."
    const second = "Your next target to “cut water use by 40%” is clear."
    const result = dropUnsupportedSentences(letter([`${first} ${second} ${FACT_LINE}`]), FACTS, TARGET, null, new Set(), GUARD)
    expect(result.dropped).toBe(1)
    // Revision 2, 2.1: without a judge the direction sentences drop, leaving the fact sentence.
    expect(result.letter.paragraphs[0]?.text.replace(/\s+/g, " ")).toBe(FACT_LINE)
  })

  it("a quoted direction never passes in the resume", () => {
    const content: ResumeContent = {
      kind: "resume",
      summary: [{ text: "Your plan to “halve operational emissions by 2030” is clear.", factIds: ["WIND"] }],
      experience: [],
      skills: [],
      education: [],
    }
    expect(validateDocument(content, FACTS, null, null, new Set(), GUARD)).toMatchObject({ ok: false, reason: "unsupported_claim" })
  })

  it("a quote that names the employer blocks the letter before any span is removed", () => {
    const naming = ["Acme Payments aims to reach net zero by 2030"]
    const guard = postingGuard(POSTING, "Sustainability Consultant", [], true, naming)
    const text = `Your aim to “Acme Payments aims to reach net zero by 2030” is clear. ${FACT_LINE}`
    expect(validateDocument(letter([text]), FACTS, TARGET, null, new Set(), guard)).toMatchObject({ ok: false, reason: "names_target" })
  })
})

// EPIC-0012 Revision 2, 2.1 and R8: only a mechanical line passes without the judge; support-role
// inflation is a hard fail; the judge memo is keyed by text plus fact ids.
describe("EPIC-0012 Revision 2: mechanical lines, support inflation and the judge memo", () => {
  const FACTS = new Map([
    ["PAY", "Supported the payments migration"],
    ["WIND", "Built wind farm financial models for offshore projects, forecasting revenue and cost"],
    ["LIST", "TypeScript, Go, Node.js, React"],
    ["A", "Mentored 6 junior developers"],
    ["B", "Cut release cycle from 2 weeks to 3 days"],
  ])
  const line = (text: string, factIds: readonly string[]): DocumentLine => ({ text, factIds })
  const summaryDoc = (text: string, factIds: readonly string[]): ResumeContent => ({ kind: "resume", summary: [{ text, factIds }], experience: [], skills: [], education: [] })
  const judged = (text: string, factIds: readonly string[]) => new Set([meaningKey(text, factIds)])

  it("(a) one cited fact's own wording passes unjudged", () => {
    expect(needsMeaningCheck(line(FACTS.get("PAY")!, ["PAY"]), FACTS, null, null, "summary")).toBe(false)
    expect(validateDocument(summaryDoc(FACTS.get("PAY")!, ["PAY"]), FACTS)).toEqual({ ok: true })
  })

  it("(b) two whole fact wordings joined pass unjudged", () => {
    const text = "Mentored 6 junior developers and cut release cycle from 2 weeks to 3 days"
    expect(needsMeaningCheck(line(text, ["A", "B"]), FACTS, null, null, "summary")).toBe(false)
    expect(validateDocument(summaryDoc(text, ["A", "B"]), FACTS)).toEqual({ ok: true })
  })

  it("(c) a reordered list from one fact's list passes unjudged", () => {
    const text = "React, TypeScript"
    const content: ResumeContent = { kind: "resume", summary: [], experience: [], skills: [{ text, factIds: ["LIST"] }], education: [] }
    expect(needsMeaningCheck(line(text, ["LIST"]), FACTS, null, null, "skills")).toBe(false)
    expect(validateDocument(content, FACTS)).toEqual({ ok: true })
  })

  it("(c) a 'Label: a, b, c' bullet from one fact's list passes unjudged", () => {
    const text = "Languages: TypeScript, React"
    expect(needsMeaningCheck(line(text, ["LIST"]), FACTS, null, null, "experience_bullet")).toBe(false)
  })

  it("a reword goes to the judge and passes only on supported: true", () => {
    const reword = "Built wind farm financial models for offshore projects, forecasting revenue and costs."
    expect(needsMeaningCheck(line(reword, ["WIND"]), FACTS, null, null, "summary")).toBe(true)
    expect(validateDocument(summaryDoc(reword, ["WIND"]), FACTS)).toMatchObject({ ok: false, reason: "unsupported_claim" })
    expect(validateDocument(summaryDoc(reword, ["WIND"]), FACTS, null, null, judged(reword, ["WIND"]))).toEqual({ ok: true })
  })

  it.each(["Migrated", "Launched", "Coordinated", "Delivered", "Shipped", "Built", "Created"])(
    "'%s the payments migration' for 'Supported the payments migration' is a hard fail",
    (verb) => {
      const text = `${verb} the payments migration`
      expect(validateDocument(summaryDoc(text, ["PAY"]), FACTS, null, null, judged(text, ["PAY"]))).toMatchObject({
        ok: false,
        reason: "unsupported_claim",
      })
      expect(needsMeaningCheck(line(text, ["PAY"]), FACTS, null, null, "summary")).toBe(false)
    }
  )

  it("'Helped migrate payments' for 'Supported…' is not inflation, so it reaches the judge", () => {
    const text = "Helped migrate payments"
    expect(needsMeaningCheck(line(text, ["PAY"]), FACTS, null, null, "summary")).toBe(true)
    expect(validateDocument(summaryDoc(text, ["PAY"]), FACTS, null, null, judged(text, ["PAY"]))).toEqual({ ok: true })
  })

  it("the fact's section heading or employer is never read by the support test", () => {
    const facts = new Map([["PAY", "Supported the payments migration. Analyst, Lead Bank, 2020–2023"]])
    const text = "Led the payments migration"
    expect(validateDocument(summaryDoc(text, ["PAY"]), facts, null, null, judged(text, ["PAY"]))).toMatchObject({
      ok: false,
      reason: "unsupported_claim",
      unsupported: ["led"],
    })
  })

  it("two identical lines citing different facts do not share one verdict (R15)", () => {
    const text = "Mentored 6 junior developers through weekly pairing."
    const facts = new Map([
      ["F1", "Mentored 6 junior developers"],
      ["F2", "Mentored 6 junior developers"],
    ])
    const verdicts = new Set([meaningKey(text, ["F1"])])
    expect(validateDocument(summaryDoc(text, ["F1"]), facts, null, null, verdicts)).toEqual({ ok: true })
    expect(validateDocument(summaryDoc(text, ["F2"]), facts, null, null, verdicts)).toMatchObject({ ok: false, reason: "unsupported_claim" })
  })
})

// Revision 3, R19: a quotation in a line the judge can see must repeat a stored direction quote or a cited
// fact's own words. Provenance is a string question, so code answers it as a hard fail either flag state.
describe("EPIC-0012 Revision 3, R19: a quotation must come from somewhere", () => {
  const QUOTE = "We will cut water use by 40% across the group"
  const POSTING = `Sustainability consulting firm. ${QUOTE}.`
  // The file's facts plus the wind fact the direction-quote cases cite.
  const FACTS19 = new Map([
    ...FACTS,
    ["WIND", "Built wind farm financial models for offshore projects, forecasting revenue and cost"],
  ])
  const line = (text: string, factIds: readonly string[]): DocumentLine => ({ text, factIds })
  const summaryDoc = (text: string, factIds: readonly string[]): ResumeContent => ({ kind: "resume", summary: [{ text, factIds }], experience: [], skills: [], education: [] })
  const letterDoc = (text: string, factIds: readonly string[]): CoverLetterContent => ({
    kind: "cover_letter",
    greeting: "Dear Hiring Team,",
    opening: null,
    paragraphs: [{ text, factIds }, { text: "Mentored 6 junior developers.", factIds: ["F3"] }],
    closingLine: null,
    closing: "Kind regards,",
  })
  const judged = (text: string, factIds: readonly string[]) => new Set([meaningKey(text, factIds)])

  it("a quoted phrase from a cited fact is not a provenance failure", () => {
    const text = 'I "mentored 6 junior developers" through weekly pairing.'
    expect(validateDocument(summaryDoc(text, ["F3"]), FACTS19, null, null, judged(text, ["F3"]))).toEqual({ ok: true })
    expect(needsMeaningCheck(line(text, ["F3"]), FACTS19, null, null, "summary")).toBe(true)
  })

  it("a quoted posting phrase the posting never verified fails with both flags off", () => {
    const off = postingGuard(POSTING, "Sustainability Consultant", [], true, [])
    const text = 'I will "cut water use by 40" for the group.'
    expect(validateDocument(summaryDoc(text, ["F3"]), FACTS19, null, null, judged(text, ["F3"]), off)).toMatchObject({
      ok: false,
      reason: "unsupported_claim",
      hardFail: "unsourced_quote",
    })
    // A hard fail no judge answer can release, so the line never reaches the meaning check.
    expect(needsMeaningCheck(line(text, ["F3"]), FACTS19, null, null, "summary", off)).toBe(false)
  })

  it("a verified direction quote is a source, so the same phrase passes when judged", () => {
    const on = postingGuard(POSTING, "Sustainability Consultant", [], true, [QUOTE])
    const text = 'Your plan to "cut water use by 40%" is clear. I built wind farm financial models for offshore projects, forecasting revenue and cost.'
    expect(validateDocument(letterDoc(text, ["WIND"]), FACTS19, { employer: "Verdant", roleTitle: "Sustainability Consultant" }, null, judged(text, ["WIND"]), on)).toEqual({ ok: true })
  })

  it("a cut inside a word has no source, so it never reaches the judge", () => {
    const on = postingGuard(POSTING, "Sustainability Consultant", [], true, [QUOTE])
    const text = "Your plan to “ut water use by 40%” is clear."
    expect(needsMeaningCheck(line(text, ["WIND"]), FACTS19, null, null, "letter_paragraph", on)).toBe(false)
  })

  it("an apostrophe is not a quotation", () => {
    expect(needsMeaningCheck(line("I'm glad the teams' goals are clear.", ["F3"]), FACTS19, null, null, "summary")).toBe(true)
  })

  it("an unbalanced double mark fails closed on the whole sentence", () => {
    const on = postingGuard(POSTING, "Sustainability Consultant", [], true, [QUOTE])
    const text = "Your plan to “cut water use by 40% across the group is clear."
    expect(needsMeaningCheck(line(text, ["WIND"]), FACTS19, null, null, "letter_paragraph", on)).toBe(false)
    expect(validateDocument(letterDoc(text, ["WIND"]), FACTS19, null, null, judged(text, ["WIND"]), on)).toMatchObject({
      ok: false,
      hardFail: "unsourced_quote",
    })
  })
})

// Revision 3, R17: a paragraph the keyword cap trimmed is re-checked as it would be stored. A trimmed
// paragraph that fails is dropped, and the letter is never emptied: the last body paragraph goes back to its
// untrimmed form instead, over the cap.
describe("EPIC-0012 Revision 3, R17: the cap settles a trimmed paragraph instead of blocking", () => {
  const kw = (keyword: string): AtsKeyword => ({ keyword, kind: "technology", group: `one:${keyword.toLowerCase()}` })
  const JEST = [kw("Jest")]
  const TARGET = { employer: "Acme Payments", roleTitle: "Sustainability Consultant" }
  const cover = (paragraphs: readonly string[]): CoverLetterContent => ({
    kind: "cover_letter",
    greeting: "Dear Hiring Team,",
    opening: null,
    paragraphs: paragraphs.map((text) => ({ text, factIds: ["F3"] })),
    closingLine: null,
    closing: "Kind regards,",
  })

  it("drops a trimmed paragraph that fails, while another body paragraph is kept", () => {
    const letter = cover(["I tested the pages with Jest.", "I tested the forms with Jest.", "I tested the charts with Jest.", "I tested the report with Jest. I led the team."])
    const capped = capLetterKeywords(letter, JEST)
    expect(capped.trimmed).toHaveLength(1)
    const settled = settleCappedLetter(capped, FACTS, TARGET, null, new Set(), null, null)
    expect(settled.paragraphsDropped).toBe(1)
    expect(settled.restored).toBe(0)
    expect(settled.letter.paragraphs.map((paragraph) => paragraph.text)).not.toContain("I led the team.")
    expect(settled.letter.paragraphs).toHaveLength(3)
  })

  it("drops a failing trimmed paragraph when another trimmed paragraph is kept", () => {
    const facts = new Map([...FACTS, ["CAP", "Tested the pages, forms and charts with Jest"]])
    const coverWith = (factId: string) => (texts: readonly string[]): CoverLetterContent => ({
      kind: "cover_letter",
      greeting: "Dear Hiring Team,",
      opening: null,
      paragraphs: texts.map((text) => ({ text, factIds: [factId] })),
      closingLine: null,
      closing: "Kind regards,",
    })
    const first = "I tested the pages with Jest. I tested the forms with Jest. I tested the charts with Jest. I tested the report with Jest."
    const second = "I tested the email with Jest. I led the team."
    const capped = capLetterKeywords(coverWith("CAP")([first, second]), JEST)
    expect(capped.trimmed).toHaveLength(2)
    const verdicts = new Set([meaningKey(first, ["CAP"])])
    const settled = settleCappedLetter(capped, facts, TARGET, null, verdicts, null, null)
    expect(settled.paragraphsDropped).toBe(1)
    expect(settled.restored).toBe(0)
    expect(settled.letter.paragraphs).toHaveLength(1)
  })

  it("restores the untrimmed form when the failing trimmed paragraph is all that is left (over the cap)", () => {
    const text = "I used Jest one. I used Jest two. I used Jest three. I used Jest four."
    const capped = capLetterKeywords(cover([text]), JEST)
    expect(capped.trimmed).toHaveLength(1)
    expect(capped.overCap).toBe(false)
    const settled = settleCappedLetter(capped, FACTS, TARGET, null, new Set(), null, null)
    expect(settled.paragraphsDropped).toBe(0)
    expect(settled.restored).toBe(1)
    expect(settled.letter.paragraphs.map((paragraph) => paragraph.text)).toEqual([text])
  })

  it("carries a judged paragraph's verdict to the text the cap left, but never a mechanical one", () => {
    const judgedText = "I tested the checkout with Jest. I checked the cart totals."
    const capped = capLetterKeywords(cover(["I tested the pages with Jest.", "I tested the forms with Jest.", "I tested the charts with Jest.", judgedText]), JEST)
    const verdicts = new Set([meaningKey(judgedText, ["F3"])])
    const settled = settleCappedLetter(capped, FACTS, TARGET, null, verdicts, null, null)
    expect(settled.checked.has(meaningKey("I checked the cart totals.", ["F3"]))).toBe(true)
    expect(settled.paragraphsDropped).toBe(0)
    expect(settled.letter.paragraphs.at(-1)?.text).toBe("I checked the cart totals.")
  })
})

describe("EPIC-0009 follow-up: the letter is judged sentence by sentence", () => {
  const TARGET = { employer: "Acme Payments", roleTitle: "Frontend Engineer" }
  const paragraph = (text: string, factIds: readonly string[] = ["F3"]): CoverLetterContent => ({
    kind: "cover_letter",
    greeting: "Dear Hiring Team at Acme Payments,",
    opening: null,
    paragraphs: [{ text, factIds }],
    closingLine: null,
    closing: "Kind regards,",
  })
  const OPINION = "I work well in remote teams."
  const FACT = "I mentored 6 junior developers."

  it("drops only the refused sentence and keeps its judged neighbours", () => {
    const text = `${OPINION} ${FACT}`
    // The judge supported the fact sentence and refused the opinion one.
    const judged = new Set([meaningKey(FACT, ["F3"])])
    const result = dropUnsupportedSentences(paragraph(text), FACTS, TARGET, null, judged)
    expect(result.letter.paragraphs.map((line) => line.text)).toEqual([FACT])
    expect(result.dropped).toBe(1)
    // The kept subset carries a carved verdict, so the letter validates without another judge call.
    expect(validateDocument(result.letter, FACTS, TARGET, null, result.checked)).toEqual({ ok: true })
  })

  it("keeps a paragraph whose every sentence was judged, though it has no paragraph verdict", () => {
    const text = `${FACT} I cut the release cycle from 2 weeks to 3 days.`
    // Sentence lines cite their paragraph's facts, as `sentencesOfLine` builds them for the judge.
    const judged = new Set([meaningKey(FACT, ["F3", "F4"]), meaningKey("I cut the release cycle from 2 weeks to 3 days.", ["F3", "F4"])])
    const result = dropUnsupportedSentences(paragraph(text, ["F3", "F4"]), FACTS, TARGET, null, judged)
    expect(result.letter.paragraphs.map((line) => line.text)).toEqual([text])
    expect(result.dropped).toBe(0)
    expect(validateDocument(result.letter, FACTS, TARGET, null, result.checked)).toEqual({ ok: true })
  })

  it("names the refused sentence, not the paragraph, when nothing survives", () => {
    // Neither sentence is a fact's own wording, so neither passes without a verdict: nothing survives.
    const text = "I work well in remote teams. I would bring energy to your team."
    const result = dropUnsupportedSentences(paragraph(text), FACTS, TARGET, null, new Set())
    // The letter never goes bodiless: the paragraph stays and the block names the sentence to act on.
    expect(result.letter.paragraphs.map((line) => line.text)).toEqual([text])
    expect(refusedSentence(result.letter, FACTS, TARGET, null, result.checked)).toBe(OPINION)
    expect(validateDocument(result.letter, FACTS, TARGET, null, result.checked)).toMatchObject({ ok: false, claim: text })
  })

  it("never splits a paragraph that holds a quotation: the claim and its quote stay one unit", () => {
    const text = "Your plan to “halve emissions by 2030” is clear. That target was met by my models."
    const judged = new Set([meaningKey("That target was met by my models.", ["F3"])])
    const result = dropUnsupportedSentences(paragraph(text), FACTS, TARGET, null, judged)
    // The quotation fails on its own (it is in no cited fact), so the paragraph is not trimmed to the tie.
    expect(result.letter.paragraphs.map((line) => line.text)).toEqual([text])
    expect(validateDocument(result.letter, FACTS, TARGET, null, result.checked)).toMatchObject({ ok: false })
  })
})
