import { randomUUID } from "node:crypto"

import type { INestApplication } from "@nestjs/common"
import { EXISTING_APPLICATIONS_PATH, SUBMISSIONS_SUMMARY_PATH, samplesPath, submissionsPath } from "@eve/contracts"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { MissingCandidateScopeError } from "../src/db/candidate-scope.js"
import { SubmissionStateService } from "../src/submission/submission-state.service.js"
import { SubmissionRepository } from "../src/submission/submission.repository.js"
import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { asOperator } from "./support/operator-scope.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { insertSecondCandidate } from "./support/second-candidate.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"
import { insertEligibilityFor, insertPostingFor } from "./support/candidate-posting.js"

/**
 * EPIC-0002 A1 unit 2 (submission group): Submissions, samples, existing
 * applications, the cap count and the Activation Gate belong to one Candidate.
 * Every action on the other Candidate's Application is 404 and changes
 * nothing; their rows never reach the owner's lists, counts or duplicate and
 * same-company checks.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let owner: SignedInCandidate
let otherId: string
const clock = new TestClock("2026-10-20T09:00:00.000Z")
const BLOCKED_ID = "00000000-0000-4000-8000-0000000000b1"
const SAMPLE_ID = "00000000-0000-4000-8000-0000000000b2"
const UNCERTAIN_ID = "00000000-0000-4000-8000-0000000000b3"
const CONFIRMED_ID = "00000000-0000-4000-8000-0000000000b4"
const TODAY = "2026-10-20"

async function otherApplication(id: string, company: string, values: Record<string, unknown>): Promise<void> {
  const postingId = randomUUID()
  const url = `https://boards.greenhouse.io/${company.toLowerCase()}/jobs/${id.slice(-2)}`
  await insertPostingFor(database.db, otherId, { id: postingId, application_url: url, requisition_id: id.slice(-2), apply_url: url, application_system: "greenhouse", apply_mode: "automatic", origin: "employer_board", employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null, title: "OTHER-ROLE", company, status: "ranked", skip_reason: null, skip_detail: null, evaluation_failure: null, role_family: "senior_frontend", discovered_at: clock.now(), evaluated_at: clock.now() })
  await insertEligibilityFor(database.db, otherId, postingId)
  await database.db
    .insertInto("application")
    .values({ id, candidate_id: otherId, job_posting_id: postingId, application_url: url, requisition_id: id.slice(-2), company, role_title: "OTHER-ROLE", state: "documents_ready", career_profile_version: 1, blocked_document: null, blocked_claim: null, failure: null, created_at: clock.now(), updated_at: clock.now(), ...values } as never)
    .execute()
}

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  owner = await signInCandidate(new Browser(app, google))
  otherId = await insertSecondCandidate(database.db)
  await database.db.insertInto("activation_state").values({ candidate_id: otherId, gate_passed_at: new Date("2026-10-01"), automatic_enabled: true, existing_applications_completed_at: new Date("2026-10-01") } as never).execute()
})

beforeEach(async () => {
  for (const table of ["notification_outbox", "submission_event", "existing_application", "submission_day", "application", "candidate_posting", "job_posting"] as const) await database.db.deleteFrom(table).execute()
  await database.db.updateTable("activation_state").set({ gate_passed_at: null, automatic_enabled: false, existing_applications_completed_at: null }).where("candidate_id", "!=", otherId).execute()
  await otherApplication(BLOCKED_ID, "Initech", { submission_state: "blocked", submission_kind: "automatic", blocked_reason: "missing_approved_answer", blocked_detail: "OTHER-DETAIL", blocked_at: clock.now() })
  await otherApplication(SAMPLE_ID, "Hooli", { sample_state: "awaiting_review" })
  await otherApplication(UNCERTAIN_ID, "Umbrella", { submission_state: "uncertain", submission_kind: "automatic", submitted_local_day: TODAY, submit_clicked_at: clock.now(), attempt_number: 1 })
  await otherApplication(CONFIRMED_ID, "Globex", { submission_state: "confirmed", submission_kind: "automatic", submitted_local_day: TODAY, sample_counts: true })
  await database.db.insertInto("existing_application").values({ id: randomUUID(), candidate_id: otherId, company: "OTHER-EXISTING", role_title: "r", application_url: "https://boards.greenhouse.io/acme/jobs/1", requisition_id: "1", applied_on: "2026-09-01", created_at: clock.now() } as never).execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

const otherState = (id: string) => database.db.selectFrom("application").select(["submission_state", "sample_state"]).where("id", "=", id).executeTakeFirstOrThrow()

describe("submission group is scoped to the session's Candidate", () => {
  it("lists, counts and summaries carry none of the other Candidate's rows", async () => {
    for (const view of ["attention", "blocked", "uncertain"] as const) expect((await owner.get(submissionsPath(view)).expect(200)).body.rows).toEqual([])
    expect((await owner.get(samplesPath("awaiting_review")).expect(200)).body).not.toMatchObject({ samples: [expect.anything()] })
    expect(JSON.stringify((await owner.get(SUBMISSIONS_SUMMARY_PATH).expect(200)).body)).not.toMatch(/[1-9]/)
    const status = (await owner.get("/v1/submission/status").expect(200)).body
    expect(status).toMatchObject({ todayCount: 0, countingSamples: 0, gatePassedAt: null })
    expect(JSON.stringify((await owner.get(EXISTING_APPLICATIONS_PATH).expect(200)).body)).not.toContain("OTHER-EXISTING")
  })

  it.each([
    ["submission", "get", `/v1/applications/${BLOCKED_ID}/submission`, BLOCKED_ID],
    ["queue", "post", `/v1/applications/${BLOCKED_ID}/queue`, BLOCKED_ID],
    ["manual-complete", "post", `/v1/applications/${BLOCKED_ID}/manual-complete`, BLOCKED_ID],
    ["sample approve", "post", `/v1/applications/${SAMPLE_ID}/sample/approve`, SAMPLE_ID],
    ["sample reject", "post", `/v1/applications/${SAMPLE_ID}/sample/reject`, SAMPLE_ID],
    ["form answers", "get", `/v1/applications/${SAMPLE_ID}/form-answers`, SAMPLE_ID],
    ["mark confirmed", "post", `/v1/applications/${UNCERTAIN_ID}/mark-confirmed`, UNCERTAIN_ID],
    ["mark not submitted", "post", `/v1/applications/${UNCERTAIN_ID}/mark-not-submitted`, UNCERTAIN_ID],
  ] as const)("answers 404 to %s on the other Candidate's Application and changes nothing", async (_name, method, path, id) => {
    const before = await otherState(id)
    const request = method === "get" ? owner.get(path) : owner.post(path).send({ reason: "not mine" })
    await request.expect(404)
    expect(await otherState(id)).toEqual(before)
  })

  it("the other Candidate's existing application and same-company row never refuse the owner's claim", async () => {
    const repository = asOperator(app, app.get(SubmissionRepository))
    expect(await repository.run((tx) => app.get(SubmissionRepository).isExistingApplication(tx, "https://boards.greenhouse.io/acme/jobs/1", "1"))).toBe(false)
    expect(await repository.run((tx) => app.get(SubmissionRepository).hasOtherActiveAtCompany(tx, randomUUID(), "Initech"))).toBe(false)
    expect(await repository.countForDay(TODAY)).toBe(0)
  })

  it("refuses a submission call outside any Candidate scope", async () => {
    await expect(app.get(SubmissionStateService).status()).rejects.toBeInstanceOf(MissingCandidateScopeError)
  })
})
