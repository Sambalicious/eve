import { randomUUID } from "node:crypto"
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { INestApplication } from "@nestjs/common"
import {
  APPLICATIONS_PATH,
  MINIMAL_RECORDS_PATH,
  RETENTION_PATH,
  applicationsResponseSchema,
  minimalRecordsResponseSchema,
  retentionResponseSchema,
} from "@eve/contracts"
import { type Kysely, sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import {
  WORKER_STATEMENT_TIMEOUT_MS,
  createDatabase,
} from "../src/db/create-database.js"
import type { Database } from "../src/db/schema.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { DocumentSweep } from "../src/documents/document-sweep.js"
import { NotificationRepository } from "../src/notification/notification.repository.js"
import { RetentionRunner } from "../src/records/retention-runner.js"
import { Browser } from "./support/browser.js"
import { insertPostingFor } from "./support/candidate-posting.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { insertSecondCandidate } from "./support/second-candidate.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp, markStorageMigratedSync, candidateDir } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * Merge 11 (slice 9, 12-month expiry, PR #37) under EPIC-0002 tenancy
 * (architecture r4, Tenancy and isolation enforcement): Applications, minimal
 * records and `retention_run` are Candidate data, so automatic expiry runs per
 * Candidate in that Candidate's `CandidateTx`. One Candidate's expiry, counts,
 * runs and files never touch or reveal another's. Runs on the runtime role, as
 * production does: a query outside a Candidate scope sees no Candidate row.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let owner: SignedInCandidate
let otherId: string
let storage: string
/** EPIC-0002 A2: one documents directory per Candidate under this root. */
const docs = (candidateId: string) => candidateDir(storage, candidateId, "documents")
let workerDb: Kysely<Database>
let runner: RetentionRunner
const clock = new TestClock("2026-10-20T02:00:00.000Z")
const RUN = "2026-10-20T03:00:00+01:00"
const DUE = "2025-10-20T09:15:00+01:00"
const NOT_DUE = "2026-03-01T09:15:00+01:00"
const OLD_FILE_TIME = new Date("2025-10-20T10:00:00Z")

type Seeded = { id: string; files: string[] }

async function application(
  candidateId: string,
  created: string,
  requisition: string
): Promise<Seeded> {
  const postingId = randomUUID()
  const url = `https://boards.greenhouse.io/acme/jobs/${requisition}`
  const at = new Date(created)
  await insertPostingFor(database.db, candidateId, {
    id: postingId,
    application_url: url,
    requisition_id: requisition,
    apply_url: url,
    application_system: "greenhouse",
    apply_mode: "automatic",
    origin: "employer_board",
    employer_board_id: null,
    remote_board_key: null,
    attribution_name: null,
    attribution_url: null,
    title: "Senior Backend Engineer",
    company: "Acme Payments",
    status: "ranked",
    skip_reason: null,
    skip_detail: null,
    evaluation_failure: null,
    role_family: "senior_frontend",
    discovered_at: at,
    evaluated_at: at,
  })
  const id = randomUUID()
  await database.db
    .insertInto("application")
    .values({
      id,
      candidate_id: candidateId,
      job_posting_id: postingId,
      application_url: url,
      requisition_id: requisition,
      company: "Acme Payments",
      role_title: "Senior Backend Engineer",
      state: "documents_ready",
      career_profile_version: 1,
      blocked_document: null,
      blocked_claim: null,
      failure: null,
      created_at: at,
      updated_at: at,
    })
    .execute()
  const fileId = randomUUID()
  const files = [`${fileId}.pdf`, `${fileId}.docx`]
  for (const name of files) {
    await writeFile(join(docs(candidateId), name), "x")
    await utimes(join(docs(candidateId), name), OLD_FILE_TIME, OLD_FILE_TIME)
  }
  await database.db
    .insertInto("tailored_document")
    .values({
      id: randomUUID(),
      candidate_id: candidateId,
      application_id: id,
      kind: "resume",
      career_profile_version: 1,
      content: "{}",
      pdf_storage_name: files[0]!,
      docx_storage_name: files[1]!,
      pdf_sha256: "x",
      docx_sha256: "x",
      created_at: at,
    })
    .execute()
  await database.db
    .insertInto("outcome")
    .values({
      id: randomUUID(),
      candidate_id: candidateId,
      application_id: id,
      type: "interview_invitation",
      excerpt: "invite",
      created_at: at,
      updated_at: at,
    })
    .execute()
  return { id, files }
}

async function firstRanOn(candidateId: string, day: string): Promise<void> {
  await database.db
    .insertInto("retention_run")
    .values({
      id: randomUUID(),
      candidate_id: candidateId,
      wat_date: day,
      started_at: new Date(`${day}T02:00:00Z`),
      finished_at: new Date(`${day}T02:00:01Z`),
      outcome: "completed",
    } as never)
    .execute()
}

const detailsDeleted = async (id: string) =>
  (
    await database.db
      .selectFrom("application")
      .select("details_deleted_at")
      .where("id", "=", id)
      .executeTakeFirstOrThrow()
  ).details_deleted_at !== null
const outcomes = async (id: string) =>
  (
    await database.db
      .selectFrom("outcome")
      .select(sql<number>`count(*)::int`.as("n"))
      .where("application_id", "=", id)
      .executeTakeFirstOrThrow()
  ).n

beforeAll(async () => {
  storage = markStorageMigratedSync(await mkdtemp(join(tmpdir(), "ja-retention-iso-")))
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({
    databaseUrl: database.url,
    clock,
    config: { candidateStorageDir: storage },
  })
  app.get(DocumentSweep).onApplicationShutdown()
  owner = await signInCandidate(new Browser(app, google))
  otherId = await insertSecondCandidate(database.db)
  workerDb = createDatabase(database.url, {
    statementTimeoutMs: WORKER_STATEMENT_TIMEOUT_MS,
  })
  runner = new RetentionRunner(new TenantDatabase(workerDb), clock)
})

beforeEach(async () => {
  clock.set("2026-10-20T02:00:00.000Z")
  for (const table of [
    "outcome",
    "tailored_document",
    "application",
    "candidate_posting",
    "job_posting",
    "retention_run",
  ] as const)
    await database.db.deleteFrom(table).execute()
  await database.db
    .updateTable("control_state")
    .set({ global_paused: false, cost_paused: false })
    .execute()
  for (const candidateId of [database.operatorId, otherId]) for (const name of await readdir(docs(candidateId))) await rm(join(docs(candidateId), name), { force: true })
  for (const candidateId of [database.operatorId, otherId])
    await firstRanOn(candidateId, "2026-06-01")
})

afterAll(async () => {
  await workerDb?.destroy()
  await app?.close()
  google?.close()
  await database?.stop()
  await rm(storage, { recursive: true, force: true })
})

describe("retention.daily runs per Candidate", () => {
  it("expires each Candidate's own due Applications and never another's that is not due", async () => {
    const ownerDue = await application(database.operatorId, DUE, "O-1")
    const otherNotDue = await application(otherId, NOT_DUE, "K-1")
    clock.set(RUN)
    await runner.run()
    expect(await detailsDeleted(ownerDue.id)).toBe(true)
    expect(await detailsDeleted(otherNotDue.id)).toBe(false)
    expect(await outcomes(otherNotDue.id)).toBe(1)
  })

  it("records one counts-only run row per Candidate, each with that Candidate's own counts", async () => {
    await application(database.operatorId, DUE, "O-1")
    await application(otherId, DUE, "K-1")
    await application(otherId, DUE, "K-2")
    clock.set(RUN)
    await runner.run()
    const rows = await database.db
      .selectFrom("retention_run")
      .select([
        "candidate_id",
        "deleted_count",
        "due_count",
        "outcome",
      ] as never)
      .where(sql<boolean>`wat_date = '2026-10-20'`)
      .execute()
    const byCandidate = Object.fromEntries(
      (
        rows as unknown as {
          candidate_id: string
          deleted_count: number
          due_count: number
          outcome: string
        }[]
      ).map((row) => [row.candidate_id, row])
    )
    expect(byCandidate[database.operatorId]).toMatchObject({
      due_count: 1,
      deleted_count: 1,
      outcome: "completed",
    })
    expect(byCandidate[otherId]).toMatchObject({
      due_count: 2,
      deleted_count: 2,
      outcome: "completed",
    })
  })

  it("a Candidate still in launch grace keeps their records while another past grace is expired", async () => {
    await database.db
      .deleteFrom("retention_run")
      .where("candidate_id" as never, "=", otherId as never)
      .execute()
    const ownerDue = await application(database.operatorId, DUE, "O-1")
    const otherDue = await application(otherId, DUE, "K-1")
    clock.set(RUN)
    await runner.run()
    expect(await detailsDeleted(ownerDue.id)).toBe(true)
    expect(await detailsDeleted(otherDue.id)).toBe(false)
  })
})

describe("retention routes see only the session's Candidate", () => {
  it("GET /v1/retention counts only the owner's Applications and runs", async () => {
    await application(database.operatorId, "2025-11-01T09:15:00+01:00", "O-1")
    for (const requisition of ["K-1", "K-2", "K-3"])
      await application(otherId, "2025-11-01T09:15:00+01:00", requisition)
    await database.db
      .insertInto("retention_run")
      .values({
        id: randomUUID(),
        candidate_id: otherId,
        wat_date: "2026-10-19",
        started_at: new Date("2026-10-19T02:00:00Z"),
        finished_at: new Date("2026-10-19T02:00:01Z"),
        outcome: "failed",
        deleted_count: 7,
      } as never)
      .execute()
    const body = retentionResponseSchema.parse(
      (await owner.get(RETENTION_PATH).expect(200)).body
    )
    expect(body.dueNext30Days.count).toBe(1)
    expect(body.lastFailure).toBeNull()
    expect(body.lastRun).toMatchObject({
      watDate: "2026-06-01",
      outcome: "completed",
      deletedCount: 0,
    })
  })

  it("?retention=due lists only the owner's Applications", async () => {
    const mine = await application(
      database.operatorId,
      "2025-11-01T09:15:00+01:00",
      "O-1"
    )
    await application(otherId, "2025-11-01T09:15:00+01:00", "K-1")
    const list = applicationsResponseSchema.parse(
      (await owner.get(`${APPLICATIONS_PATH}?retention=due`).expect(200)).body
    ).applications
    expect(list.map((row) => row.id)).toEqual([mine.id])
  })

  it("minimal records expired for another Candidate are not listed for the owner", async () => {
    const mine = await application(database.operatorId, DUE, "O-1")
    await application(otherId, DUE, "K-1")
    clock.set(RUN)
    await runner.run()
    const records = minimalRecordsResponseSchema.parse(
      (await owner.get(MINIMAL_RECORDS_PATH).expect(200)).body
    ).records
    expect(
      records.map((record) => [record.applicationId, record.deletedBy])
    ).toEqual([[mine.id, "expiry"]])
  })

  it("the owner's daily summary counts only the owner's expired records", async () => {
    await application(database.operatorId, DUE, "O-1")
    for (const requisition of ["K-1", "K-2"])
      await application(otherId, DUE, requisition)
    clock.set(RUN)
    await runner.run()
    const repository = app.get(NotificationRepository)
    const tenant = app.get(TenantDatabase)
    expect(
      (
        await tenant.asOperator(() =>
          repository.dailySummaryFacts("2026-10-20")
        )
      ).retentionDeleted
    ).toBe(1)
  })
})

describe("the api document sweep across Candidates", () => {
  it("keeps a file only another Candidate's Tailored Document references, and removes released files", async () => {
    const others = await application(otherId, NOT_DUE, "K-1")
    const mine = await application(database.operatorId, DUE, "O-1")
    clock.set(RUN)
    await runner.run()
    await app.get(DocumentSweep).sweep()
    const othersLeft = await readdir(docs(otherId))
    const mineLeft = await readdir(docs(database.operatorId))
    for (const file of others.files) expect(othersLeft).toContain(file)
    for (const file of mine.files) expect(mineLeft).not.toContain(file)
  })
})
