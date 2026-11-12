import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { INestApplication, INestApplicationContext } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { sampleResultSchema, submissionSchema, submissionStatusSchema } from "@eve/contracts"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { anthropicConfig } from "../src/config/env.js"
import { CLOCK } from "../src/shared/clock.js"
import { FORM_SESSION_FACTORY, unavailableFormSessions } from "../src/submission/form-session.js"
import { SubmissionJobs } from "../src/worker/submission-jobs.js"
import { WorkerHeartbeat } from "../src/worker/worker-heartbeat.js"
import { WorkerModule } from "../src/worker/worker.module.js"
import { Browser } from "./support/browser.js"
import { QUESTION_SCHEMAS } from "../src/submission/question-schema.js"
import { FakeAtsForms, STANDARD_FORM } from "./support/fake-ats-form.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp, markStorageMigratedSync } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"
import { insertEligibilityFor, insertPostingFor } from "./support/candidate-posting.js"

/**
 * F-QA5-01: the deployed wiring. The api has no browser (`unavailableFormSessions`,
 * as in the api process); approving a sample hands it to the worker's
 * `submission.sample` job, and the worker submits it through SubmissionService
 * with its own FormSession (here the in-process fake ATS form).
 */
let database: TestDatabase
let google: FakeGoogle
let api: INestApplication
let worker: INestApplicationContext
let candidate: SignedInCandidate
let storage: string
const forms = new FakeAtsForms()
const clock = new TestClock("2026-10-20T09:00:00.000Z")
const APPLY_HOST = "boards.greenhouse.io"

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), "ja-handoff-int-"))
  markStorageMigratedSync(storage)
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  api = await createTestApp({ databaseUrl: database.url, clock, config: { candidateStorageDir: storage }, formSessions: unavailableFormSessions })
  candidate = await signInCandidate(new Browser(api, google))
  const moduleRef = await Test.createTestingModule({
    imports: [WorkerModule.forRoot({ databaseUrl: database.url, anthropic: anthropicConfig(undefined, "claude-haiku-5-5"), candidateStorageDir: storage })],
  })
    .overrideProvider(WorkerHeartbeat)
    .useValue({ onApplicationBootstrap: () => undefined, onApplicationShutdown: () => undefined })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .overrideProvider(FORM_SESSION_FACTORY)
    .useValue(forms)
    .overrideProvider(QUESTION_SCHEMAS)
    .useValue(forms.questionSchemas)
    .compile()
  worker = moduleRef
  await worker.init()
})

beforeEach(async () => {
  for (const table of ["notification_outbox", "submission_event", "tailored_document", "application", "candidate_posting", "job_posting", "career_profile_version"] as const) {
    await database.db.deleteFrom(table).execute()
  }
  await database.db.updateTable("activation_state").set({ gate_passed_at: null, automatic_enabled: false, existing_applications_completed_at: null }).execute()
  await database.db.updateTable("control_state").set({ global_paused: false, cost_paused: false }).execute()
  await database.db.updateTable("candidate_contact").set({ full_name: "Ada Okafor", lines: JSON.stringify(["Lagos, Nigeria", "ada@example.com", "+234 800 000 0000"]) }).execute()
  forms.use({ host: APPLY_HOST, controls: STANDARD_FORM })
})

afterAll(async () => {
  await worker?.close()
  await api?.close()
  google?.close()
  await database?.stop()
  await rm(storage, { recursive: true, force: true })
})

async function sample(company: string): Promise<string> {
  const postingId = randomUUID()
  const id = randomUUID()
  const url = `https://${APPLY_HOST}/${company.toLowerCase().replace(/\W+/g, "")}/jobs/R-${id.slice(0, 6)}`
  await insertPostingFor(database.db, database.operatorId, { id: postingId, application_url: url, requisition_id: `R-${id.slice(0, 6)}`, apply_url: url, application_system: "greenhouse", apply_mode: "automatic", origin: "employer_board", employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null, title: "Senior Frontend Engineer", company, posting_text: "Remote, open to candidates in Nigeria.", status: "ranked", skip_reason: null, skip_detail: null, evaluation_failure: null, role_family: "senior_frontend", discovered_at: new Date(), evaluated_at: new Date() })
  await insertEligibilityFor(database.db, database.operatorId, postingId)
  await database.db
    .insertInto("application")
    .values({ candidate_id: database.operatorId, id, job_posting_id: postingId, application_url: url, requisition_id: `R-${id.slice(0, 6)}`, company, role_title: "Senior Frontend Engineer", state: "documents_ready", career_profile_version: 1, blocked_document: null, blocked_claim: null, failure: null, created_at: new Date(), updated_at: new Date() })
    .execute()
  for (const kind of ["resume", "cover_letter"] as const) {
    await database.db
      .insertInto("tailored_document")
      .values({ candidate_id: database.operatorId, id: randomUUID(), application_id: id, kind, career_profile_version: 1, content: "{}", pdf_storage_name: `${randomUUID()}.pdf`, docx_storage_name: `${randomUUID()}.docx`, pdf_sha256: "x", docx_sha256: "x", created_at: new Date() })
      .execute()
  }
  await candidate.post(`/v1/applications/${id}/sample`).expect(200)
  return id
}

