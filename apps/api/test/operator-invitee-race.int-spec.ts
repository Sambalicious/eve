import { randomUUID } from "node:crypto"

import type { INestApplication } from "@nestjs/common"
import type { Kysely } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { SESSION_COOKIE } from "../src/auth/cookies.js"
import { createDatabase } from "../src/db/create-database.js"
import type { Database } from "../src/db/schema.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { SubmissionRepository } from "../src/submission/submission.repository.js"
import { CandidateJobRunner } from "../src/worker/candidate-job-runner.js"
import { JobQueue } from "../src/worker/job-queue.js"
import { SAMPLE_SUBMISSION } from "../src/worker/submission-jobs.js"
import { Browser } from "./support/browser.js"
import { insertPostingFor } from "./support/candidate-posting.js"
import { FakeGoogle } from "./support/fake-google.js"
import { asOperator } from "./support/operator-scope.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * data-isolation.feature:719 (@concurrent, @until-slice-E, AC 6.6; F-QA-03):
 * slices A to D built, slice E not. Ada's 09:00 WAT run claims her next
 * Application at the same moment Kofi approves a sample of his own. Ada's run
 * claims only Ada's Application (a claim naming Kofi's ID finds nothing), and
 * Kofi's sample is refused on both doors: the approval route answers 409
 * feature_not_yet_available and the worker's CandidateJobRunner refuses a
 * sample job carrying his ID. Kofi's Application is byte-equal afterwards.
 * Real api, real runtime role under RLS, real Postgres.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let runtime: Kysely<Database>
let runner: CandidateJobRunner
let kofi: SignedInCandidate
let kofiId: string
const clock = new TestClock("2026-10-20T08:00:00.000Z")
const KOFI_SUB = "200000000000000000719"
const TODAY = "2026-10-20"

async function application(candidateId: string, company: string, values: Record<string, unknown>): Promise<string> {
  const postingId = randomUUID()
  const id = randomUUID()
  const url = `https://boards.greenhouse.io/${company.toLowerCase()}/jobs/${id.slice(0, 6)}`
  await insertPostingFor(database.db, candidateId, { id: postingId, application_url: url, requisition_id: id.slice(0, 6), apply_url: url, application_system: "greenhouse", apply_mode: "automatic", origin: "employer_board", employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null, title: "Senior Frontend Engineer", company, status: "ranked", skip_reason: null, skip_detail: null, evaluation_failure: null, role_family: "senior_frontend", discovered_at: clock.now(), evaluated_at: clock.now() })
  await database.db
    .insertInto("application")
    .values({ id, candidate_id: candidateId, job_posting_id: postingId, application_url: url, requisition_id: id.slice(0, 6), company, role_title: "Senior Frontend Engineer", state: "documents_ready", career_profile_version: 1, blocked_document: null, blocked_claim: null, failure: null, created_at: clock.now(), updated_at: clock.now(), ...values } as never)
    .execute()
  return id
}

const rowOf = (id: string) => database.db.selectFrom("application").selectAll().where("id", "=", id).executeTakeFirstOrThrow()

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  const ada = await signInCandidate(new Browser(app, google))
  kofiId = (await database.db.insertInto("candidate").values({ email: "kofi.race@example.test", google_sub: KOFI_SUB, role: "candidate" } as never).returning("id").executeTakeFirstOrThrow()).id
  await database.db.insertInto("activation_state").values({ candidate_id: kofiId, gate_passed_at: new Date("2026-10-01"), automatic_enabled: true, existing_applications_completed_at: new Date("2026-10-01") } as never).execute()
  await database.db.insertInto("job_criteria").values({ candidate_id: kofiId, min_core_match_percent: 70 }).onConflict((oc) => oc.column("candidate_id").doNothing()).execute()
  await database.db.updateTable("activation_state").set({ gate_passed_at: new Date("2026-10-19T12:00:00Z"), automatic_enabled: true, existing_applications_completed_at: new Date() }).where("candidate_id", "=", database.operatorId).execute()
  const browser = new Browser(app, google)
  const { sessionCookie } = await browser.signIn({ sub: KOFI_SUB, email: "kofi.race@example.test", email_verified: true })
  const csrf = (await browser.getSession(sessionCookie).expect(200)).body.csrfToken as string
  kofi = new (ada.constructor as typeof SignedInCandidate)(browser, `${SESSION_COOKIE}=${sessionCookie}`, csrf, "kofi.race@example.test")
  runtime = createDatabase(database.url)
  runner = new CandidateJobRunner(new JobQueue({ databaseUrl: database.url }), new TenantDatabase(runtime))
})

afterAll(async () => {
  await runtime?.destroy()
  await app?.close()
  google?.close()
  await database?.stop()
})

describe("Operator and invitee work racing before slice E (:719)", () => {
  it("Ada's run claims only Ada's Application while Kofi's simultaneous sample approval is refused", async () => {
    const adaApplication = await application(database.operatorId, "Globex", { submission_state: "queued", submission_kind: "automatic" })
    // Kofi's sample waits for review; a second one of his is queued like Ada's, as an invitee's would be after slice E.
    const kofiSample = await application(kofiId, "Hooli", { sample_state: "awaiting_review" })
    const kofiQueued = await application(kofiId, "Initech", { submission_state: "queued", submission_kind: "automatic" })
    const before = { sample: await rowOf(kofiSample), queued: await rowOf(kofiQueued) }
    const repository = asOperator(app, app.get(SubmissionRepository))
    const ran: string[] = []

    for (let round = 0; round < 5; round++) {
      const [adaClaim, adaOnKofi, approval, sampleJob] = await Promise.all([
        round === 0 ? repository.claim(adaApplication, "automatic", TODAY, clock.now()) : Promise.resolve(null),
        repository.claim(kofiQueued, "automatic", TODAY, clock.now()),
        kofi.post(`/v1/applications/${kofiSample}/sample/approve`).send({}),
        runner.run(SAMPLE_SUBMISSION, { candidateId: kofiId, applicationId: kofiSample }, async (id) => void ran.push(id)),
      ])
      if (round === 0) expect(adaClaim).toMatchObject({ attemptId: expect.any(String) })
      expect(adaOnKofi).toEqual({ refused: "not_claimable" })
      expect(approval.status).toBe(409)
      expect(approval.body).toMatchObject({ error: { code: "feature_not_yet_available", feature: "submission" } })
      expect(sampleJob).toEqual({ result: "refused", reason: "feature_not_yet_available" })
    }

    expect(ran).toEqual([])
    expect(await rowOf(adaApplication)).toMatchObject({ candidate_id: database.operatorId, submission_state: "submit_claimed" })
    expect(await rowOf(kofiSample)).toEqual(before.sample)
    expect(await rowOf(kofiQueued)).toEqual(before.queued)
    const claimed = await database.db.selectFrom("application").select(["id", "candidate_id"]).where("submission_state", "=", "submit_claimed").execute()
    expect(claimed).toEqual([{ id: adaApplication, candidate_id: database.operatorId }])
  })
})
