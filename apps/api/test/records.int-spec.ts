import { randomUUID } from "node:crypto"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { INestApplication } from "@nestjs/common"
import {
  DELETE_DETAILS_PATH,
  MINIMAL_RECORDS_PATH,
  applicationDetailSchema,
  applicationOutcomesPath,
  deleteDetailsResponseSchema,
  minimalRecordPath,
  minimalRecordsResponseSchema,
  outcomePath,
  outcomeSchema,
  outcomesResponseSchema,
} from "@eve/contracts"
import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { SubmissionRepository } from "../src/submission/submission.repository.js"
import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { asOperator } from "./support/operator-scope.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp, markStorageMigratedSync, candidateDir } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"
import { insertCandidatePosting, insertPostingFor } from "./support/candidate-posting.js"
import { insertSecondCandidate } from "./support/second-candidate.js"

/**
 * Manual Outcomes (outcome-tracking.feature @r5, dashboard.feature) and deleting
 * detailed records (data-retention-and-privacy.feature AC 10.3, 10.4), through
 * the real api, real Postgres and real document files in a temp directory.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let candidate: SignedInCandidate
let anonymous: Browser
let storage: string
const clock = new TestClock("2026-10-16T09:00:00.000Z")

type Seed = { company?: string; requisition?: string; url?: string; submissionState?: "confirmed" | "submitting" | null }

async function application(seed: Seed = {}): Promise<{ id: string; files: string[] }> {
  const postingId = randomUUID()
  const requisition = seed.requisition ?? `R-${postingId.slice(0, 6)}`
  const url = seed.url ?? `https://boards.greenhouse.io/acme/jobs/${requisition}`
  await insertPostingFor(database.db, database.operatorId, { id: postingId, application_url: url, requisition_id: requisition, apply_url: url, application_system: "greenhouse", apply_mode: "automatic", origin: "employer_board", employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null, title: "Senior Frontend Engineer", company: seed.company ?? "Acme Payments", status: "ranked", skip_reason: null, skip_detail: null, evaluation_failure: null, role_family: "senior_frontend", discovered_at: new Date("2026-10-01"), evaluated_at: new Date("2026-10-01") })
  const id = randomUUID()
  await database.db
    .insertInto("application")
    .values({ candidate_id: database.operatorId, id, job_posting_id: postingId, application_url: url, requisition_id: requisition, company: seed.company ?? "Acme Payments", role_title: "Senior Frontend Engineer", state: "documents_ready", career_profile_version: 1, blocked_document: null, blocked_claim: null, failure: null, created_at: new Date("2026-10-01T10:00:00Z"), updated_at: new Date("2026-10-01T10:00:00Z") })
    .execute()
  if (seed.submissionState !== undefined && seed.submissionState !== null) {
    await database.db
      .updateTable("application")
      .set({ submission_state: seed.submissionState, submission_kind: "automatic", evidence_kind: "application_id", evidence_text: "APP-778812", submit_clicked_at: new Date("2026-10-02T09:00:00Z"), confirmed_at: new Date() })
      .where("id", "=", id)
      .execute()
  }
  const files: string[] = []
  for (const kind of ["resume", "cover_letter"] as const) {
    const fileId = randomUUID()
    const pdf = `${fileId}.pdf`
    const docx = `${fileId}.docx`
    await writeFile(join(candidateDir(storage, database.operatorId, "documents"), pdf), "pdf")
    await writeFile(join(candidateDir(storage, database.operatorId, "documents"), docx), "docx")
    files.push(pdf, docx)
    await database.db
      .insertInto("tailored_document")
      .values({ candidate_id: database.operatorId, id: randomUUID(), application_id: id, kind, career_profile_version: 1, content: "{}", pdf_storage_name: pdf, docx_storage_name: docx, pdf_sha256: "x", docx_sha256: "x", created_at: new Date() })
      .execute()
  }
  await database.db.insertInto("application_form_read").values({ candidate_id: database.operatorId, application_id: id, host: "boards.greenhouse.io", controls: JSON.stringify([{ ref: "e1", label: "Email", kind: "text", required: true }]), read_at: new Date() }).execute()
  await database.db.insertInto("submission_event").values({ candidate_id: database.operatorId, id: randomUUID(), application_id: id, kind: "evidence_pre_submit", detail: "a1-pre_submit.yml,a1-pre_submit.png", created_at: new Date() }).execute()
  return { id, files }
}

const record = (id: string, type: string) => candidate.post(applicationOutcomesPath(id)).send({ type })
const deleteDetails = (applicationIds: string[]) => candidate.post(DELETE_DETAILS_PATH).send({ applicationIds })

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), "ja-records-int-"))
  markStorageMigratedSync(storage)
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock, config: { candidateStorageDir: storage } })
  anonymous = new Browser(app, google)
  candidate = await signInCandidate(new Browser(app, google))
})

beforeEach(async () => {
  clock.set("2026-10-16T09:00:00.000Z")
  for (const table of ["outcome", "notification_outbox", "submission_event", "application_form_read", "tailored_document", "application", "candidate_posting", "job_posting"] as const) await database.db.deleteFrom(table).execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
  await rm(storage, { recursive: true, force: true })
})

describe("manual Outcomes (outcome-tracking.feature @r5, AC 8.1 to 8.3)", () => {
  it("records an Outcome by hand, as entered by the Candidate, with no Gmail connection", async () => {
    const { id } = await application()
    const outcome = outcomeSchema.parse((await record(id, "interview_invitation").expect(201)).body)
    expect(outcome).toMatchObject({ applicationId: id, type: "interview_invitation", source: "candidate", excerpt: null })
    expect(outcomesResponseSchema.parse((await candidate.get(applicationOutcomesPath(id)).expect(200)).body).outcomes).toHaveLength(1)
  })

  it.each([
    ["confirmation", "rejection"],
    ["request_for_action", "interview_invitation"],
  ])("editing %s to %s replaces the type and keeps one Outcome", async (from, to) => {
    const { id } = await application()
    const created = outcomeSchema.parse((await record(id, from).expect(201)).body)
    const edited = outcomeSchema.parse((await candidate.patch(outcomePath(created.id)).send({ type: to }).expect(200)).body)
    expect(edited).toMatchObject({ id: created.id, type: to })
    const list = outcomesResponseSchema.parse((await candidate.get(applicationOutcomesPath(id)).expect(200)).body).outcomes
    expect(list.map((item) => item.type)).toEqual([to])
  })

  it("editing the type keeps a stored excerpt (OQ-D15)", async () => {
    const { id } = await application()
    const excerpt = "Thanks for applying to Acme Payments. We received your application for Senior Frontend Engineer."
    const outcomeId = randomUUID()
    await database.db.insertInto("outcome").values({ candidate_id: database.operatorId, id: outcomeId, application_id: id, type: "confirmation", excerpt, created_at: new Date(), updated_at: new Date() }).execute()
    const edited = outcomeSchema.parse((await candidate.patch(outcomePath(outcomeId)).send({ type: "rejection" }).expect(200)).body)
    expect(edited).toMatchObject({ type: "rejection", excerpt })
  })

  it("refuses an unknown type, an unknown Application and an unknown Outcome", async () => {
    const { id } = await application()
    await record(id, "promotion").expect(400)
    await record(randomUUID(), "rejection").expect(404)
    await candidate.patch(outcomePath(randomUUID())).send({ type: "rejection" }).expect(404)
  })

  it("an unauthenticated request cannot record or edit an Outcome (@permission)", async () => {
    const { id } = await application()
    const created = outcomeSchema.parse((await record(id, "confirmation").expect(201)).body)
    await anonymous.http().post(applicationOutcomesPath(id)).send({ type: "rejection" }).expect(401)
    await anonymous.http().patch(outcomePath(created.id)).send({ type: "rejection" }).expect(401)
    await anonymous.http().get(applicationOutcomesPath(id)).expect(401)
    const list = outcomesResponseSchema.parse((await candidate.get(applicationOutcomesPath(id)).expect(200)).body).outcomes
    expect(list.map((item) => item.type)).toEqual(["confirmation"])
  })
})

describe("deleting detailed records (data-retention-and-privacy.feature AC 10.3, 10.4)", () => {
  it("deletes one Application's records, documents, answers and Outcomes, and removes the files from storage", async () => {
    const { id, files } = await application({ requisition: "R-1042", submissionState: "confirmed" })
    await record(id, "rejection").expect(201)
    expect(deleteDetailsResponseSchema.parse((await deleteDetails([id]).expect(200)).body)).toEqual({ deletedCount: 1 })
    const remaining = await readdir(candidateDir(storage, database.operatorId, "documents"))
    for (const file of files) expect(remaining).not.toContain(file)
    expect(await database.db.selectFrom("tailored_document").select("id").where("application_id", "=", id).execute()).toEqual([])
    expect(await database.db.selectFrom("application_form_read").select("application_id").where("application_id", "=", id).execute()).toEqual([])
    expect(await database.db.selectFrom("outcome").select("id").where("application_id", "=", id).execute()).toEqual([])
    expect(await database.db.selectFrom("submission_event").select("id").where("application_id", "=", id).execute()).toEqual([])
    const detail = applicationDetailSchema.parse((await candidate.get(`/v1/applications/${id}`).expect(200)).body)
    expect(detail.detailsDeletedAt).toBe("2026-10-16T09:00:00.000Z")
    expect(detail.documents).toEqual([])
    expect(detail.roleTitle).toBeNull()
    await candidate.get(`/v1/applications/${id}/documents/resume.pdf`).expect(404)
  })

  it("leaves a minimal record with company, URL, requisition ID, date and final status, and nothing else (@ac-10.4)", async () => {
    const url = "https://boards.greenhouse.io/acme/jobs/1042"
    const { id } = await application({ requisition: "R-1042", url, submissionState: "confirmed" })
    await record(id, "rejection").expect(201)
    await deleteDetails([id]).expect(200)
    const records = minimalRecordsResponseSchema.parse((await candidate.get(MINIMAL_RECORDS_PATH).expect(200)).body).records
    expect(records).toEqual([{ applicationId: id, company: "Acme Payments", applicationUrl: url, requisitionId: "R-1042", createdAt: "2026-10-01T10:00:00.000Z", detailsDeletedAt: "2026-10-16T09:00:00.000Z", finalStatus: "rejection", deletedBy: "candidate" }])
    const row = await database.db.selectFrom("application").selectAll().where("id", "=", id).executeTakeFirstOrThrow()
    expect(row).toMatchObject({ role_title: null, evidence_text: null, blocked_detail: null, blocked_question: null, details_deleted_by: "candidate" })
  })

  it("deletes in bulk and reports the count for C-DATA-4", async () => {
    const ids = [(await application({ requisition: "R-1042" })).id, (await application({ requisition: "L-77" })).id, (await application({ requisition: "A-9" })).id]
    expect(deleteDetailsResponseSchema.parse((await deleteDetails(ids).expect(200)).body)).toEqual({ deletedCount: 3 })
    expect(minimalRecordsResponseSchema.parse((await candidate.get(MINIMAL_RECORDS_PATH).expect(200)).body).records.map((item) => item.requisitionId).sort()).toEqual(["A-9", "L-77", "R-1042"])
  })

  it("deleting again leaves the minimal record intact and counts nothing (@duplicate)", async () => {
    const { id } = await application({ requisition: "R-1042" })
    await deleteDetails([id]).expect(200)
    clock.set("2026-10-17T09:00:00.000Z")
    expect(deleteDetailsResponseSchema.parse((await deleteDetails([id]).expect(200)).body)).toEqual({ deletedCount: 0 })
    const records = minimalRecordsResponseSchema.parse((await candidate.get(MINIMAL_RECORDS_PATH).expect(200)).body).records
    expect(records).toHaveLength(1)
    expect(records[0]!.detailsDeletedAt).toBe("2026-10-16T09:00:00.000Z")
  })

  it("the minimal record keeps blocking a second Application for the requisition and is never submitted", async () => {
    const { id } = await application({ requisition: "R-1042" })
    await deleteDetails([id]).expect(200)
    const posting = await database.db.selectFrom("application").select("job_posting_id").where("id", "=", id).executeTakeFirstOrThrow()
    const second = await candidate.post("/v1/applications").send({ jobPostingId: posting.job_posting_id }).expect(200)
    expect(second.body).toMatchObject({ created: false, application: { id } })
    await database.db.updateTable("application").set({ submission_state: "queued", submission_kind: "automatic" }).where("id", "=", id).execute()
    expect(await asOperator(app, app.get(SubmissionRepository)).claim(id, "automatic", "2026-10-16", clock.now())).toEqual({ refused: "not_claimable" })
    await candidate.post(applicationOutcomesPath(id)).send({ type: "rejection" }).expect(409)
    await candidate.post(`/v1/applications/${id}/documents/generate`).expect(409)
  })

  it("clearing the minimal record stops it blocking: the requisition can be found again (@ac-10.4)", async () => {
    const url = "https://boards.greenhouse.io/acme/jobs/1042"
    const { id } = await application({ requisition: "R-1042", url })
    await deleteDetails([id]).expect(200)
    await candidate.delete(minimalRecordPath(id)).expect(204)
    expect(minimalRecordsResponseSchema.parse((await candidate.get(MINIMAL_RECORDS_PATH).expect(200)).body).records).toEqual([])
    expect(await database.db.selectFrom("application").select("id").where("application_url", "=", url).execute()).toEqual([])
    expect(await database.db.selectFrom("job_posting").select("id").where("application_url", "=", url).execute()).toEqual([])
  })

  it("repair wave 1 (F-QA-11): clearing deletes an unheld posting, and the scope still commits", async () => {
    const { id } = await application({ requisition: "R-2001" })
    await deleteDetails([id]).expect(200)
    const { job_posting_id: postingId } = await database.db.selectFrom("application").select("job_posting_id").where("id", "=", id).executeTakeFirstOrThrow()
    await candidate.delete(minimalRecordPath(id)).expect(204)
    expect(await database.db.selectFrom("job_posting").select("id").where("id", "=", postingId).execute()).toEqual([])
    expect(await database.db.selectFrom("candidate_posting").select("candidate_id").where("job_posting_id", "=", postingId).execute()).toEqual([])
  })

  it("repair wave 1 (F-QA-11): a posting another Candidate holds stays; its foreign-key refusal rolls back to the savepoint and the clear still succeeds", async () => {
    const otherId = await insertSecondCandidate(database.db)
    const { id } = await application({ requisition: "R-2002" })
    await deleteDetails([id]).expect(200)
    const { job_posting_id: postingId } = await database.db.selectFrom("application").select("job_posting_id").where("id", "=", id).executeTakeFirstOrThrow()
    await insertCandidatePosting(database.db, otherId, postingId, { status: "ranked" })
    // Without the savepoint the refused delete aborts the transaction and the request answers 500.
    await candidate.delete(minimalRecordPath(id)).expect(204)
    expect(await database.db.selectFrom("application").select("id").where("id", "=", id).execute()).toEqual([])
    expect(await database.db.selectFrom("job_posting").select("id").where("id", "=", postingId).execute()).toEqual([{ id: postingId }])
    expect(await database.db.selectFrom("candidate_posting").select("candidate_id").where("job_posting_id", "=", postingId).execute()).toEqual([{ candidate_id: otherId }])
  })

  it("only a minimal record can be cleared", async () => {
    const { id } = await application()
    await candidate.delete(minimalRecordPath(id)).expect(409)
    await candidate.delete(minimalRecordPath(randomUUID())).expect(404)
  })

  it("refuses unknown IDs and an attempt in flight, deleting nothing", async () => {
    const live = await application({ requisition: "R-1" })
    await deleteDetails([live.id, randomUUID()]).expect(404)
    const busy = await application({ requisition: "R-2", submissionState: "submitting" })
    await deleteDetails([live.id, busy.id]).expect(409)
    expect(await database.db.selectFrom("tailored_document").select("id").where("application_id", "=", live.id).execute()).toHaveLength(2)
  })

  it("refuses an empty list, more than 100 IDs and unknown keys", async () => {
    await deleteDetails([]).expect(400)
    await deleteDetails(Array.from({ length: 101 }, () => randomUUID())).expect(400)
    await candidate.post(DELETE_DETAILS_PATH).send({ applicationIds: [randomUUID()], keep: true }).expect(400)
  })

  it("an unauthenticated request cannot delete records; they are kept (@permission)", async () => {
    const { id } = await application({ requisition: "R-1042" })
    await anonymous.http().post(DELETE_DETAILS_PATH).send({ applicationIds: [id] }).expect(401)
    await anonymous.http().delete(minimalRecordPath(id)).expect(401)
    expect(await database.db.selectFrom("tailored_document").select("id").where("application_id", "=", id).execute()).toHaveLength(2)
  })

  it("the api itself deletes nothing on its own, however old the record (retired @r5; automatic expiry is the worker's retention.daily)", async () => {
    const { id } = await application({ requisition: "R-1042" })
    // Automatic expiry runs only in the worker (retention.int-spec.ts); no api request or timer deletes records.
    clock.set("2027-10-21T09:00:00.000Z")
    const row = await database.db.selectFrom("application").select(["details_deleted_at", "role_title"]).where("id", "=", id).executeTakeFirstOrThrow()
    expect(row).toEqual({ details_deleted_at: null, role_title: "Senior Frontend Engineer" })
    expect(await database.db.selectFrom("tailored_document").select("id").where("application_id", "=", id).execute()).toHaveLength(2)
  })
})

describe("repair wave 1 (slice 07b): recording an Outcome holds against a deletion (CR7-02)", () => {
  /** Waits until another backend (the api's, another role, so pg_locks not pg_stat_activity) is blocked on a lock. */
  async function untilLockWait(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const { rows } = await sql<{ n: number }>`select count(*)::int as n from pg_locks where not granted`.execute(database.db)
      if (rows[0]!.n > 0) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error("the Outcome request never waited on the deletion's lock")
  }

  it("an Outcome recorded while the deletion holds the row is refused with 409 and no outcome row is left on the minimal record", async () => {
    const { id } = await application()
    const pending = await database.db.transaction().execute(async (trx) => {
      // The deletion's first step: the Application row FOR UPDATE.
      await trx.selectFrom("application").select("id").where("id", "=", id).forUpdate().execute()
      const request = record(id, "rejection").then((response) => response)
      await untilLockWait()
      await trx.updateTable("application").set({ details_deleted_at: new Date(), role_title: null, final_status: "documents_ready" }).where("id", "=", id).execute()
      return { request }
    })
    const response = await pending.request
    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({ error: { code: "application_state_conflict" } })
    expect(await database.db.selectFrom("outcome").select("id").where("application_id", "=", id).execute()).toEqual([])
  })

  it("an Outcome on an already-deleted record is 409", async () => {
    const { id } = await application()
    await deleteDetails([id]).expect(200)
    expect((await record(id, "rejection").expect(409)).body).toMatchObject({ error: { code: "application_state_conflict" } })
  })
})
