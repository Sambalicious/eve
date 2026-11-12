/**
 * EPIC-0012 QA gate 7 (after owner-approved repair wave 6: R24, default-deny quotation provenance), independent QA
 * session: R24 end to end through the real API, service, database and renderer. The model is the FakeAnthropic
 * double, so live-model behaviour is NOT tested. Test file only; no product code changed. The harness is the gate-4
 * harness, unchanged through gates 5 and 6; only the adversarial draft, the rows and the log word list are new.
 *
 * Convention as in the unit spec: `it.fails` asserts REQUIRED behaviour the candidate does not show (a blocker
 * QA7-Bn in epics/active/EPIC-0012-tailoring-rules/test-plan.r7.md). Flags are set by overwriting the service's
 * private `flags`, as in the gate-3 to gate-6 specs.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Logger, type INestApplication } from "@nestjs/common"
import { applicationDetailSchema, createApplicationResponseSchema } from "@eve/contracts"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { anthropicConfig } from "../src/config/env.js"
import type { CoverLetterContent, ResumeContent } from "../src/documents/document-model.js"
import { DocumentsService } from "../src/documents/documents.service.js"
import { Browser } from "./support/browser.js"
import { insertPostingFor } from "./support/candidate-posting.js"
import { FakeAnthropic } from "./support/fake-anthropic.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_ANTHROPIC_KEY, TEST_ANTHROPIC_MODEL, TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp, markStorageMigratedSync } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

let database: TestDatabase
let google: FakeGoogle
let anthropic: FakeAnthropic
let app: INestApplication
let browser: Browser
let candidate: SignedInCandidate
let storage: string
const clock = new TestClock("2026-11-09T09:00:00.000Z")

const fact = (n: number, text: string) => ({ id: `6f1c0e8a-4444-4a6b-9a01-${String(n).padStart(12, "0")}`, text, sourceQuote: null })
/** Synthetic profile only. Aliases in order: F1 pay, F2 wind, F3 ment, F4 qa, F5-F7 jest tests, F8 two sentences. */
const FACTS = [
  fact(1, "Supported the payments migration"),
  fact(2, "Built wind farm financial models for offshore projects, forecasting revenue and cost"),
  fact(3, "Mentored 6 junior developers"),
  fact(4, "Tested React forms with Jest and ran regression suites"),
  fact(5, "Wrote Jest tests for the checkout"),
  fact(6, "Wrote Jest tests for the cart"),
  fact(7, "Wrote Jest tests for search"),
  fact(8, "Cut report preparation time by 30% using Jest. Trained the finance team"),
]
const profileWithTitle = (title: string) => [{ id: "s1", kind: "experience", title, organization: "Acme Energy", period: "2021–2024", sourceQuote: null, facts: FACTS }]
const PROFILE = profileWithTitle("Platform Analyst")
const POSTING_TEXT = "Energy Analyst at Verdant. Remote. Sustainability consulting firm. We use Workiva daily.\nTableau experience is a plus.\nTools: Snowflake, Power BI and Excel. Carbon accounting matters. We want to double revenue within the decade."
const QUOTE = "Our aim is to halve operational emissions by 2030"
const WIND_SENTENCE = "I built wind farm financial models for offshore projects, forecasting revenue and cost."
const SUPPORTS_ALL = { results: Array.from({ length: 200 }, (_, id) => ({ id, supported: true })) }

type Flags = Readonly<{ bridges: boolean; direction: boolean }>
type Judge = "all" | "fail" | "none"
type Scenario = Readonly<{
  reply: { resume: unknown; coverLetter: unknown }
  judge: Judge
  flags: Flags
  keywords?: readonly string[]
  gaps?: readonly string[]
  title?: string
  profile?: unknown
}>

const logged: string[] = []
let logSpy: ReturnType<typeof vi.spyOn>[] = []

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), "ja-qa7-0012-"))
  markStorageMigratedSync(join(storage, "candidates"))
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  anthropic = new FakeAnthropic(google.server)
  app = await createTestApp({
    databaseUrl: database.url,
    clock,
    config: { candidateStorageDir: join(storage, "candidates"), anthropic: anthropicConfig(TEST_ANTHROPIC_KEY, TEST_ANTHROPIC_MODEL, "claude-sonnet-5-5") },
  })
  browser = new Browser(app, google)
  candidate = await signInCandidate(browser)
})

