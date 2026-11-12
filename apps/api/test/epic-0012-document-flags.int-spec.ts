/**
 * EPIC-0012 Revision 2 addendum (Part B and D): the two tailoring flags at the service level. With the
 * flags on, the generation request carries A2 and A4 and the evidence block, and the count-only logs are
 * emitted. With them off, no gated line, no <company_direction> block and no direction log, even when the
 * posting stores verified quotes. The FakeAnthropic double stands in for the model.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Logger, type INestApplication } from "@nestjs/common"
import { createApplicationResponseSchema } from "@eve/contracts"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { anthropicConfig } from "../src/config/env.js"
import { BRIDGES_LINE, DIRECTION_LINE } from "../src/documents/document-generation.js"
import { DocumentsService } from "../src/documents/documents.service.js"
import type { CoverLetterContent, ResumeContent } from "../src/documents/document-model.js"
import { Browser } from "./support/browser.js"
import { insertPostingFor, targetEveryFamily } from "./support/candidate-posting.js"
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

const WIND = "6f1c0e8a-1111-4a6b-9a01-00000000b001"
const PAY = "6f1c0e8a-2222-4a6b-9a01-00000000b002"
const PROFILE = [
  {
    id: "s1",
    kind: "experience",
    title: "Platform Analyst",
    organization: "Northwind Energy",
    period: "2021–2024",
    sourceQuote: null,
    facts: [
      { id: WIND, text: "Built wind farm financial models in Excel for offshore projects, forecasting revenue and cost", sourceQuote: null },
      { id: PAY, text: "Supported the payments migration", sourceQuote: null },
    ],
  },
]
const QUOTE = "Our aim is to halve operational emissions by 2030"
const POSTING_TEXT = `Platform Analyst at Verdant. We build offshore wind farm models in renewable energy. ${QUOTE}. Carbon accounting matters.`

const SUMMARY = "Built wind farm financial models in Excel for offshore projects, forecasting revenue and cost in renewable energy."
const HARD_FAIL_LINE = "Led the payments migration."
const DIRECTION_PARAGRAPH = `Your plan to “halve operational emissions by 2030” is clear. I built wind farm financial models in Excel for offshore projects, forecasting revenue and cost.`
const FACT_PARAGRAPH = "I supported the payments migration."

const REPLY = {
  resume: {
    summary: [{ text: SUMMARY, factIds: ["F1"] }],
    experience: [
      {
        heading: { text: "Platform Analyst, Northwind Energy, 2021–2024", factIds: ["F1", "F2"] },
        bullets: [
          { text: HARD_FAIL_LINE, factIds: ["F2"] },
          { text: "Built wind farm financial models in Excel for offshore projects, forecasting revenue and cost.", factIds: ["F1"] },
        ],
      },
    ],
    skills: [{ text: "Excel", factIds: ["F1"] }],
    education: [],
  },
  coverLetter: {
    paragraphs: [
      { text: DIRECTION_PARAGRAPH, factIds: ["F1"] },
      { text: FACT_PARAGRAPH, factIds: ["F2"] },
    ],
  },
}

const SUPPORTS_ALL = { results: Array.from({ length: 200 }, (_, id) => ({ id, supported: true })) }
const supportAll = () => anthropic.replyWithObject(SUPPORTS_ALL)

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), "ja-flags-0012-"))
  markStorageMigratedSync(join(storage, "candidates"))
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  anthropic = new FakeAnthropic(google.server)
  app = await createTestApp({
    databaseUrl: database.url,
    clock,
    config: {
      candidateStorageDir: join(storage, "candidates"),
      anthropic: anthropicConfig(TEST_ANTHROPIC_KEY, TEST_ANTHROPIC_MODEL, "claude-sonnet-5-5"),
      documentBridgesEnabled: true,
      documentDirectionEnabled: true,
    },
  })
  browser = new Browser(app, google)
  candidate = await signInCandidate(browser)
  await approveProfile()
  await database.db
    .insertInto("job_criteria")
    .values({ candidate_id: database.operatorId, min_core_match_percent: 70 })
    .onConflict((conflict) => conflict.column("candidate_id").doNothing())
    .execute()
  await targetEveryFamily(database.db, database.operatorId)
})

beforeEach(async () => {
  await app.get(DocumentsService).settled()
  anthropic.install()
  anthropic.reset()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
  await rm(storage, { recursive: true, force: true })
})

async function approveProfile(): Promise<void> {
  await candidate.post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(200)
  await database.db
    .insertInto("career_profile_version")
    .values({ candidate_id: database.operatorId, version: 1, status: "approved", source: "edit", resume_upload_id: null, sections: JSON.stringify(PROFILE), created_at: new Date(), approved_at: new Date() })
    .execute()
  await candidate.put("/v1/candidate-settings/contact").send({ fullName: "Ada Okafor", lines: ["Lagos, Nigeria"] }).expect(200)
}

async function rankedPosting(id = crypto.randomUUID()): Promise<string> {
  await insertPostingFor(database.db, database.operatorId, {
    id,
    application_url: `https://boards.greenhouse.io/verdant/jobs/${id.slice(0, 8)}`,
    requisition_id: `R-${id.slice(0, 8)}`,
    apply_url: `https://boards.greenhouse.io/verdant/jobs/${id.slice(0, 8)}`,
    application_system: "Greenhouse",
    apply_mode: "automatic",
    origin: "employer_board",
    employer_board_id: null,
    remote_board_key: null,
    attribution_name: null,
    attribution_url: null,
    title: "Energy Analyst",
    company: "Verdant",
    posting_text: POSTING_TEXT,
    status: "ranked",
    skip_reason: null,
    skip_detail: null,
    evaluation_failure: null,
    role_family: "data_ml",
    discovered_at: new Date(),
    evaluated_at: new Date(),
    technologies: JSON.stringify([{ name: "Excel" }]),
  })
  await database.db.updateTable("job_posting").set({ forward_statements: JSON.stringify([QUOTE]) }).where("id", "=", id).execute()
  return id
}

async function generate(user: SignedInCandidate, postingId: string): Promise<string> {
  const response = await user.post("/v1/applications").send({ jobPostingId: postingId })
  if (response.status !== 201) throw new Error(`create application ${response.status}: ${JSON.stringify(response.body)}`)
  const application = createApplicationResponseSchema.parse(response.body).application
  await user.post(`/v1/applications/${application.id}/documents/generate`).expect(202)
  await app.get(DocumentsService).settled()
  return application.id
}

async function stored(applicationId: string, kind: "resume" | "cover_letter") {
  const row = await database.db.selectFrom("tailored_document").select("content").where("application_id", "=", applicationId).where("kind", "=", kind).executeTakeFirstOrThrow()
  return row.content
}

/** Captures every Logger line for one test. */
function captureLogs(): string[] {
  const lines: string[] = []
  for (const level of ["log", "warn", "error", "debug", "verbose"] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
      lines.push(typeof message === "string" ? message : JSON.stringify(message))
    })
  }
  return lines
}

