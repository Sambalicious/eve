/**
 * EPIC-0012 QA gate (step 6a), independent QA session: end-to-end reproductions of two truth-guard
 * bypasses through the real API, service, database and renderer. The model is the FakeAnthropic double;
 * no real model is called, so whether the live model would write these lines is NOT tested here.
 *
 * These reproductions assert what the candidate does. Both are fixed in design Revision 1: QA-B1's
 * scope verb now reaches the meaning check and the line falls back to its fact's wording (R1), and QA-B4's
 * goal-as-met sentence keeps no frame words after the span, so it fails in code and is dropped (R4).
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { INestApplication } from "@nestjs/common"
import { applicationDetailSchema, createApplicationResponseSchema } from "@eve/contracts"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

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

const LED_BY = "6f1c0e8a-1111-4a6b-9a01-00000000a001"
const WIND = "6f1c0e8a-2222-4a6b-9a01-00000000a002"
/** Synthetic profile: the Candidate supported a migration someone else led. No real data. */
const PROFILE = [
  {
    id: "s1",
    kind: "experience",
    title: "Platform Analyst",
    organization: "Northwind Energy",
    period: "2021–2024",
    sourceQuote: null,
    facts: [
      { id: LED_BY, text: "Supported a payments migration led by the platform team", sourceQuote: null },
      { id: WIND, text: "Built wind farm financial models for offshore projects, forecasting revenue and cost", sourceQuote: null },
    ],
  },
]
const QUOTE = "Our aim is to halve operational emissions by 2030"
const LED_LINE = "Led a payments migration."
const GOAL_AS_DONE = "Your plan to “halve operational emissions by 2030” was met by these wind farm financial models built for offshore projects."

const REPLY = {
  resume: {
    summary: [{ text: "Built wind farm financial models for offshore projects.", factIds: ["F2"] }],
    experience: [
      {
        heading: { text: "Platform Analyst, Northwind Energy, 2021–2024", factIds: ["F1", "F2"] },
        bullets: [
          { text: LED_LINE, factIds: ["F1"] },
          { text: "Built wind farm financial models for offshore projects, forecasting revenue and cost.", factIds: ["F2"] },
        ],
      },
    ],
    skills: [],
    education: [],
  },
  coverLetter: {
    paragraphs: [
      { text: GOAL_AS_DONE, factIds: ["F2"] },
      { text: "I built wind farm financial models for offshore projects, forecasting revenue and cost.", factIds: ["F2"] },
    ],
  },
}

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), "ja-qa-0012-"))
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
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
  await rm(storage, { recursive: true, force: true })
})

async function stored(applicationId: string, kind: "resume" | "cover_letter") {
  const row = await database.db.selectFrom("tailored_document").select("content").where("application_id", "=", applicationId).where("kind", "=", kind).executeTakeFirstOrThrow()
  return row.content
}

describe("QA EPIC-0012 truth-guard bypasses, end to end (fake model)", () => {
  it("QA-B1 is refused (the line reaches the meaning check and falls back) and QA-B4 is dropped in code", async () => {
    await candidate.post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(200)
    await database.db
      .insertInto("career_profile_version")
      .values({ candidate_id: database.operatorId, version: 1, status: "approved", source: "edit", resume_upload_id: null, sections: JSON.stringify(PROFILE), created_at: new Date(), approved_at: new Date() })
      .execute()
    await candidate.put("/v1/candidate-settings/contact").send({ fullName: "Ada Okafor", lines: ["Lagos, Nigeria", "ada@example.com"] }).expect(200)
    const id = crypto.randomUUID()
    await insertPostingFor(database.db, database.operatorId, {
      id,
      application_url: "https://boards.greenhouse.io/verdant/jobs/1",
      requisition_id: "R-verdant",
      apply_url: "https://boards.greenhouse.io/verdant/jobs/1",
      application_system: "Greenhouse",
      apply_mode: "automatic",
      origin: "employer_board",
      employer_board_id: null,
      remote_board_key: null,
      attribution_name: null,
      attribution_url: null,
      title: "Energy Analyst",
      company: "Verdant",
      posting_text: `Energy Analyst at Verdant. Remote. ${QUOTE}. Build payments and energy models.`,
      status: "ranked",
      skip_reason: null,
      skip_detail: null,
      evaluation_failure: null,
      role_family: "senior_frontend",
      discovered_at: new Date(),
      evaluated_at: new Date(),
    })
    await database.db.updateTable("job_posting").set({ forward_statements: JSON.stringify([QUOTE]) }).where("id", "=", id).execute()
    anthropic.replyWithObject(REPLY)

    const application = createApplicationResponseSchema.parse((await candidate.post("/v1/applications").send({ jobPostingId: id })).body).application
    await candidate.post(`/v1/applications/${application.id}/documents/generate`).expect(202)
    await app.get(DocumentsService).settled()
    const detail = applicationDetailSchema.parse((await candidate.get(`/v1/applications/${application.id}`).expect(200)).body)

    expect(detail.state).toBe("documents_ready")
    // QA-B1: the model line goes to the meaning check (the second request). QA-B4: the goal-as-met line
    // fails in code on the quote's number, so it is never sent to the judge.
    expect(anthropic.requests).toHaveLength(2)
    // Revision 2, R8: "Led" for "Supported" is support-role inflation, a hard fail in code, so it never
    // reaches the judge. The judge call is for the summary line.
    expect(FakeAnthropic.promptOf(anthropic.requests[1]!)).not.toContain(LED_LINE)
    expect(FakeAnthropic.promptOf(anthropic.requests[1]!)).not.toContain(GOAL_AS_DONE)
    const resume = (await stored(application.id, "resume")) as ResumeContent
    const letter = (await stored(application.id, "cover_letter")) as CoverLetterContent
    // Fixed QA-B1: the Candidate supported the migration, so the line falls back to the fact's own wording.
    const bullets = resume.experience[0]?.bullets.map((bullet) => bullet.text) ?? []
    expect(bullets).not.toContain(LED_LINE)
    expect(bullets).toContain("Supported a payments migration led by the platform team")
    // Fixed QA-B4: the employer's goal is no longer presented as met by the Candidate's models. Its only
    // sentence fails in code (a word outside the span is not a frame word), so the paragraph is dropped.
    expect(letter.paragraphs.map((paragraph) => paragraph.text)).not.toContain(GOAL_AS_DONE)
    expect(letter.paragraphs.map((paragraph) => paragraph.text)).toContain("I built wind farm financial models for offshore projects, forecasting revenue and cost.")
  })
})