beforeEach(async () => {
  await app.get(DocumentsService).settled()
  anthropic.install()
  anthropic.reset()
  logged.length = 0
  logSpy = (["log", "warn", "error", "debug", "verbose"] as const).map((level) => vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))))
  await database.db.deleteFrom("tailored_document").execute()
  await database.db.deleteFrom("ai_call").execute()
  await database.db.deleteFrom("application").execute()
  await database.db.deleteFrom("eligibility_result").execute()
  await database.db.deleteFrom("candidate_posting").execute()
  await database.db.deleteFrom("job_posting").execute()
  await database.db.deleteFrom("career_profile_version").execute()
  await database.db.deleteFrom("ai_provider_approval").execute()
  await database.db.updateTable("candidate_contact").set({ full_name: "", lines: "[]" }).execute()
})

afterEach(() => {
  for (const spy of logSpy) spy.mockRestore()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
  await rm(storage, { recursive: true, force: true })
})

function setFlags(flags: Flags) {
  ;(app.get(DocumentsService) as unknown as { flags: Flags }).flags = flags
}

async function stored(applicationId: string, kind: "resume" | "cover_letter") {
  const row = await database.db.selectFrom("tailored_document").select("content").where("application_id", "=", applicationId).where("kind", "=", kind).executeTakeFirst()
  return row?.content
}

async function run(scenario: Scenario) {
  setFlags(scenario.flags)
  await candidate.post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(200)
  await database.db
    .insertInto("career_profile_version")
    .values({ candidate_id: database.operatorId, version: 1, status: "approved", source: "edit", resume_upload_id: null, sections: JSON.stringify(scenario.profile ?? PROFILE), created_at: new Date(), approved_at: new Date() })
    .execute()
  await candidate.put("/v1/candidate-settings/contact").send({ fullName: "Ada Okafor", lines: ["Lagos, Nigeria", "ada@example.com"] }).expect(200)
  const id = crypto.randomUUID()
  await insertPostingFor(database.db, database.operatorId, {
    id,
    application_url: "https://boards.greenhouse.io/verdant/jobs/1",
    requisition_id: `R-${id.slice(0, 8)}`,
    apply_url: "https://boards.greenhouse.io/verdant/jobs/1",
    application_system: "Greenhouse",
    apply_mode: "automatic",
    origin: "employer_board",
    employer_board_id: null,
    remote_board_key: null,
    attribution_name: null,
    attribution_url: null,
    title: scenario.title ?? "Sustainability Consultant",
    company: "Verdant",
    posting_text: POSTING_TEXT,
    status: "ranked",
    skip_reason: null,
    skip_detail: null,
    evaluation_failure: null,
    role_family: "senior_frontend",
    discovered_at: new Date(),
    evaluated_at: new Date(),
  })
  const keywords = scenario.keywords ?? []
  const gaps = scenario.gaps ?? []
  await database.db
    .updateTable("job_posting")
    .set({
      forward_statements: JSON.stringify([QUOTE]),
      technologies: JSON.stringify(keywords.map((name) => ({ name, quote: name }))),
      ats_skills: JSON.stringify(gaps.map((name) => ({ name, quote: name }))),
    })
    .where("id", "=", id)
    .execute()
  anthropic.replyWithObject(scenario.reply)
  if (scenario.judge === "all") anthropic.replyWithObject(SUPPORTS_ALL)
  else if (scenario.judge === "none") anthropic.replyWithObject({ results: Array.from({ length: 200 }, (_, n) => ({ id: n, supported: false })) })
  else anthropic.replyWithStatus(529)
  const application = createApplicationResponseSchema.parse((await candidate.post("/v1/applications").send({ jobPostingId: id })).body).application
  await candidate.post(`/v1/applications/${application.id}/documents/generate`).expect(202)
  await app.get(DocumentsService).settled()
  const detail = applicationDetailSchema.parse((await candidate.get(`/v1/applications/${application.id}`).expect(200)).body)
  const resume = (await stored(application.id, "resume")) as (ResumeContent & { headline?: string | null }) | undefined
  const letter = (await stored(application.id, "cover_letter")) as CoverLetterContent | undefined
  const events = logged.flatMap((entry) => {
    const start = entry.indexOf("{")
    if (start === -1) return []
    try {
      return [JSON.parse(entry.slice(start)) as Record<string, unknown>]
    } catch {
      return []
    }
  })
  const promptOf = (index: number) => (anthropic.requests[index] ? FakeAnthropic.promptOf(anthropic.requests[index]!) : "")
  return { id: application.id, detail, resume, letter, events, promptOf }
}

