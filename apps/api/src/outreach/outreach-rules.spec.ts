import { describe, expect, it } from "vitest"

import { OUTREACH_BUDGETS, OUTREACH_GREETING_RESERVE, OUTREACH_KINDS, READER_NAME_MAX, type OutreachKind, composeOutreachText, outreachLength } from "@eve/contracts"

import type { StoredSection } from "../db/schema.js"
import { postingGuard, validateDocument } from "../documents/document-claims.js"
import { factsOf } from "../documents/document-generation.js"
import { meaningKey } from "../documents/line-text.js"
import {
  type CheckContext,
  OUTREACH_OPENING_WORDS,
  type Part,
  type TargetNames,
  applyVerdicts,
  checkForm,
  checkParts,
  droppedCounts,
  fillTokens,
  finishPipeline,
  firstFailedQuote,
  hasUnfilledPlaceholder,
  judgeItems,
  outreachRuleIn,
  splitParts,
} from "./outreach-rules.js"

/**
 * EPIC-0014 outreach rules (architecture r1 D5, D6, D13): the decisions code
 * makes with no database and no model. The judge is a stand-in that approves
 * every sentence sent to it unless a test names one to refuse.
 */
const TARGET = { company: "Northwind Labs", roleTitle: "Senior Frontend Engineer" }

const SECTION: StoredSection = {
  id: "s1",
  kind: "experience",
  title: "",
  organization: null,
  period: null,
  sourceQuote: null,
  facts: [
    { id: "F1", text: "Built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd", sourceQuote: null },
    { id: "F2", text: "Senior Frontend Engineer at Brightwave Ltd, 2021 to 2024", sourceQuote: null },
    { id: "F3", text: "Mentored 6 junior developers", sourceQuote: null },
    { id: "F4", text: "Cut release cycle from 2 weeks to 3 days", sourceQuote: null },
    { id: "F5", text: "Built a Node.js GraphQL gateway and a REST API at Brightwave Ltd, saving $40k a year", sourceQuote: null },
  ],
}

const CONTEXT: CheckContext = {
  facts: new Map(factsOf(SECTION)),
  wording: new Map(SECTION.facts.map((fact) => [fact.id, fact.text] as const)),
  contact: { name: "Sam Adeyemi", lines: ["sam@example.com", "+234 801 234 5678"] },
  guard: postingGuard("Build design systems with React and TypeScript. You will mentor engineers and ship weekly.", TARGET.roleTitle, [], false),
}

type Sentence = Readonly<{ kind: "statement" | "ask"; text: string; factIds: readonly string[] }>
const statement = (text: string, ...factIds: string[]): Sentence => ({ kind: "statement", text, factIds })
const ask = (text: string): Sentence => ({ kind: "ask", text, factIds: [] })

const F1 = statement("I built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd.", "F1")
const F3 = statement("I mentored 6 junior developers.", "F3")
const REFERRAL_ASK = ask("Would you be open to referring me for {role_phrase} at {company_phrase}, with no pressure at all if the answer is no?")
const INTRO_ASK = ask("Could we have a short conversation, or could you point me to the right person?")

/** One Run's pure half: split, check, judge (a stand-in), verdicts, structure and budget. */
function run(reply: readonly Sentence[], kind: OutreachKind = "referral_request", options: { refuse?: (text: string) => boolean; target?: TargetNames } = {}) {
  const target = options.target ?? TARGET
  const parts = splitParts(reply, (alias) => alias, target)
  const hardFails = checkParts(parts, CONTEXT)
  const items = judgeItems(parts, CONTEXT.facts)
  const refuse = options.refuse ?? (() => false)
  const supported = new Set(items.filter((item) => !refuse(item.line.text)).map((item) => meaningKey(item.line.text, item.line.factIds)))
  applyVerdicts(parts, CONTEXT, supported)
  const result = finishPipeline(parts, kind, target, 1)
  return { parts, hardFails, items, result }
}

/** A sentence is gone from a Run that ends `ready`: the body holds none of it. */
function bodyOf(result: ReturnType<typeof run>["result"]): string {
  if (result.outcome !== "ready") throw new Error(`expected ready, got ${result.outcome}`)
  return result.ready.body
}