const submissionOf = async (id: string) => submissionSchema.parse((await candidate.get(`/v1/applications/${id}/submission`).expect(200)).body)

/** Polls the existing endpoint, as the web does, until the worker settles the sample. */
async function settled(id: string, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const submission = await submissionOf(id)
    const inFlight = submission.state === "submit_claimed" || submission.state === "submitting"
    if ((submission.state !== null && !inFlight) || submission.sample?.state === "awaiting_review") return submission
    if (Date.now() > end) throw new Error(`sample ${id} still pending: ${JSON.stringify(submission)}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

describe("sample approval hands off to the worker (F-QA5-01, activation-gate.feature AC 2.2, 2.4)", () => {
  it("the api answers pending and opens no page; the worker job submits; the gate passes at the fifth", async () => {
    await database.db.insertInto("career_profile_version").values({ candidate_id: database.operatorId, version: 1, status: "approved", source: "edit", resume_upload_id: null, sections: "[]", created_at: new Date(), approved_at: new Date() }).execute()
    await candidate.post("/v1/existing-applications/complete").expect(200)
    for (let index = 0; index < 5; index += 1) {
      const id = await sample(`Handoff ${index}`)
      const clicksBefore = forms.clicks.length
      const result = sampleResultSchema.parse((await candidate.post(`/v1/applications/${id}/sample/approve`).expect(200)).body)
      expect(result).toMatchObject({ result: "pending", alreadyDone: false, countingSamples: index, gatePassedAt: null })
      expect(await settled(id)).toMatchObject({ state: "confirmed", kind: "sample", sample: { state: "approved", counts: true } })
      expect(forms.clicks.length).toBe(clicksBefore + 1)
      const status = submissionStatusSchema.parse((await candidate.get("/v1/submission/status").expect(200)).body)
      expect(status.countingSamples).toBe(index + 1)
      expect(status.todayCount).toBe(0)
      expect(status.gatePassedAt === null).toBe(index < 4)
    }
  })

  it("a second approval while pending submits nothing more and reports alreadyDone", async () => {
    const id = await sample("Twice Co")
    const [first, second] = await Promise.all([candidate.post(`/v1/applications/${id}/sample/approve`), candidate.post(`/v1/applications/${id}/sample/approve`)])
    expect([first.body.alreadyDone, second.body.alreadyDone].sort()).toEqual([false, true])
    expect(await settled(id)).toMatchObject({ state: "confirmed" })
    expect(forms.clicks).toHaveLength(1)
  })

  it("paused at approval: nothing is recorded or queued, the sample stays awaiting review (C-SAMPLE-13)", async () => {
    const id = await sample("Paused Co")
    await database.db.updateTable("control_state").set({ global_paused: true }).execute()
    expect((await candidate.post(`/v1/applications/${id}/sample/approve`).expect(200)).body).toMatchObject({ result: "not_submitted" })
    expect((await submissionOf(id)).sample).toMatchObject({ state: "awaiting_review" })
    expect(forms.opened).toBe(0)
  })

  it("no browser at run time: the worker returns the sample to awaiting review and never retries (C-SAMPLE-13)", async () => {
    const id = await sample("No Browser Co")
    const original = forms.create.bind(forms)
    forms.create = () => Promise.reject(new Error("no browser"))
    try {
      expect((await candidate.post(`/v1/applications/${id}/sample/approve`).expect(200)).body).toMatchObject({ result: "pending" })
      expect(await settled(id)).toMatchObject({ state: null, sample: { state: "awaiting_review", counts: false } })
    } finally {
      forms.create = original
    }
    expect(forms.clicks).toHaveLength(0)
    // The Candidate approves again later; it submits once.
    expect((await candidate.post(`/v1/applications/${id}/sample/approve`).expect(200)).body).toMatchObject({ result: "pending" })
    expect(await settled(id)).toMatchObject({ state: "confirmed" })
  })

  it("worker restart: an approved sample whose job is gone goes back to awaiting review", async () => {
    const id = await sample("Lost Job Co")
    await database.db.updateTable("application").set({ sample_state: "approved" }).where("id", "=", id).execute()
    expect(await worker.get(SubmissionJobs).recoverLostSamples()).toBe(1)
    expect((await submissionOf(id)).sample).toMatchObject({ state: "awaiting_review" })
  })
})