const events = (lines: readonly string[], event: string) => lines.map((line) => {
  try {
    return JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
}).filter((parsed): parsed is Record<string, unknown> => parsed !== null && parsed.event === event)

/** The system prompt text of a recorded request: a string, or Anthropic's list of text blocks. */
function systemText(system: unknown): string {
  if (typeof system === "string") return system
  if (!Array.isArray(system)) return ""
  return system
    .map((block: unknown) => (typeof block === "object" && block !== null && "text" in block ? String((block as { text: unknown }).text) : ""))
    .join("\n")
}

describe("EPIC-0012 flags on: prompts, direction use and count-only logs", () => {
  it("sends A2 and A4 and the direction block, then logs direction_used and hard_fail without line text", async () => {
    const postingId = await rankedPosting()
    anthropic.replyWithObject(REPLY)
    supportAll()
    const lines = captureLogs()
    const applicationId = await generate(candidate, postingId)
    expect(anthropic.requests.length).toBeGreaterThanOrEqual(2)

    // Part B, flags on: the system prompt is the both-on form, and the block and line are sent.
    const system = systemText(anthropic.requests[0]!.body.system)
    expect(system).toContain(BRIDGES_LINE)
    expect(system).toContain(DIRECTION_LINE)
    const generation = FakeAnthropic.promptOf(anthropic.requests[0]!)
    expect(generation).toContain("<company_direction>")
    expect(generation).toContain("halve operational emissions by 2030")
    // The judge sees the posting-terms block: bridges are on.
    const judge = FakeAnthropic.promptOf(anthropic.requests[1]!)
    expect(judge).toContain("<posting_terms>")

    // The direction sentence and its fact sentence both stay; the support-inflation draft line falls back.
    const letter = (await stored(applicationId, "cover_letter")) as CoverLetterContent
    expect(letter.paragraphs[0]?.text).toBe(DIRECTION_PARAGRAPH)
    const resume = (await stored(applicationId, "resume")) as ResumeContent
    expect(resume.experience[0]?.bullets.map((bullet) => bullet.text)).toContain("Supported the payments migration")

    // Part C: counts only.
    const [direction] = events(lines, "documents.direction_used")
    expect(direction).toMatchObject({ applicationId, offered: 1, used: 1, judgedSupported: true, orphan: 0 })
    const [hardFail] = events(lines, "documents.hard_fail")
    expect(hardFail).toMatchObject({ applicationId, reasons: { support_inflation: 1 } })
    expect(hardFail?.total).toBeGreaterThanOrEqual(1)
    const [checked] = events(lines, "documents.meaning_checked")
    expect(checked).toMatchObject({ applicationId, refused: 0 })
    expect(checked?.postingTermLines).toBeGreaterThanOrEqual(1)
    expect(checked?.postingTermSupported).toBe(checked?.postingTermLines)

    // No log line carries a fixture phrase, fact or posting word.
    const all = lines.join("\n")
    for (const phrase of ["halve operational emissions", "Supported the payments migration", "wind farm financial models", "renewable energy", "Excel", "Verdant", "Carbon accounting"]) {
      expect(all).not.toContain(phrase)
    }
  }, 60_000)
})

describe("EPIC-0012 R14 fix: a judged paragraph the keyword cap trims keeps its verdict", () => {
  it("stores the trimmed paragraph and does not block the letter", async () => {
    const postingId = await rankedPosting()
    const CAPPED = "I built Excel models for wind farm projects. I forecast revenue in Excel. I forecast cost in Excel. I built Excel models for offshore projects."
    anthropic.replyWithObject({ ...REPLY, coverLetter: { paragraphs: [{ text: CAPPED, factIds: ["F1"] }, { text: FACT_PARAGRAPH, factIds: ["F2"] }] } })
    supportAll()
    const applicationId = await generate(candidate, postingId)
    const detail = (await database.db.selectFrom("application").select("state").where("id", "=", applicationId).executeTakeFirstOrThrow()).state
    expect(detail).toBe("documents_ready")
    const letter = (await stored(applicationId, "cover_letter")) as CoverLetterContent
    const first = letter.paragraphs[0]?.text ?? ""
    expect((first.match(/Excel/g) ?? []).length).toBeLessThanOrEqual(3)
    expect(first).toContain("I built Excel models for wind farm projects.")
    expect(first).not.toContain("offshore projects.")
  }, 60_000)
})

describe("EPIC-0012 flags off: the gated prompt lines, blocks and log are absent", () => {
  it("a second app built with both flags off sends neither gated line and no direction block", async () => {
    const offApp = await createTestApp({
      databaseUrl: database.url,
      clock,
      config: {
        candidateStorageDir: join(storage, "candidates"),
        anthropic: anthropicConfig(TEST_ANTHROPIC_KEY, TEST_ANTHROPIC_MODEL, "claude-sonnet-5-5"),
        documentBridgesEnabled: false,
        documentDirectionEnabled: false,
      },
    })
    try {
      const offBrowser = new Browser(offApp, google)
      const offCandidate = await signInCandidate(offBrowser)
      anthropic.install()
      anthropic.reset()
      const postingId = await rankedPosting()
      anthropic.replyWithObject(REPLY)
      supportAll()
      const lines = captureLogs()
      const application = createApplicationResponseSchema.parse((await offCandidate.post("/v1/applications").send({ jobPostingId: postingId })).body).application
      await offCandidate.post(`/v1/applications/${application.id}/documents/generate`).expect(202)
      await offApp.get(DocumentsService).settled()
      expect(anthropic.requests.length).toBeGreaterThanOrEqual(2)

      const system = systemText(anthropic.requests[0]!.body.system)
      expect(system).not.toContain(BRIDGES_LINE)
      expect(system).not.toContain(DIRECTION_LINE)
      expect(system).not.toContain("Name the field")
      expect(system).not.toContain("direction sentence")
      // The verifying quotes are stored on the posting, but neither reaches the prompt.
      const generation = FakeAnthropic.promptOf(anthropic.requests[0]!)
      expect(generation).not.toContain("<company_direction>")
      // Bridges off: the judge prompt has no posting_terms block either.
      expect(FakeAnthropic.promptOf(anthropic.requests[1]!)).not.toContain("<posting_terms>")
      expect(events(lines, "documents.direction_used")).toEqual([])
      // The quote sentence is not stripped with direction off, so it drops and only the fact sentence stays.
      const letter = (await stored(application.id, "cover_letter")) as CoverLetterContent
      expect(letter.paragraphs.map((paragraph) => paragraph.text)).not.toContain(DIRECTION_PARAGRAPH)
      expect(letter.paragraphs.map((paragraph) => paragraph.text)).toContain("I built wind farm financial models in Excel for offshore projects, forecasting revenue and cost.")
    } finally {
      await offApp.close()
    }
  }, 60_000)
})
