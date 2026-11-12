import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { INestApplication } from "@nestjs/common"
import { DELETE_DETAILS_PATH, MINIMAL_RECORDS_PATH, applicationOutcomesPath, minimalRecordPath, minimalRecordsResponseSchema, outcomePath } from "@eve/contracts"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { MissingCandidateScopeError } from "../src/db/candidate-scope.js"
import { RecordsService } from "../src/records/records.service.js"
import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { insertSecondCandidate } from "./support/second-candidate.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp, markStorageMigratedSync } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"
import { insertPostingFor } from "./support/candidate-posting.js"

/**
 * EPIC-0002 A1 unit 2 (records group): Outcomes and record deletion see only
 * the session's Candidate. The other Candidate's Application, Outcome and
 * minimal record answer 404 and stay unchanged.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let owner: SignedInCandidate
let storage: string
let otherId: string
const clock = new TestClock("2026-10-16T09:00:00.000Z")
const LIVE_ID = "00000000-0000-4000-8000-0000000000c1"
const MINIMAL_ID = "00000000-0000-4000-8000-0000000000c2"
const OUTCOME_ID = "00000000-0000-4000-8000-0000000000c3"

async function otherApplication(id: string, deleted: boolean): Promise<void> {
  const postingId = randomUUID()
  const url = `https://boards.greenhouse.io/other/jobs/${id.slice(-4)}`
  await insertPostingFor(database.db, otherId, { id: postingId, application_url: url, requisition_id: id.slice(-4), apply_url: url, application_system: "greenhouse", apply_mode: "automatic", origin: "employer_board", employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null, title: "Other Role", company: "Other Co", status: "ranked", skip_reason: null, skip_detail: null, evaluation_failure: null, role_family: "senior_frontend", discovered_at: new Date("2026-10-01"), evaluated_at: new Date("2026-10-01") })
  await database.db
    .insertInto("application")
    .values({ id, candidate_id: otherId, job_posting_id: postingId, application_url: url, requisition_id: id.slice(-4), company: "Other Co", role_title: "Other Role", state: "documents_ready", career_profile_version: 1, blocked_document: null, blocked_claim: null, failure: null, created_at: new Date("2026-10-01T10:00:00Z"), updated_at: new Date("2026-10-01T10:00:00Z"), ...(deleted ? { details_deleted_at: new Date("2026-10-05T10:00:00Z"), final_status: "confirmed" } : {}) })
    .execute()
}

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), "ja-records-iso-"))
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock, config: { candidateStorageDir: markStorageMigratedSync(storage) } })
  owner = await signInCandidate(new Browser(app, google))
  otherId = await insertSecondCandidate(database.db)
})

beforeEach(async () => {
  for (const table of ["outcome", "application", "candidate_posting", "job_posting"] as const) await database.db.deleteFrom(table).execute()
  await otherApplication(LIVE_ID, false)
  await otherApplication(MINIMAL_ID, true)
  await database.db.insertInto("outcome").values({ id: OUTCOME_ID, candidate_id: otherId, application_id: LIVE_ID, type: "confirmation", excerpt: "OTHER-EXCERPT", created_at: new Date(), updated_at: new Date() }).execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
  await rm(storage, { recursive: true, force: true })
})

describe("records group is scoped to the session's Candidate", () => {
  it("answers 404 to reading and recording Outcomes on the other Candidate's Application", async () => {
    await owner.get(applicationOutcomesPath(LIVE_ID)).expect(404)
    await owner.post(applicationOutcomesPath(LIVE_ID)).send({ type: "rejection" }).expect(404)
    expect(await database.db.selectFrom("outcome").select("id").execute()).toEqual([{ id: OUTCOME_ID }])
  })

  it("answers 404 to editing the other Candidate's Outcome and leaves it unchanged", async () => {
    await owner.patch(outcomePath(OUTCOME_ID)).send({ type: "rejection" }).expect(404)
    expect(await database.db.selectFrom("outcome").select("type").where("id", "=", OUTCOME_ID).executeTakeFirst()).toEqual({ type: "confirmation" })
  })

  it("answers 404 to deleting the other Candidate's details and deletes nothing", async () => {
    await owner.post(DELETE_DETAILS_PATH).send({ applicationIds: [LIVE_ID] }).expect(404)
    const row = await database.db.selectFrom("application").select(["details_deleted_at", "role_title"]).where("id", "=", LIVE_ID).executeTakeFirstOrThrow()
    expect(row).toEqual({ details_deleted_at: null, role_title: "Other Role" })
  })

  it("lists none of the other Candidate's minimal records and answers 404 to clearing one", async () => {
    const records = minimalRecordsResponseSchema.parse((await owner.get(MINIMAL_RECORDS_PATH).expect(200)).body).records
    expect(records).toEqual([])
    await owner.delete(minimalRecordPath(MINIMAL_ID)).expect(404)
    expect(await database.db.selectFrom("application").select("id").where("id", "=", MINIMAL_ID).executeTakeFirst()).toEqual({ id: MINIMAL_ID })
  })

  it("refuses a records call outside any Candidate scope", async () => {
    await expect(app.get(RecordsService).minimalRecords()).rejects.toBeInstanceOf(MissingCandidateScopeError)
  })
})