const lines = (resume: ResumeContent | undefined) => [...(resume?.summary ?? []), ...(resume?.experience.flatMap((e) => e.bullets) ?? []), ...(resume?.skills ?? [])].map((l) => l.text)
const paragraphs = (letter: CoverLetterContent | undefined) => letter?.paragraphs.map((p) => p.text) ?? []
const eventsNamed = (events: readonly Record<string, unknown>[], name: string) => events.filter((e) => e.event === name)
const NO_FLAGS: Flags = { bridges: false, direction: false }
const STATES = [
  ["both flags off", NO_FLAGS],
  ["bridges only", { bridges: true, direction: false }],
  ["direction only", { bridges: false, direction: true }],
  ["both flags on", { bridges: true, direction: true }],
] as const

/** Fresh adversarial draft (gate 7). Every line marked "hard" must never be stored under any flag state. */
const ADVERSARIAL = {
  resume: {
    summary: [
      { text: "Built wind farm financial models, “\u2066the sharpest in Europe\u2069”", factIds: ["F2"] }, // hard: R24 (isolates are marks; unsourced)
      { text: "Mentored 6 junior developers", factIds: ["F3"] },
    ],
    experience: [
      {
        heading: { text: "Platform Analyst, Acme Energy, 2021–2024", factIds: ["F1", "F2", "F3"] },
        bullets: [
          { text: "Built wind farm financial models for offshore projects in Tableau", factIds: ["F2"] }, // hard: R10
          { text: "Mentored 12 junior developers", factIds: ["F3"] }, // hard: number
          { text: "Built wind farm financial models for offshore projects, ＂forecasting revenue\u200b”\u200b and margins", factIds: ["F2"] }, // hard: R24
          { text: "Produced offshore wind farm financial models for projects", factIds: ["F2"] }, // judge only
        ],
      },
    ],
    skills: [],
    education: [],
  },
  coverLetter: {
    paragraphs: [
      { text: `Your plan to ⸌double revenue within the decade⸍ is clear. ${WIND_SENTENCE}`, factIds: ["F2"] }, // hard: R24
      { text: "Your plan to “halve operational emissions by 2030” is clear. My wind farm financial models are exceeding it.", factIds: ["F2"] }, // never stored (2030 / R20)
      { text: "I tested React sign-up forms. I tested React settings forms.", factIds: ["F4"] },
      { text: "I tested React search forms.", factIds: ["F4"] },
      { text: "I tested React export forms with Jest. I ran regression suites.", factIds: ["F4"] }, // cap trims, R8 re-fails, R17 drops
      { text: "I mentored 6 junior developers.", factIds: ["F3"] },
    ],
  },
}
const HARD = ["sharpest", "Tableau", "12 junior", "margins", "double revenue", "exceeding", "I ran regression suites"]
const LISU_FAB = "ꓓꓳꓴꓐꓡꓰ ꓣꓰꓦꓰꓠꓴꓰ ꓪꓲꓔꓧꓲꓠ ꓔꓧꓰ ꓓꓰꓚꓮꓓꓰ"
const FIXTURE_WORDS = ["Workiva", "Tableau", "Snowflake", "Power BI", "Verdant", "payments migration", "wind farm", "halve operational", "double revenue", "sharpest", "margins", "regression suites", "exceeding", "junior developers", "Jest", "React", "ada@example.com", "Okafor", "Acme Energy", "Platform Analyst", "Sustainability Consultant", "Intern", "Zürich", "Zu\u0308rich", LISU_FAB, "ꓓ", "ˡ", "⸌", "＂", "\u2066", "\u200b", "\\u2066", "\\u200b", "\\ua4d3", "\\u02e1", "\\u2e0c"]

function expectCountOnlyLogs(out: { events: readonly Record<string, unknown>[] }, label: string) {
  for (const entry of logged) for (const word of FIXTURE_WORDS) expect(entry, `${label}: log line holds '${word}'`).not.toContain(word)
  for (const event of out.events.filter((e) => String(e.event).startsWith("documents."))) {
    for (const [key, value] of Object.entries(event)) {
      if (key === "event" || key === "applicationId") continue
      expect(JSON.stringify(value), `${label}: ${String(event.event)}.${key}`).toMatch(/^(?:-?\d+(?:\.\d+)?|true|false|null|\{("[a-z_]+":\d+,?)*\}|\[\]|"[a-z_]+")$/)
    }
  }
}

