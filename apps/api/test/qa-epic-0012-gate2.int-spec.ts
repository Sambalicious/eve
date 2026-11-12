/**
 * EPIC-0012 QA gate 2 (step 6a after repair wave 1), independent QA session: end-to-end reproductions of
 * two bypasses still open after Revision 1, through the real API, service, database and renderer. The model
 * is the FakeAnthropic double, so live-model behaviour is NOT tested.
 *
 * REPRO tests: they assert what the candidate does today (the defect). They are BLOCKER QA2-B1a and QA2-B4
 * in epics/active/EPIC-0012-tailoring-rules/test-plan.r2.md. When the fix lands they go red and must be
 * inverted to assert that the line is refused.
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

const SUPPORTED = "6f1c0e8a-1111-4a6b-9a01-00000000b001"
const WIND = "6f1c0e8a-2222-4a6b-9a01-00000000b002"
/** Synthetic profile: the Candidate supported a migration at an employer named "Lead Bank". No real data. */
const PROFILE = [
  {
    id: "s1",
    kind: "experience",
    title: "Platform Analyst",
    organization: "Lead Bank",
    period: "2021–2024",
    sourceQuote: null,
    facts: [
      { id: SUPPORTED, text: "Supported the payments migration", sourceQuote: null },
      { id: WIND, text: "Built wind farm financial models for offshore projects, forecasting revenue and cost", sourceQuote: null },
    ],
  },
]
const QUOTE = "Our aim is to halve operational emissions by 2030"
const LED_LINE = "Led the payments migration."
const GOAL_MET = "Your plan to “halve operational emissions by 2030” is clear. That target was met by these wind farm financial models built for offshore projects."

const REPLY = {
  resume: {
    summary: [{ text: "Built wind farm financial models for offshore projects.", factIds: ["F2"] }],
    experience: [
      {
        heading: { text: "Platform Analyst, Lead Bank, 2021–2024", factIds: ["F1", "F2"] },
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
      { text: GOAL_MET, factIds: ["F2"] },
      { text: "I built wind farm financial models for offshore projects, forecasting revenue and cost.", factIds: ["F2"] },
    ],
  },
}

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), "ja-qa2-0012-"))
  markStorageMigratedSync(join(storage, "candidates"))
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  anthropic = new FakeAnthropic(google.server)
  app = await createTestApp({
    databaseUrl: database.url,
    clock,
    config: { candidateStorageDir: join(storage, "candidates"), anthropic: anthropicConfig(TEST_ANTHROPIC_KEY, TEST_ANTHROPIC_MODEL, "claude-sonnet-5-5"), documentDirectionEnabled: true },
  })
  browser = new Browser(app, google)
  candidate = await signInCandidate(browser)
})

beforeEach(async () => {
  await app.get(DocumentsService).settled()
  anthropic.install()
  anthropic.reset()
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

describe("QA EPIC-0012 gate 2: bypasses fixed in Revision 2, end to end (fake model)", () => {
  it("QA2-B1a and QA2-B4: 'Led' backed only by the employer name 'Lead Bank' reaches the judge, and the goal-as-met sentence is not stored", async () => {
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
    // Revision 2: the generation call is followed by one meaning-check call. No judge reply is queued, so
    // the check fails closed and the reworded lines fall back or drop.
    expect(anthropic.requests).toHaveLength(2)
    // The "Led" line is support-role inflation (R8) and the goal-as-met line holds a completion word (R11):
    // both are hard fails in code, so neither reaches the judge. The direction flag is on for this app.
    expect(FakeAnthropic.promptOf(anthropic.requests[1]!)).not.toContain(GOAL_MET)
    expect(FakeAnthropic.promptOf(anthropic.requests[1]!)).not.toContain(LED_LINE)
    const resume = (await stored(application.id, "resume")) as ResumeContent
    const letter = (await stored(application.id, "cover_letter")) as CoverLetterContent
    // Fixed QA2-B1a: "Supported" may not become "Led" just because the employer is named "Lead Bank".
    expect(resume.experience[0]?.bullets.map((bullet) => bullet.text)).not.toContain(LED_LINE)
    // Fixed QA2-B4: the goal-as-met sentence is not stored (R11: a completion word outside the quote is a hard fail).
    expect(letter.paragraphs.map((paragraph) => paragraph.text)).not.toContain(GOAL_MET)
  })

  it("R16: a failed judge call on a letter that blocks only on never-judged lines is a retryable provider_error", async () => {
    await candidate.post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(200)
    await database.db
      .insertInto("career_profile_version")
      .values({ candidate_id: database.operatorId, version: 1, status: "approved", source: "edit", resume_upload_id: null, sections: JSON.stringify([{ id: "s1", kind: "experience", title: "Platform Analyst", organization: "Verdant", period: "2021–2024", sourceQuote: null, facts: [{ id: SUPPORTED, text: "Mentored 6 junior developers", sourceQuote: null }] }]), created_at: new Date(), approved_at: new Date() })
      .execute()
    await candidate.put("/v1/candidate-settings/contact").send({ fullName: "Ada Okafor", lines: ["Lagos, Nigeria", "ada@example.com"] }).expect(200)
    const id = crypto.randomUUID()
    await insertPostingFor(database.db, database.operatorId, {
      id,
      application_url: "https://boards.greenhouse.io/verdant/jobs/2",
      requisition_id: "R-verdant-2",
      apply_url: "https://boards.greenhouse.io/verdant/jobs/2",
      application_system: "Greenhouse",
      apply_mode: "automatic",
      origin: "employer_board",
      employer_board_id: null,
      remote_board_key: null,
      attribution_name: null,
      attribution_url: null,
      title: "Energy Analyst",
      company: "Verdant",
      posting_text: "Energy Analyst at Verdant. Remote. Build energy models.",
      status: "ranked",
      skip_reason: null,
      skip_detail: null,
      evaluation_failure: null,
      role_family: "senior_frontend",
      discovered_at: new Date(),
      evaluated_at: new Date(),
    })
    const REWORDED = "Mentored 6 junior developers through weekly pairing."
    anthropic.replyWithObject({
      resume: {
        summary: [],
        experience: [
          {
            heading: { text: "Platform Analyst, Verdant, 2021–2024", factIds: ["F1"] },
            bullets: [{ text: "Mentored 6 junior developers", factIds: ["F1"] }],
          },
        ],
        skills: [],
        education: [],
      },
      coverLetter: { paragraphs: [{ text: REWORDED, factIds: ["F1"] }] },
    })
    // The judge call fails, so the reworded letter line was never judged and the letter would block on it.
    anthropic.replyWithStatus(529)

    const application = createApplicationResponseSchema.parse((await candidate.post("/v1/applications").send({ jobPostingId: id })).body).application
    await candidate.post(`/v1/applications/${application.id}/documents/generate`).expect(202)
    await app.get(DocumentsService).settled()
    const detail = applicationDetailSchema.parse((await candidate.get(`/v1/applications/${application.id}`).expect(200)).body)

    expect(detail).toMatchObject({ state: "documents_failed", failure: "provider_error", blockedDocument: null })
    expect(await database.db.selectFrom("tailored_document").select("kind").where("application_id", "=", application.id).execute()).toHaveLength(0)
  })
})