describe("outreachRuleIn: one case per outreach-only row of the AC 3 table", () => {
  it.each([
    ["greeting", "Hi Priya,"],
    ["greeting", "Dear Hiring Manager,"],
    ["greeting", "To whom it may concern,"],
    ["application_status", "I have already applied for the Senior Frontend Engineer role."],
    ["application_status", "I submitted my application to Northwind Labs this week."],
    ["application_status", "My application is queued and will be sent automatically."],
    ["sign_off", "Best,"],
    ["sign_off", "Kind regards,"],
    ["sign_off", "Sent from my phone"],
    ["sign_off", "Best regards, Sam"],
    ["link", "I was a Senior Frontend Engineer, see https://sambalicious.dev."],
    ["link", "I was a Senior Frontend Engineer, see www.sambalicious.dev."],
    ["link", "I was a Senior Frontend Engineer, see sambalicious.dev."],
    ["link", "I was a Senior Frontend Engineer, see example.dev."],
    ["link", "I was a Senior Frontend Engineer, see linkedin.com/in/sam-adeyemi."],
    ["link", "I was a Senior Frontend Engineer, find me at @sam_codes."],
    ["link", "I was a Senior Frontend Engineer #frontend."],
    ["link", "See /portfolio for my work."],
    ["pay", "My salary expectation is USD 5,000 per month."],
    ["pay", "My rate is $60 per hour."],
    ["pay", "I have a 30 day notice period."],
    ["pay", "I can start on 1 December 2026."],
    ["pay", "I am available immediately."],
    ["pay", "I am looking for 90,000 dollars a year."],
    ["eligibility", "I can relocate for this role."],
    ["eligibility", "I will need visa sponsorship."],
    ["eligibility", "I am authorised to work in Nigeria."],
    ["eligibility", "I live in Lagos."],
    ["eligibility", "I am based in Lagos."],
    ["eligibility", "I work across time zones."],
    ["reader_praise", "I admire Northwind Labs and its product."],
    ["reader_praise", "Congratulations on the launch."],
    ["reader_praise", "I was impressed by your talk."],
    ["reader_praise", "I noticed you are hiring."],
    ["bracket", "[Name], I built the dashboard."],
    ["bracket", "{company} needs a frontend lead."],
    ["bracket", "I want the <role> position."],
    ["emoji", "I built the dashboard \u{1F680}"],
    ["markdown", "I was a **Senior Frontend Engineer** at Brightwave Ltd."],
    ["markdown", "- I was a Senior Frontend Engineer at Brightwave Ltd."],
    ["markdown", "# About me: I was a Senior Frontend Engineer."],
    ["caps_run", "I WAS A SENIOR FRONTEND ENGINEER AT BRIGHTWAVE LTD."],
    ["mentions_eve", "I used an AI assistant to write this message."],
    ["mentions_eve", "Eve wrote this message for me."],
    ["other_offers", "I have other offers and interest from other employers."],
  ] as const)("%s: %s", (rule, text) => {
    expect(outreachRuleIn(text)).toBe(rule)
  })

  it.each([
    "As discussed, I built the dashboard.",
    "Following up on our conversation, I built the dashboard.",
    "I hope you're well, I built the dashboard.",
    "I hope you\u2019re well, I built the dashboard.",
    "Your colleague suggested I write to you.",
    "We have a mutual connection at Northwind Labs.",
    "Thanks for referring me.",
    "It was great meeting you last week.",
    "We spoke at a React meetup.",
    "We met at a React meetup.",
    "It's been a while since we last talked.",
    "Someone on your team recommended me.",
    "I was referred to you by a friend.",
  ])("relationship, at least eight phrasings: %s", (text) => {
    expect(outreachRuleIn(text)).toBe("relationship")
  })

  it("lets a plain statement, a fact-backed technology and a plain Ask through", () => {
    expect(outreachRuleIn("I mentored 6 junior developers.")).toBeNull()
    expect(outreachRuleIn("I am applying for the role.")).toBeNull()
    expect(outreachRuleIn("Would you be open to referring me for {role_phrase} at {company_phrase}?")).toBeNull()
    expect(outreachRuleIn("Would you be open to referring me for the Senior Frontend Engineer role at Northwind Labs?")).toBeNull()
    expect(outreachRuleIn("I built a design system with high availability in mind.")).toBeNull()
    expect(outreachRuleIn("I built payment APIs at Visa.")).toBeNull()
    expect(outreachRuleIn("I use e.g. React and v2.0 of the API.")).toBeNull()
  })

  it("allows a domain-shaped technology name only when a cited fact states it and its suffix is js, ts or net", () => {
    expect(outreachRuleIn("I built a Node.js gateway.", ["Built a Node.js gateway at Brightwave Ltd"])).toBeNull()
    expect(outreachRuleIn("I built an ASP.NET service.", ["Built an ASP.NET service"])).toBeNull()
    // No cited fact states it: the posting cannot create one.
    expect(outreachRuleIn("I built a Node.js gateway.")).toBe("link")
    expect(outreachRuleIn("I built a Node.js gateway.", ["Built a React dashboard"])).toBe("link")
    // A fact-stated token with a link suffix is still a link: the Candidate's own site is dropped too.
    expect(outreachRuleIn("I run mysite.dev.", ["I run mysite.dev"])).toBe("link")
  })

  it("lets an all-capital pair and a currency figure through only when a cited fact holds the same text", () => {
    expect(outreachRuleIn("I built a REST API.", ["Built a REST API at Brightwave Ltd"])).toBeNull()
    expect(outreachRuleIn("I built a REST API.")).toBe("caps_run")
    expect(outreachRuleIn("I saved $40k a year.", ["Saved $40k a year"])).toBeNull()
    expect(outreachRuleIn("I saved $40k a year.")).toBe("pay")
  })

  it("is not fooled by a filled token, a code extension, or a placeholder word of a Ask", () => {
    expect(outreachRuleIn("Could you refer me to {role_phrase}?")).toBeNull()
    expect(outreachRuleIn("Could you refer me to {role}?")).toBe("bracket")
  })
})

describe("the Ask goes through the shared claim check with nothing to cite (D5, AC 2.5)", () => {
  it.each([
    ["a number", "Could we speak for 15 minutes?"],
    ["a date", "Could we speak in March 2027?"],
    ["a capitalised name", "Could you point me to the Platform team?"],
    ["a technology", "Would a short chat about Angular work for you?"],
    ["a title", "Could you point me to the Engineering Director?"],
    ["a qualification", "Could we talk, given my AWS Certified Solutions Architect certification?"],
  ])("removes an Ask that holds %s and quotes it", (_case, text) => {
    const { result, parts } = run([F1, ask(text)], "introduction")
    expect(result.outcome).toBe("blocked")
    expect(firstFailedQuote(parts)).toBe(text)
  })

  it.each([
    ["the usual referral ask, written with the role and company tokens", REFERRAL_ASK],
    ["the usual introduction ask", INTRO_ASK],
    ["a plain ask", ask("Would you be open to a short conversation?")],
    ["an ask written with the placeholders", ask("Would you be open to referring me for {role_phrase} at {company_phrase}, with no pressure at all if the answer is no?")],
    ["interest wording inside an ask", ask("Because I'm interested in the role, would you be open to referring me, with no pressure at all if the answer is no?")],
    ["a modal opener", ask("Might you point me to the right person?")],
  ])("keeps %s", (_case, sentence) => {
    const { result } = run([F1, sentence])
    expect(result.outcome).toBe("ready")
  })

  it("never releases an Ask by code alone: the judge must say supported", () => {
    const { parts, items, result } = run([F1, REFERRAL_ASK], "referral_request", { refuse: (text) => text.startsWith("Would you") })
    expect(items.map((item) => item.line.factIds)).toEqual([[]])
    expect(parts[1]!.removed).toBe("judge")
    expect(result.outcome).toBe("blocked")
    expect(firstFailedQuote(parts)).toBe(REFERRAL_ASK.text)
  })

  it("sends every surviving Ask to the judge and no Statement that code already decided", () => {
    const { items } = run([F1, F3, statement("I built the merchant dashboard in Angular.", "F1"), REFERRAL_ASK])
    expect(items.map((item) => item.line.text)).toEqual([expect.stringMatching(/^Would you be open to referring me for the Senior Frontend Engineer role at Northwind Labs/)])
  })

  it("treats a sentence labelled an ask that makes a claim as a failure", () => {
    const { result, parts } = run([F1, REFERRAL_ASK, ask("Would you refer me, having led teams of 8 engineers at Brightwave Ltd?")])
    expect(result.outcome).toBe("ready")
    expect(parts[2]!.removed).toBe("claim")
  })

  it("exports the openers the Copywriter's example asks start with", () => {
    for (const word of ["would", "could", "can", "is", "are", "do", "does", "any"]) expect(OUTREACH_OPENING_WORDS.has(word)).toBe(true)
  })
})