async function clearRun() {
  anthropic.reset()
  logged.length = 0
  await database.db.deleteFrom("tailored_document").execute()
  await database.db.deleteFrom("application").execute()
  await database.db.deleteFrom("career_profile_version").execute()
  await database.db.deleteFrom("candidate_posting").execute()
  await database.db.deleteFrom("job_posting").execute()
}



describe("1. a judge that approves everything, each flag state, end to end (fresh draft)", () => {
  it.each(STATES)("%s: no hard-fail line is stored or judged; logs are counts only", async (_name, flags) => {
    const out = await run({ reply: ADVERSARIAL, judge: "all", flags, keywords: ["React"], gaps: ["carbon accounting"] })
    expect(out.detail.state).toBe("documents_ready")
    const all = [...lines(out.resume), ...paragraphs(out.letter)].join(" | ")
    for (const bad of HARD) expect(all, bad).not.toContain(bad)
    expect(anthropic.requests).toHaveLength(2)
    for (const bad of ["sharpest", "Tableau", "12 junior", "margins", "double revenue"]) expect(out.promptOf(1), bad).not.toContain(bad)
    expect(eventsNamed(out.events, "documents.letter_keyword_cap")[0]).toMatchObject({ dropped: 1, paragraphsDropped: 1, overCap: false })
    const reasons = (eventsNamed(out.events, "documents.hard_fail")[0]?.reasons ?? {}) as Record<string, number>
    expect(reasons.unsourced_quote).toBeGreaterThanOrEqual(3)
    expectCountOnlyLogs(out, _name)
  })

  it("judge down (529) and judge refusing, both flag extremes: hard fails out, resume is fact wording, logs count-only", async () => {
    for (const flags of [NO_FLAGS, { bridges: true, direction: true }] as const) {
      for (const judge of ["fail", "none"] as const) {
        const out = await run({ reply: ADVERSARIAL, judge, flags, keywords: ["React"], gaps: ["carbon accounting"] })
        const all = [...lines(out.resume), ...paragraphs(out.letter)].join(" | ")
        for (const bad of HARD) expect(all, `${judge}: ${bad}`).not.toContain(bad)
        const wordings = new Set(FACTS.map((f) => f.text.toLowerCase()))
        for (const text of lines(out.resume)) expect(wordings.has(text.toLowerCase().replace(/\.$/, "")), text).toBe(true)
        expectCountOnlyLogs(out, judge)
        await clearRun()
      }
    }
  })
})

describe("2. R24 end to end, both flags off, rubber stamp", () => {
  const replyWith = (frame: string, alone = false) => ({
    resume: { summary: [{ text: "Mentored 6 junior developers", factIds: ["F3"] }], experience: [], skills: [], education: [] },
    coverLetter: { paragraphs: [{ text: alone ? frame : `${frame} ${WIND_SENTENCE}`, factIds: ["F2"] }, { text: "I mentored 6 junior developers.", factIds: ["F3"] }] },
  })
  const storedText = async (frame: string, alone = false) => {
    const out = await run({ reply: replyWith(frame, alone), judge: "all", flags: NO_FLAGS })
    expect(out.detail.state).toBe("documents_ready")
    expectCountOnlyLogs(out, frame)
    return paragraphs(out.letter).join(" ")
  }
  it.each([
    ["invisible isolates around the quote", "Your plan to “\u2066double revenue within the decade\u2069” is clear."],
    ["fullwidth straight quotes", "Your plan to ＂double revenue within the decade＂ is clear."],
    ["NFD of the whole sentence", "Your plan to “double revenue within the decade” is clear.".normalize("NFD")],
    ["closer glued through a slash", "Your plan to double revenue within the decade/”“wind farm financial models” is my work."],
    ["opener glued after a bracket", "I built “wind farm financial models” (2021)“double revenue within the decade."],
    ["word joiner between closer and sourced quote", "Your plan to double revenue within the decade.\u2060”“wind farm financial models” is my work."],
    ["tag characters as marks", "Your plan to \u{e0022}double revenue within the decade\u{e0022} is clear."],
  ])("%s: the quote sentence drops, the fact sentence is stored", async (_name, frame) => {
    const text = await storedText(frame)
    expect(text).not.toContain("revenue within the decade")
    expect(text).toContain("I built wind farm financial models")
  })
  it("OBSERVATION (SEC-407, not R24): a C0/C1 control character (VT) in the model's reply fails the whole generation at the schema, so it never reaches the quotation check", async () => {
    const out = await run({ reply: replyWith("Your plan to double revenue within the decade.\u000b”“wind farm financial models” is my work."), judge: "all", flags: NO_FLAGS })
    expect(out.detail.state).toBe("documents_failed")
    expect(out.letter).toBeUndefined()
    expectCountOnlyLogs(out, "vt")
  })
  it("a sentence quoting the cited fact, with contractions, ma'am and a possessive, is stored as written", async () => {
    const frame = "I’m proud the “wind farm financial models” were the team’s, ma'am, and I'd build them again."
    expect(await storedText(frame)).toContain(frame)
  })
  it("QA7-B1 fixed by R25 B and narrowed S0: a quotation spanning sentences, opened and closed in fact-wording sentences, is not stored", async () => {
    const text = await storedText("“Built wind farm financial models for offshore projects. Your plan to double revenue within the decade is clear. Forecasting revenue and cost.”", true)
    expect(text).not.toContain("revenue within the decade")
  })
  it("QA7-B2 fixed by R25 step 2: a quotation in Lisu capitals (drawn as Latin) after the fact wording is not stored", async () => {
    const text = await storedText(`Built wind farm financial models for offshore projects “${LISU_FAB}”.`, true)
    expect(text).not.toContain(LISU_FAB)
  })
  it("QA7-B3 fixed by R25 step 1: a quotation drawn with ˡ (U+02E1, NFKC 'l') marks is not stored", async () => {
    expect(await storedText("Your plan to ˡdouble revenue within the decadeˡ is clear.")).not.toContain("revenue within the decade")
  })
})