describe("the Application's own company and role are exempt in an Ask's tokens only (AC 2.6, CR-1, r7)", () => {
  it("removes a statement that names the role and company exactly as shown, when no cited fact states them", () => {
    const { parts } = run([
      F1,
      statement("I am interested in the Senior Frontend Engineer role at Northwind Labs, and I was a Senior Frontend Engineer at Brightwave Ltd from 2021 to 2024.", "F2"),
      REFERRAL_ASK,
    ])
    expect(parts[1]!.removed).toBe("claim")
  })

  it.each([
    ["a claim of employment at the target company", "I worked at Northwind Labs for 5 years."],
    ["a claim of employment at the target company written with the company token", "I worked at {company_phrase} for 5 years."],
    ["a claim of the target role at the target company", "I was a Senior Frontend Engineer at Northwind Labs for 5 years."],
  ])("ends blocked for %s in a Statement", (_case, text) => {
    // F6 states "5 years" at another employer: only the target's name is unsupported, as in the reviewer's probe.
    const section: StoredSection = { ...SECTION, facts: [...SECTION.facts, { id: "F6", text: "Frontend Engineer for 5 years at Brightwave Ltd", sourceQuote: null }] }
    const context: CheckContext = { ...CONTEXT, facts: new Map(factsOf(section)), wording: new Map(section.facts.map((fact) => [fact.id, fact.text] as const)) }
    const parts = splitParts([statement(text, "F6"), REFERRAL_ASK], (alias) => alias, TARGET)
    checkParts(parts, context)
    const items = judgeItems(parts, context.facts)
    expect(parts[0]!.removed).toBe("claim")
    expect(items.every((item) => item.line.factIds.length === 0)).toBe(true)
    const supported = new Set(items.map((item) => meaningKey(item.line.text, item.line.factIds)))
    applyVerdicts(parts, context, supported)
    const result = finishPipeline(parts, "referral_request", TARGET, 1)
    expect(result.outcome).toBe("blocked")
    expect(firstFailedQuote(parts)).toBe(text)
  })

  it("keeps the target name in the text the checks and the judge read for a Statement", () => {
    const parts = splitParts([statement("I worked at Northwind Labs for 5 years.", "F1"), statement("I like {company_phrase}.", "F1")], (alias) => alias, TARGET)
    expect(parts[0]!.checkText).toBe("I worked at Northwind Labs for 5 years.")
    expect(parts[1]!.checkText).toBe("I like Northwind Labs.")
  })

  it.each([
    ["the company and the role title in any case", "I'd love to join Northwind Labs as a senior frontend engineer."],
    ["the company and the role title as shown", "I'd love to join Northwind Labs as a Senior Frontend Engineer."],
    ["the exact title with the word role", "Would you be open to referring me for the Senior Frontend Engineer role at Northwind Labs?"],
    ["only the company", "Is Northwind Labs open to a short chat?"],
    ["a request opener", "Please could you refer me for the Senior Frontend Engineer role at Northwind Labs?"],
    ["I would like", "I would like to be considered for the Senior Frontend Engineer role at Northwind Labs."],
  ])("r7: removes in code an Ask that writes the target's literal name, with %s, exactly as a Statement would be", (_case, text) => {
    const { parts, items, result } = run([F1, ask(text)])
    expect(parts[1]!.removed).toBe("claim")
    expect(parts[1]!.checkText).toBe(text)
    expect(items).toEqual([])
    expect(result.outcome).toBe("blocked")
    expect(firstFailedQuote(parts)).toBe(text)
  })

  it("r7: passes the Ask written with the tokens (AC 2.6), and the same sentence with literal names fails", () => {
    const token = run([F1, ask("I'd love to join {company_phrase} as a {role_phrase}.")])
    expect(token.parts[1]!.removed).toBeNull()
    expect(token.parts[1]!.checkText).toBe("I'd love to join the company as a the role.")
    expect(token.result.outcome).toBe("ready")
    const literal = run([F1, ask("I'd love to join Northwind Labs as a Senior Frontend Engineer.")])
    expect(literal.parts[1]!.removed).toBe("claim")
    expect(literal.result.outcome).toBe("blocked")
  })

  it.each([
    ["a role then a company", "Would you refer me, a Senior Frontend Engineer at Northwind Labs?"],
    ["since I'm at", "Would you refer me, since I'm at Northwind Labs?"],
    ["since I am at", "Would you refer me, since I am at Northwind Labs?"],
    ["since the company is my employer", "Would you refer me, since Northwind Labs is my employer?"],
    ["since the company employs me", "Would you refer me, since Northwind Labs already employs me?"],
    ["a former title", "Would you refer me, a former Senior Frontend Engineer at Northwind Labs?"],
    ["since I hold the title", "Would you refer me, since I hold the Senior Frontend Engineer title?"],
    ["since I do the work", "Would you refer me, since I do Senior Frontend Engineer work at Northwind Labs?"],
    ["a background", "Would you refer me, given my Senior Frontend Engineer background at Northwind Labs?"],
    ["a veteran", "Would you refer me, a Northwind Labs veteran?"],
    ["an alumnus", "Would you refer me, as a Northwind Labs alumnus?"],
  ])("r7: blocks the Security re-check's non-verb claim, %s, and the judge never sees it blanked", (_case, text) => {
    const { parts, items, result } = run([F1, ask(text)])
    expect(parts[1]!.removed).toBe("claim")
    expect(items).toEqual([])
    expect(result.outcome).toBe("blocked")
    expect(firstFailedQuote(parts)).toBe(text)
  })

  it.each([
    ["the verb claims from NEW-1", "Would you refer me, since I was a Senior Frontend Engineer at Northwind Labs?"],
    ["a claim first", "I was the Senior Frontend Engineer at Northwind Labs, so would you refer me?"],
    ["a perfect tense claim", "Would you refer me, as I've worked at Northwind Labs as a Senior Frontend Engineer?"],
    ["my experience", "Would you refer me, given my experience as a Senior Frontend Engineer at Northwind Labs?"],
    ["my time at", "Could you point me to someone, after my time at Northwind Labs?"],
    ["a request opener", "I'd love to join Northwind Labs, where I led the Senior Frontend Engineer team."],
    ["a present tense claim", "Would you refer me, as I work as a Senior Frontend Engineer at Northwind Labs?"],
    ["I am a", "I am a Senior Frontend Engineer at Northwind Labs, would you refer me?"],
  ])("still blocks %s", (_case, text) => {
    const { parts, items, result } = run([F1, ask(text)])
    expect(parts[1]!.removed).toBe("claim")
    expect(items).toEqual([])
    expect(result.outcome).toBe("blocked")
  })

  it("r7: sends the judge the stored form of an Ask, tokens filled with the real company and role, never blanks", () => {
    const { items, parts } = run([F1, ask("Would you refer me, since I'm at {company_phrase} as {role_phrase}?")])
    expect(parts[1]!.checkText).toBe("Would you refer me, since I'm at the company as the role?")
    expect(parts[1]!.judgeText).toBe("Would you refer me, since I'm at Northwind Labs as the Senior Frontend Engineer role?")
    expect(items.map((item) => item.line.text)).toEqual(["Would you refer me, since I'm at Northwind Labs as the Senior Frontend Engineer role?"])
    for (const item of items) expect(item.line.text).not.toMatch(/\bthe company\b|\bas the role\b|\{/)
  })

  it("r7: a token-form Ask that reads as a claim is judged on its real text, and the judge's refusal blocks the Run", () => {
    const sent: string[] = []
    const claim = ask("Would you refer me, since I'm at {company_phrase}?")
    const refused = run([F1, claim], "referral_request", {
      refuse: (text) => {
        sent.push(text)
        return /since I'm at Northwind Labs/.test(text)
      },
    })
    expect(sent).toEqual(["Would you refer me, since I'm at Northwind Labs?"])
    expect(refused.parts[1]!.removed).toBe("judge")
    expect(refused.result.outcome).toBe("blocked")
    expect(firstFailedQuote(refused.parts)).toBe(claim.text)
    // The verdict is keyed on what the judge was sent, so an approval of that text releases the Ask.
    expect(run([F1, claim]).result.outcome).toBe("ready")
  })

  it("r7: a Statement is judged on the same filled text the code checked", () => {
    const { parts } = run([F1, statement("I managed {company_phrase} developers.", "F3"), REFERRAL_ASK])
    expect(parts[1]!.judgeText).toBe(parts[1]!.checkText)
  })

  it("still removes an Ask that uses the tokens and adds a number or another name", () => {
    expect(run([F1, ask("I'd love to join {company_phrase}, where I could speak for 15 minutes.")]).parts[1]!.removed).toBe("claim")
    expect(run([F1, ask("I'd love to join {company_phrase} and work with Contoso.")]).parts[1]!.removed).toBe("claim")
  })

  it("r7: the question or request shape is only a formatting gate: a statement-shaped Ask is removed, named or not", () => {
    for (const text of ["I'd value {role_phrase} at {company_phrase}.", "Referral for {role_phrase} please."]) {
      const { parts, result } = run([F1, ask(text)])
      expect(parts[1]!.removed).toMatch(/outreach_rules|claim/)
      expect(result.outcome).toBe("blocked")
    }
    const shape = run([F1, ask("I'd value {role_phrase} at {company_phrase}.")])
    expect(shape.parts[1]!.removed).toBe("outreach_rules")
    expect(shape.hardFails).toEqual({ ask_shape: 1 })
  })

  it.each([
    ["a question mark", "Is {company_phrase} open to a short chat?"],
    ["a request opener", "Please could you refer me for {role_phrase} at {company_phrase}?"],
    ["I would like", "I would like to be considered for {role_phrase} at {company_phrase}."],
    ["I'm writing", "I'm writing to ask about {role_phrase} at {company_phrase}."],
    ["I'd love", "I'd love to join {company_phrase}."],
  ])("passes a pure Ask written with the tokens, with %s", (_case, text) => {
    const { parts, result } = run([F1, ask(text)])
    expect(parts[1]!.removed).toBeNull()
    expect(result.outcome).toBe("ready")
  })

  it.each([
    ["a number", "Would you refer me for {role_phrase} at {company_phrase}, in 15 minutes?"],
    ["a date", "Would you refer me for {role_phrase} at {company_phrase} by March 2025?"],
    ["a second company", "Would you refer me for {role_phrase} at {company_phrase} or at Contoso?"],
    ["a second company after a request opener", "I'd love to join {company_phrase} and Contoso as {role_phrase}."],
    ["a different title", "Would you refer me for the Principal Frontend Engineer role at {company_phrase}?"],
  ])("removes an Ask written with the tokens that smuggles in %s", (_case, text) => {
    const { parts, result } = run([F1, ask(text)])
    expect(parts[1]!.removed).toBe("claim")
    expect(result.outcome).toBe("blocked")
  })

  it("leaves a Tailored Document line that names its target exactly as before: names_target", () => {
    const content = {
      kind: "cover_letter",
      greeting: "Dear Hiring Team,",
      opening: null,
      paragraphs: [{ text: "I worked at Northwind Labs for 5 years.", factIds: ["F1"] }],
      closingLine: null,
      closing: "Kind regards,",
    } as const
    const target = { employer: TARGET.company, roleTitle: TARGET.roleTitle }
    expect(validateDocument(content, CONTEXT.facts, target)).toMatchObject({ ok: false, reason: "names_target" })
    expect(validateDocument(content, CONTEXT.facts, null)).toMatchObject({ ok: false, reason: "unsupported_claim" })
  })

  it("an Ask cites no facts, whatever the model sent", () => {
    const parts = splitParts([{ kind: "ask", text: "Would you be open to a short chat?", factIds: ["F1", "F3"] }], (alias) => alias, TARGET)
    expect(parts[0]!.factIds).toEqual([])
  })

  it("does not let an Ask borrow a number or a name from the facts it claims to cite (CR-2)", () => {
    const text = "Would you refer me for {role_phrase}, given my 5 years building React dashboards at Brightwave Ltd?"
    const cited = { kind: "ask", text, factIds: ["F1"] } as const
    const { parts, items, result } = run([F3, cited], "referral_request")
    expect(parts[1]!.removed).toBe("claim")
    expect(items).toEqual([])
    expect(result.outcome).toBe("blocked")
    const numbered = run([F3, { kind: "ask", text: "Could we talk for 6 minutes about {role_phrase}?", factIds: ["F3"] }], "introduction")
    expect(numbered.parts[1]!.removed).toBe("claim")
    expect(numbered.result.outcome).toBe("blocked")
  })

  it("sends an Ask that cites facts to the judge as a line with no facts", () => {
    const { items } = run([F1, { kind: "ask", text: "Would you be open to a short chat?", factIds: ["F1"] }])
    expect(items.map((item) => item.line.factIds)).toEqual([[]])
    expect(items[0]!.facts).toEqual([])
  })

  it("an Ask citing a fact cannot use that fact's currency figure to pass the pay rule", () => {
    const { parts } = run([F1, { kind: "ask", text: "Would you refer me, as I saved $40k a year?", factIds: ["F5"] }])
    expect(parts[1]!.removed).toBe("outreach_rules")
  })

  it.each([
    ["a shortened company", "I was a Senior Frontend Engineer at Brightwave Ltd and I like Northwind."],
    ["an altered company", "I was a Senior Frontend Engineer at Brightwave Ltd and I like Northwind Labs Inc."],
    ["an altered title", "I was a Principal Frontend Engineer at Brightwave Ltd from 2021 to 2024."],
  ])("removes %s", (_case, text) => {
    const { parts } = run([F1, statement(text, "F2"), REFERRAL_ASK])
    expect(parts[1]!.removed).toBe("claim")
  })

  it("keeps a title abbreviation the shared check folds to the cited word (sr is senior), as documents do", () => {
    const { parts } = run([F1, statement("I was a Sr Frontend Engineer at Brightwave Ltd from 2021 to 2024.", "F2"), REFERRAL_ASK])
    expect(parts[1]!.removed).toBeNull()
  })

  it("removes a company the Application does not have", () => {
    const { parts } = run(
      [F1, statement("I would love to join Northwind Labs and I was a Senior Frontend Engineer at Brightwave Ltd.", "F2"), REFERRAL_ASK],
      "referral_request",
      { target: { company: null, roleTitle: TARGET.roleTitle } }
    )
    expect(parts[1]!.removed).toBe("claim")
  })

  it("an Ask's check form neutralises the tokens only; the judge reads the real names", () => {
    const { parts, items } = run([F1, REFERRAL_ASK])
    expect(parts[1]!.checkText).not.toMatch(/Northwind|Senior Frontend Engineer|\{/)
    expect(items).toHaveLength(1)
    expect(items[0]!.line.text).toContain("the Senior Frontend Engineer role at Northwind Labs")
  })

  it("fills the tokens in the output and neutralises only an Ask's tokens in its check form", () => {
    expect(fillTokens("Refer me for {role_phrase} at {company_phrase}.", TARGET)).toBe("Refer me for the Senior Frontend Engineer role at Northwind Labs.")
    expect(checkForm("Please refer me for {role_phrase} at {company_phrase}.", TARGET, "ask")).toBe("Please refer me for the role at the company.")
    expect(checkForm("Please refer me for the Senior Frontend Engineer role at Northwind Labs.", TARGET, "ask")).toBe("Please refer me for the Senior Frontend Engineer role at Northwind Labs.")
    expect(checkForm("Do you know Northwind?", TARGET, "ask")).toBe("Do you know Northwind?")
    expect(checkForm("Do you know Northwind Labs Inc?", TARGET, "ask")).toBe("Do you know Northwind Labs Inc?")
    expect(checkForm("Refer me for the Senior Frontend Engineer role at Northwind Labs.", TARGET, "statement")).toBe("Refer me for the Senior Frontend Engineer role at Northwind Labs.")
    expect(checkForm("Refer me for {role_phrase} at {company_phrase}.", TARGET, "statement")).toBe("Refer me for the Senior Frontend Engineer role at Northwind Labs.")
  })

  it("falls back to the role and the company for a null, over-long or unusable name", () => {
    expect(fillTokens("{role_phrase} at {company_phrase}", { company: null, roleTitle: null })).toBe("the role at the company")
    expect(fillTokens("{role_phrase}", { company: "Acme", roleTitle: "x".repeat(121) })).toBe("the role")
    expect(fillTokens("{company_phrase}", { company: "Booking.com", roleTitle: null })).toBe("the company")
    expect(fillTokens("{role_phrase}", { company: null, roleTitle: "Engineer [II]" })).toBe("the role")
  })

  it("fills a name holding $&, $', $` or $$ literally, never as a replacement pattern", () => {
    const hostile = { company: "Acme $& $' $` $$ Labs", roleTitle: "Dev $& $' $$ lead" }
    expect(fillTokens("Refer me for {role_phrase} at {company_phrase}?", hostile)).toBe("Refer me for the Dev $& $' $$ lead role at Acme $& $' $` $$ Labs?")
    expect(fillTokens("{role_phrase} then {role_phrase}", { company: null, roleTitle: "A $& B" })).toBe("the A $& B role then the A $& B role")
    expect(checkForm("Refer me for {role_phrase}?", hostile, "statement")).toBe("Refer me for the Dev $& $' $$ lead role?")
  })

  it("stores a name holding $&, $' and $$ literally in the body and the sentences", () => {
    const target = { company: "Acme $& $' $$ Labs", roleTitle: "Dev $& $' $$ lead" }
    const { result } = run([F1, REFERRAL_ASK], "referral_request", { target })
    if (result.outcome !== "ready") throw new Error(`expected ready, got ${result.outcome}`)
    const stored = result.ready.sentences.find((sentence) => sentence.kind === "ask")!.text
    expect(stored).toContain("referring me for the Dev $& $' $$ lead role at Acme $& $' $$ Labs")
    expect(result.ready.body).toContain(stored)
    expect(stored).not.toMatch(/[{}]/)
    expect(stored).not.toContain("{role_phrase}")
  })

  it("never stores an unfilled token: a sentence that cannot be filled fails, a name cannot leave one", () => {
    const asked = (text: string): Part => ({ position: 1, original: text, kind: "ask", factIds: [], text, checkText: text, judgeText: text, removed: null, needsJudge: false })
    const lead = (): Part => ({ position: 0, original: "I built it.", kind: "statement", factIds: [], text: "I built it.", checkText: "I built it.", judgeText: "I built it.", removed: null, needsJudge: false })

    for (const text of ["Would you refer me for { role_phrase }?", "Would you refer me for {{role_phrase}}?", "Would you refer me for {role}?", "Would you refer me for {company_phrase?"]) {
      const parts = [lead(), asked(text)]
      const result = finishPipeline(parts, "referral_request", TARGET, 1)
      expect(result.outcome).toBe("blocked")
      expect(parts[1]!.removed).toBe("outreach_rules")
      expect("ready" in result).toBe(false)
    }

    // The old string replacement turned `$&` in a title into the matched token, leaving `{role_phrase}` in the text.
    const parts = [lead(), asked("Would you refer me for {role_phrase}?")]
    const result = finishPipeline(parts, "referral_request", { company: "Acme", roleTitle: "Dev $& lead" }, 1)
    if (result.outcome !== "ready") throw new Error(`expected ready, got ${result.outcome}`)
    expect(result.ready.body).not.toMatch(/[{}]/)
    expect(result.ready.sentences.some((sentence) => /[{}]/.test(sentence.text))).toBe(false)
  })
})

describe("the claim rules per sentence (AC 2.4)", () => {
  it.each([
    ["a skill in no cited fact", statement("I built the merchant dashboard in Angular.", "F1")],
    ["a number in no cited fact", statement("I mentored 12 junior developers.", "F3")],
    ["a number order from one fact", statement("I cut the release cycle from 3 days to 2 weeks.", "F4")],
    ["a Statement citing no fact", statement("I enjoy building design systems.")],
    ["a Statement citing a fact outside the approved version", statement("I built a GraphQL gateway.", "F9")],
    ["an email address", statement("I mentored 6 junior developers, write to sam@example.com.", "F3")],
    ["a phone number", statement("I mentored 6 junior developers, call +234 801 234 5678.", "F3")],
    ["an interest sentence with no fact", statement("I'm interested in the role.")],
  ])("removes %s", (_case, sentence) => {
    const { parts } = run([F1, sentence, REFERRAL_ASK])
    expect(parts[1]!.removed).toMatch(/claim|outreach_rules/)
  })

  it("keeps a lower-case reword the judge supports, and removes it when the judge refuses", () => {
    const reword = statement("I managed 6 junior developers.", "F3")
    const kept = run([F1, reword, REFERRAL_ASK])
    expect(kept.items.map((item) => item.line.text)).toContain("I managed 6 junior developers.")
    expect(kept.parts[1]!.removed).toBeNull()
    const refused = run([F1, reword, REFERRAL_ASK], "referral_request", { refuse: (text) => text.startsWith("I managed") })
    expect(refused.parts[1]!.removed).toBe("judge")
  })

  it("keeps a fact-backed domain name", () => {
    const { parts } = run([F1, statement("I built a Node.js GraphQL gateway at Brightwave Ltd.", "F5"), REFERRAL_ASK])
    expect(parts[1]!.removed).toBeNull()
  })

  it("converts an em dash instead of dropping the sentence", () => {
    const { parts } = run([F1, statement("I mentored 6 junior developers \u2014 across two teams.", "F3"), REFERRAL_ASK])
    expect(parts[1]!.text).toBe("I mentored 6 junior developers, across two teams.")
    expect(parts[1]!.original).toContain("\u2014")
  })

  it("counts reasons, never text", () => {
    const { hardFails } = run([F1, statement("I built it in Angular.", "F1"), statement("See https://a.example.dev.", "F1"), statement("I enjoy building design systems."), REFERRAL_ASK])
    expect(Object.values(hardFails).every((count) => Number.isInteger(count))).toBe(true)
    expect(JSON.stringify(hardFails)).not.toMatch(/Angular|example/)
    expect(hardFails["link"]).toBe(1)
  })
})

describe("firstFailedQuote: which sentence a blocked Run stores (D13)", () => {
  const part = (overrides: Partial<Part>): Part => {
    const text = overrides.text ?? "A sentence."
    return { position: 0, original: text, kind: "statement", factIds: ["F1"], text, checkText: text, judgeText: text, removed: null, needsJudge: false, ...overrides }
  }

  it("takes the lowest reply position, not the first stage to fail", () => {
    const parts = [
      part({ position: 0 }),
      part({ position: 1, original: "I led the Zorvex migration.", removed: "judge" }),
      part({ position: 2, kind: "ask" }),
      part({ position: 3, original: "I built it in Angular.", removed: "claim" }),
    ]
    expect(firstFailedQuote(parts)).toBe("I led the Zorvex migration.")
  })

  it("is by position across stages, in a real Run: a judge refusal at 1 beats a rule failure at 4", () => {
    const { parts, result } = run(
      [statement("I managed 6 junior developers.", "F3"), statement("I see https://x.example.dev."), statement("I built the dashboard in Angular.", "F1"), statement("I enjoy design systems."), statement("See www.me.dev.")],
      "application_note",
      { refuse: (text) => text.startsWith("I managed") }
    )
    expect(result.outcome).toBe("blocked")
    expect(firstFailedQuote(parts)).toBe("I managed 6 junior developers.")
    const reverse = run([statement("See www.me.dev."), statement("I managed 6 junior developers.", "F3")], "application_note", { refuse: (text) => text.startsWith("I managed") })
    expect(firstFailedQuote(reverse.parts)).toBe("See www.me.dev.")
  })

  it("counts a failed Ask when it is first, and never a duplicate, a structure removal or a budget removal", () => {
    expect(firstFailedQuote([part({ position: 0, original: "Could you refer me to Zorvex?", kind: "ask", removed: "judge" }), part({ position: 1, removed: "claim" })])).toBe("Could you refer me to Zorvex?")
    expect(
      firstFailedQuote([
        part({ position: 0, removed: "duplicate" }),
        part({ position: 1, kind: "ask", removed: "structure" }),
        part({ position: 2, removed: "budget" }),
      ])
    ).toBeNull()
  })

  it("ends blocked with no sentence for a reply with no Ask and nothing failed, and with the Statement when one failed", () => {
    const none = run([F1, F3], "introduction")
    expect(none.result).toMatchObject({ outcome: "blocked", quote: null })
    const some = run([F1, statement("I built it in Angular.", "F1")], "introduction")
    expect(some.result).toMatchObject({ outcome: "blocked", quote: "I built it in Angular." })
  })

  it("stores only the failing part of an element that held two sentences", () => {
    const ready = run([statement("I mentored 6 junior developers. I built the dashboard in Angular.", "F3")], "application_note")
    expect(ready.parts.map((entry) => entry.removed)).toEqual([null, "claim"])
    expect(bodyOf(ready.result)).toBe("I mentored 6 junior developers.")
    // An Introduction with no Ask ends blocked, and quotes the failing part, not the passing one or the element.
    const blocked = run([statement("I built the dashboard in Angular. I mentored 6 junior developers.", "F3")], "introduction")
    expect(blocked.result).toMatchObject({ outcome: "blocked", quote: "I built the dashboard in Angular." })
  })

  it("keeps the model's own text: quotation marks, an ampersand, angle brackets, an em dash, a token and another script", () => {
    const original = "I said \"ship it\" & built <b>Q&A</b> tools \u2014 for {role_phrase} in \u65E5\u672C\u8A9E."
    expect(firstFailedQuote([part({ position: 0, original, text: original, removed: "outreach_rules" })])).toBe(original)
  })

  it("keeps the token and trims only surrounding whitespace", () => {
    const { parts } = run([F1, statement("  Could you refer me to {role_phrase}?  ")], "referral_request")
    expect(parts[1]!.original).toBe("Could you refer me to {role_phrase}?")
  })

  it("caps at 400 code points at a whole word, and withholds an unbroken token", () => {
    const long = part({ position: 0, original: `${"word ".repeat(100)}end.`, removed: "claim" })
    const quote = firstFailedQuote([long])!
    expect(outreachLength(quote)).toBeLessThanOrEqual(400)
    expect(quote.endsWith(" \u2026")).toBe(true)
    expect(firstFailedQuote([part({ position: 0, original: "a".repeat(401), removed: "claim" })])).toBeNull()
  })

  it("never stores a sentence of a Run that still writes", () => {
    const { parts, result } = run([F1, statement("I built it in Angular.", "F1"), REFERRAL_ASK])
    expect(result.outcome).toBe("ready")
    expect(JSON.stringify(result)).not.toContain("Angular")
    expect(droppedCounts(parts)).toEqual({ claim: 1 })
  })
})

describe("the token rule: a template with a hole in it is not the sentence that failed", () => {
  it("detects an unfilled placeholder, so the web can withhold a stored sentence that holds one", () => {
    expect(hasUnfilledPlaceholder("Could you refer me to {role_phrase} at {company_phrase}?")).toBe(true)
    expect(hasUnfilledPlaceholder("I like {company}.")).toBe(true)
    expect(hasUnfilledPlaceholder("I use a {} literal and plain braces: } {")).toBe(true)
    expect(hasUnfilledPlaceholder("I said \"ship it\" & built <b>Q&A</b> tools.")).toBe(false)
  })

  it("stores a failed Ask verbatim with its token, as the model wrote it", () => {
    const { parts } = run([F1, ask("Could we speak for 15 minutes about {role_phrase}?")], "introduction")
    expect(firstFailedQuote(parts)).toBe("Could we speak for 15 minutes about {role_phrase}?")
  })
})

describe("finishPipeline: structure (D5 step 8)", () => {
  const body = (result: ReturnType<typeof run>["result"]) => bodyOf(result)

  it("keeps the first Ask and needs one Statement for a Referral request", () => {
    const { parts, result } = run([F1, REFERRAL_ASK, ask("Could we talk?")])
    expect(body(result)).toBe(`${F1.text} Would you be open to referring me for the Senior Frontend Engineer role at Northwind Labs, with no pressure at all if the answer is no?`)
    expect(parts[2]!.removed).toBe("structure")
    expect(firstFailedQuote(parts)).toBeNull()
  })

  it("ends blocked when the reply held no Ask, for a Referral request and an Introduction", () => {
    for (const kind of ["referral_request", "introduction"] as const) expect(run([F1], kind).result).toMatchObject({ outcome: "blocked", quote: null })
  })

  it("ends blocked when no Statement is left", () => {
    expect(run([REFERRAL_ASK]).result.outcome).toBe("blocked")
  })

  it("removes any Ask from an Application note without calling it a failure", () => {
    const { parts, result } = run([F1, F3, INTRO_ASK], "application_note")
    expect(body(result)).toBe(`${F1.text} ${F3.text}`)
    expect(parts[2]!.removed).toBe("structure")
    expect(firstFailedQuote(parts)).toBeNull()
  })

  it("fills the tokens in the stored body and sentences", () => {
    const { result } = run([F1, ask("Would you be open to referring me for {role_phrase} at {company_phrase}?")])
    if (result.outcome !== "ready") throw new Error("expected ready")
    expect(result.ready.body.endsWith("referring me for the Senior Frontend Engineer role at Northwind Labs?")).toBe(true)
    expect(result.ready.sentences.at(-1)?.text).toBe("Would you be open to referring me for the Senior Frontend Engineer role at Northwind Labs?")
    expect(result.ready.sentences.every((sentence) => !sentence.text.includes("{"))).toBe(true)
  })

  it("records the version and no field for a dropped sentence", () => {
    const { result } = run([F1, statement("I built it in Angular.", "F1"), REFERRAL_ASK])
    if (result.outcome !== "ready") throw new Error("expected ready")
    expect(Object.keys(result.ready).sort()).toEqual(["body", "profileVersion", "sentences"])
    expect(result.ready.profileVersion).toBe(1)
  })
})

describe("budget arithmetic: code points, whole Statements from the end (D6)", () => {
  const finishPipelineOf = (parts: Part[], kind: OutreachKind = "referral_request") => finishPipeline(parts, kind, TARGET, 1)
  const part = (position: number, kind: "statement" | "ask", length: number, overrides: Partial<Part> = {}): Part => {
    const text = "a".repeat(length)
    return { position, original: text, kind, factIds: ["F1"], text, checkText: text, judgeText: text, removed: null, needsJudge: false, ...overrides }
  }

  it.each(OUTREACH_KINDS)("reserves exactly the greeting for %s: body plus reserve equals the total", (kind) => {
    expect(OUTREACH_BUDGETS[kind].body + OUTREACH_GREETING_RESERVE).toBe(OUTREACH_BUDGETS[kind].total)
  })

  it.each(OUTREACH_KINDS)("composes the longest allowed name with a body at its exact budget inside the total for %s", (kind) => {
    // Astral letters: 40 code points and 80 UTF-16 units, so a unit count would refuse a legal name.
    const name = "\u{1D49C}".repeat(READER_NAME_MAX)
    const body = "\u{1D49C}".repeat(OUTREACH_BUDGETS[kind].body)
    const text = composeOutreachText({ kind, readerName: name, body })
    expect(outreachLength(name)).toBe(40)
    expect(name.length).toBe(80)
    // "Hi " + 40 + "," + a blank line (two line breaks) is the 46 the reserve of 50 was sized for.
    expect(outreachLength(text)).toBe(46 + OUTREACH_BUDGETS[kind].body)
    expect(outreachLength(text)).toBeLessThanOrEqual(OUTREACH_BUDGETS[kind].total)
  })

  it("measures in code points: 550 astral characters fit a Referral request body, 551 do not", () => {
    const astral = (length: number) => "\u{1D49C}".repeat(length)
    const fits = finishPipelineOf([part(0, "statement", 1, { text: astral(300), checkText: "", original: "" }), part(1, "ask", 1, { text: astral(249), checkText: "", original: "" })])
    expect(fits.outcome).toBe("ready")
    const over = finishPipelineOf([part(0, "statement", 1, { text: astral(300), checkText: "", original: "" }), part(1, "ask", 1, { text: astral(250), checkText: "", original: "" })])
    expect(over.outcome).toBe("over_budget")
  })

  it("passes a body of exactly the budget and drops a Statement at one more", () => {
    const exact = finishPipelineOf([part(0, "statement", 200), part(1, "statement", 200), part(2, "ask", 148)])
    expect(exact.outcome).toBe("ready")
    if (exact.outcome === "ready") expect(exact.bodyChars).toBe(550)
    const over = finishPipelineOf([part(0, "statement", 200), part(1, "statement", 200), part(2, "ask", 149)])
    expect(over.outcome).toBe("ready")
    if (over.outcome === "ready") {
      expect(over.parts.map((entry) => entry.kind)).toEqual(["statement", "ask"])
      expect(over.bodyChars).toBe(350)
    }
  })

  it("removes whole Statements from the end, never the first Statement and never the Ask", () => {
    const first = part(0, "statement", 100)
    const middle = part(1, "statement", 150)
    const last = part(2, "statement", 150)
    const askPart = part(3, "ask", 200)
    const result = finishPipelineOf([first, middle, last, askPart])
    expect(result.outcome).toBe("ready")
    expect(last.removed).toBe("budget")
    expect(middle.removed).toBeNull()
    expect(first.removed).toBeNull()
    expect(askPart.removed).toBeNull()
    expect(firstFailedQuote([first, middle, last, askPart])).toBeNull()
    // The sentences that stay are unchanged: nothing was cut, abbreviated or reordered.
    if (result.outcome === "ready") expect(result.ready.body).toBe(`${first.text} ${middle.text} ${askPart.text}`)
  })

  it("drops one Statement at a time and stops as soon as the body fits", () => {
    const parts = [part(0, "statement", 120), part(1, "statement", 120), part(2, "statement", 120), part(3, "statement", 120), part(4, "ask", 100)]
    const result = finishPipelineOf(parts)
    expect(result.outcome).toBe("ready")
    expect(parts.map((entry) => entry.removed)).toEqual([null, null, null, "budget", null])
  })

  it("ends over_budget when the first Statement and the Ask alone are too long, and stores nothing", () => {
    const result = finishPipelineOf([part(0, "statement", 500), part(1, "ask", 200)])
    expect(result.outcome).toBe("over_budget")
    expect(JSON.stringify(result)).not.toContain("ready")
  })

  it("an Application note with two Statements drops the second at 451 and keeps one at 450", () => {
    expect(finishPipelineOf([part(0, "statement", 450)], "application_note").outcome).toBe("ready")
    const parts = [part(0, "statement", 300), part(1, "statement", 200)]
    const result = finishPipelineOf(parts, "application_note")
    expect(result.outcome).toBe("ready")
    expect(parts[1]!.removed).toBe("budget")
  })

  it("retries once with the fallback phrases when a long title pushes the body over in every named form", () => {
    const title = "Senior Frontend Engineer, Design Systems and Platform Reliability Group for Merchant Experiences"
    const target = { company: "Northwind Labs", roleTitle: title }
    const filler = "a".repeat(300)
    const named = `Would you refer me for {role_phrase} at {company_phrase}?`
    const make = () => [
      part(0, "statement", 1, { text: filler, original: filler, checkText: filler }),
      part(1, "ask", 1, { text: `${named} ${"b".repeat(190)}`, original: "x", checkText: "x" }),
    ]
    // Named form: 300 + 1 + "Would you refer me for the <title> role at Northwind Labs?" + 191 is over 550.
    const result = finishPipeline(make(), "referral_request", target, 7)
    expect(result.outcome).toBe("ready")
    if (result.outcome !== "ready") return
    expect(result.namesFallback).toBe(true)
    expect(result.ready.body).toContain("for the role at the company?")
    expect(result.ready.body).not.toContain(title)
    expect(result.ready.body).not.toContain("Design Systems")
    expect(outreachLength(result.ready.body)).toBeLessThanOrEqual(550)
  })

  it("never shortens a title: a usable title that fits is written in full", () => {
    const result = finishPipelineOf([part(0, "statement", 50, { text: "I built it.", original: "I built it." }), part(1, "ask", 1, { text: "Refer me for {role_phrase}?", original: "x" })])
    if (result.outcome !== "ready") throw new Error("expected ready")
    expect(result.namesFallback).toBe(false)
    expect(result.ready.body).toBe("I built it. Refer me for the Senior Frontend Engineer role?")
  })
})