describe("3. stored text is never rewritten by normalisation", () => {
  it("an NFD letter sentence and an NFD bullet are stored code point for code point", async () => {
    const profile = [{ id: "s1", kind: "experience", title: "Platform Analyst", organization: "Acme Energy", period: "2021–2024", sourceQuote: null, facts: [...FACTS, fact(9, "Built risk models for Zürich Energy")] }]
    const sentence = "I built “risk models for Zürich Energy” in my role.".normalize("NFD")
    const bullet = "Built risk models for Zürich Energy".normalize("NFD")
    const reply = {
      resume: { summary: [{ text: "Mentored 6 junior developers", factIds: ["F3"] }], experience: [{ heading: { text: "Platform Analyst, Acme Energy, 2021–2024", factIds: ["F9"] }, bullets: [{ text: bullet, factIds: ["F9"] }] }], skills: [], education: [] },
      coverLetter: { paragraphs: [{ text: sentence, factIds: ["F9"] }, { text: "I mentored 6 junior developers.", factIds: ["F3"] }] },
    }
    const out = await run({ reply, judge: "all", flags: NO_FLAGS, profile })
    expect(out.detail.state).toBe("documents_ready")
    expect(paragraphs(out.letter)).toContain(sentence)
    expect(paragraphs(out.letter)).not.toContain(sentence.normalize("NFC"))
    expect(lines(out.resume)).toContain(bullet)
    expectCountOnlyLogs(out, "nfd")
  })
})

describe("4. R21 headline end to end (fresh, regression)", () => {
  const reply = {
    resume: { summary: [{ text: "Mentored 6 junior developers", factIds: ["F3"] }], experience: [], skills: [], education: [] },
    coverLetter: { paragraphs: [{ text: "I mentored 6 junior developers.", factIds: ["F3"] }] },
  }
  it.each([["Sustainability Consultant Intern"], ["Junior Sustainability Consultant"], ["Sustainability Consultant (Secondment)"]])("'%s' prints no headline", async (title) => {
    const out = await run({ reply, judge: "all", flags: NO_FLAGS, title: "Sustainability Consultant", profile: profileWithTitle(title) })
    expect(out.detail.state).toBe("documents_ready")
    expect(out.resume?.headline ?? null).toBeNull()
    expectCountOnlyLogs(out, title)
  })
  it("'Principal Sustainability Consultant' prints the posting title", async () => {
    const out = await run({ reply, judge: "all", flags: NO_FLAGS, title: "Sustainability Consultant", profile: profileWithTitle("Principal Sustainability Consultant") })
    expect(out.resume?.headline).toBe("Sustainability Consultant")
  })
})
