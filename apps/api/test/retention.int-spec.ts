import { randomUUID } from "node:crypto"
import { chmod, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { type INestApplication, Logger } from "@nestjs/common"
import {
  APPLICATIONS_PATH,
  DELETE_DETAILS_PATH,
  MINIMAL_RECORDS_PATH,
  RETENTION_PATH,
  applicationDetailSchema,
  applicationOutcomesPath,
  applicationsResponseSchema,
  minimalRecordsResponseSchema,
  retentionResponseSchema,
} from "@eve/contracts"
import { type Kysely, sql } from "kysely"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { WORKER_STATEMENT_TIMEOUT_MS, createDatabase } from "../src/db/create-database.js"
import type { Database } from "../src/db/schema.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { DocumentSweep } from "../src/documents/document-sweep.js"
import { NotificationRepository } from "../src/notification/notification.repository.js"
import { OutreachRunInFlightError } from "../src/records/details-deletion.js"
import { RetentionRunner } from "../src/records/retention-runner.js"
import { SubmissionRepository } from "../src/submission/submission.repository.js"
import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp, markStorageMigratedSync, candidateDir } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"
import { insertPostingFor } from "./support/candidate-posting.js"

/** EPIC-0006: the shared posting is re-posted near the run, so it is visible (AC-6.2) and a create reaches the duplicate rule. */
const RUN_POSTED_AT = new Date("2026-10-15T08:00:00.000Z")

/**
 * automatic-expiry.feature (PRD prd-12-month-expiry.md r1) through the real api,
 * real Postgres (runtime role) and real files. The job's RetentionRunner runs on
 * its own pool with the worker's 60 s statement timeout, as in the worker.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let anonymous: Browser
/** EPIC-0002 A2: the per-Candidate root; `storage` is the Operator's documents directory under it. */
let storageRoot: string
let storage: string
let workerDb: Kysely<Database>
let runner: RetentionRunner
let sweep: DocumentSweep
const clock = new TestClock("2026-10-20T02:00:00.000Z")
const RUN = "2026-10-20T03:00:00+01:00"
const OLD_FILE_TIME = new Date("2025-10-20T10:00:00Z")

type Seed = {
  requisition?: string
  created?: string
  company?: string
  url?: string
  state?: "documents_ready" | "generating" | "prepared"
  submissionState?: string | null
  sampleState?: string | null
  documents?: boolean
  outcome?: string | null
  details?: boolean
  /** The owning Candidate; the Operator when omitted. */
  candidateId?: string
}

async function application(seed: Seed = {}): Promise<{ id: string; files: string[]; postingId: string }> {
  const postingId = randomUUID()
  const requisition = seed.requisition ?? `R-${postingId.slice(0, 8)}`
  const url = seed.url ?? `https://boards.greenhouse.io/acme/jobs/${requisition}`
  const company = seed.company ?? "Acme Payments"
  const created = new Date(seed.created ?? "2025-10-20T09:15:00+01:00")
  const candidateId = seed.candidateId ?? database.operatorId
  await insertPostingFor(database.db, candidateId, { id: postingId, application_url: url, requisition_id: requisition, apply_url: url, application_system: "greenhouse", apply_mode: "automatic", origin: "employer_board", employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null, title: "Senior Backend Engineer", company, status: "ranked", skip_reason: null, skip_detail: null, evaluation_failure: null, role_family: "senior_frontend", discovered_at: created, evaluated_at: created, posted_at: RUN_POSTED_AT, posted_date_kind: "published" })
  const id = randomUUID()
  await database.db
    .insertInto("application")
    .values({ id, candidate_id: candidateId, job_posting_id: postingId, application_url: url, requisition_id: requisition, company, role_title: "Senior Backend Engineer", state: seed.state ?? "documents_ready", career_profile_version: 1, blocked_document: null, blocked_claim: null, failure: null, created_at: created, updated_at: created })
    .execute()
  const submission = seed.submissionState ?? null
  if (submission !== null || seed.sampleState) {
    await database.db
      .updateTable("application")
      .set({
        submission_state: submission as never,
        submission_kind: submission ? "automatic" : null,
        submit_clicked_at: submission && submission !== "queued" ? created : null,
        blocked_reason: submission === "blocked" ? "login" : null,
        sample_state: (seed.sampleState ?? null) as never,
      })
      .where("id", "=", id)
      .execute()
  }
  if (seed.details) {
    await database.db
      .updateTable("application")
      .set({ blocked_claim: "claim", blocked_detail: "detail", blocked_question: "question", evidence_text: "APP-1", sample_reject_reason: "reason", declined_reason: "declined", failure: "provider_error" })
      .where("id", "=", id)
      .execute()
  }
  const files: string[] = []
  if (seed.documents !== false) {
    const fileId = randomUUID()
    for (const name of [`${fileId}.pdf`, `${fileId}.docx`]) {
      await writeFile(join(storage, name), "x")
      await utimes(join(storage, name), OLD_FILE_TIME, OLD_FILE_TIME)
      files.push(name)
    }
    await database.db
      .insertInto("tailored_document")
      .values({ id: randomUUID(), candidate_id: candidateId, application_id: id, kind: "resume", career_profile_version: 1, content: "{}", pdf_storage_name: files[0]!, docx_storage_name: files[1]!, pdf_sha256: "x", docx_sha256: "x", created_at: created })
      .execute()
    await database.db.insertInto("application_form_read").values({ candidate_id: candidateId, application_id: id, host: "boards.greenhouse.io", controls: JSON.stringify([{ ref: "e1", label: "Email", kind: "text", required: true }]), read_at: created }).execute()
    if (seed.outcome !== null) await database.db.insertInto("outcome").values({ id: randomUUID(), candidate_id: candidateId, application_id: id, type: (seed.outcome ?? "interview_invitation") as never, excerpt: "We'd like to invite you to interview", created_at: created, updated_at: created }).execute()
    for (const kind of ["confirmed", "blocked"] as const) await database.db.insertInto("notification_outbox").values({ id: randomUUID(), candidate_id: candidateId, application_id: id, kind, created_at: created, sent_at: null }).execute()
    for (let i = 0; i < 4; i++) await database.db.insertInto("submission_event").values({ id: randomUUID(), candidate_id: candidateId, application_id: id, kind: "evidence_pre_submit", detail: `a${i}.yml`, created_at: created }).execute()
  }
  return { id, files, postingId }
}

async function firstRanOn(day: string): Promise<void> {
  await database.db.insertInto("retention_run").values({ candidate_id: database.operatorId, id: randomUUID(), wat_date: day, started_at: new Date(`${day}T02:00:00Z`), finished_at: new Date(`${day}T02:00:01Z`), outcome: "completed" }).execute()
}

async function runAt(time: string) {
  clock.set(time)
  return runner.run()
}

async function row(id: string) {
  return database.db.selectFrom("application").selectAll().where("id", "=", id).executeTakeFirstOrThrow()
}

const deleted = async (id: string) => (await row(id)).details_deleted_at !== null
const childCount = async (table: "tailored_document" | "application_form_read" | "outcome" | "notification_outbox" | "submission_event", id: string) =>
  (await database.db.selectFrom(table).select(sql<number>`count(*)::int`.as("n")).where("application_id", "=", id).executeTakeFirstOrThrow()).n

/** Sessions expire as the test clock jumps months; sign in at the current clock before each request. */
const fresh = (): Promise<SignedInCandidate> => signInCandidate(new Browser(app, google))

async function setPause(paused: boolean): Promise<void> {
  await database.db.updateTable("control_state").set({ global_paused: paused }).execute()
}

beforeAll(async () => {
  storageRoot = markStorageMigratedSync(await mkdtemp(join(tmpdir(), "ja-retention-int-")))
  database = await startMigratedDatabase()
  storage = candidateDir(storageRoot, database.operatorId, "documents")
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock, config: { candidateStorageDir: storageRoot } })
  sweep = app.get(DocumentSweep)
  // The test drives the sweep itself; stop the 60 s and hourly timers.
  sweep.onApplicationShutdown()
  anonymous = new Browser(app, google)
  workerDb = createDatabase(database.url, { statementTimeoutMs: WORKER_STATEMENT_TIMEOUT_MS })
  runner = new RetentionRunner(new TenantDatabase(workerDb), clock)
})

beforeEach(async () => {
  clock.set("2026-10-20T02:00:00.000Z")
  for (const table of ["outcome", "notification_outbox", "submission_event", "application_form_read", "tailored_document", "outreach_message", "spend_entry", "spend_month", "ai_call", "eligibility_result", "existing_application", "application", "match_evidence", "candidate_posting", "job_posting", "retention_run"] as const) await database.db.deleteFrom(table).execute()
  await setPause(false)
  await database.db.updateTable("control_state").set({ cost_paused: false }).execute()
  for (const name of await readdir(storage)) await rm(join(storage, name), { force: true, recursive: true })
  await firstRanOn("2026-06-01")
})

afterEach(() => vi.restoreAllMocks())

afterAll(async () => {
  await workerDb?.destroy()
  await app?.close()
  google?.close()
  await database?.stop()
  await rm(storageRoot, { recursive: true, force: true })
})

describe("E1 expiry date on a run (WAT boundary, 29 February)", () => {
  it.each([
    ["2026-10-19T03:00:00+01:00", false],
    ["2026-10-19T23:59:59+01:00", false],
    ["2026-10-20T00:00:00+01:00", true],
    ["2026-10-20T03:00:00+01:00", true],
    ["2026-10-21T03:00:00+01:00", true],
  ])("@ac-E1.5 created 2025-10-20 09:15 WAT, run at %s: deleted %s", async (time, expected) => {
    const { id } = await application({ requisition: "R-1042" })
    await runAt(time)
    expect(await deleted(id)).toBe(expected)
  })

  it.each([
    ["2026-10-19T22:59:59Z", false],
    ["2026-10-19T23:00:00Z", true],
  ])("@ac-E1.4 created 2025-10-19T23:30Z (20 Oct WAT), run at %s: deleted %s", async (time, expected) => {
    const { id } = await application({ requisition: "L-77", created: "2025-10-19T23:30:00Z" })
    await runAt(time)
    expect(await deleted(id)).toBe(expected)
  })

  it.each([
    ["2025-02-27T03:00:00+01:00", false],
    ["2025-02-28T03:00:00+01:00", true],
  ])("@ac-E1.3 D-E1 created 29 Feb 2024, run at %s: deleted %s", async (time, expected) => {
    await database.db.deleteFrom("retention_run").execute()
    await firstRanOn("2024-06-01")
    const { id } = await application({ requisition: "A-9", created: "2024-02-29T10:00:00+01:00" })
    await runAt(time)
    expect(await deleted(id)).toBe(expected)
  })

  it("@ac-E1.6 an Application deleted by the Candidate is never due and keeps its record", async () => {
    const { id } = await application({ requisition: "R-1042" })
    clock.set("2026-03-02T10:00:00+01:00")
    await (await fresh()).post(DELETE_DETAILS_PATH).send({ applicationIds: [id] }).expect(200)
    const summary = await runAt(RUN)
    expect(summary.due).toBe(0)
    expect(await row(id)).toMatchObject({ details_deleted_by: "candidate", details_deleted_at: new Date("2026-03-02T09:00:00Z") })
  })
})

describe("E2 what is deleted and what stays", () => {
  it("@ac-E2.1 @ac-E2.2 @ac-E2.3 deletes the detail rows, clears the fields, sets the final status and the time, releases 2 files", async () => {
    const { id, files } = await application({ requisition: "R-1042", details: true, submissionState: "confirmed", outcome: "rejection" })
    const summary = await runAt(RUN)
    for (const table of ["tailored_document", "application_form_read", "outcome", "notification_outbox", "submission_event"] as const) expect(await childCount(table, id)).toBe(0)
    expect(await row(id)).toMatchObject({ role_title: null, blocked_claim: null, blocked_detail: null, blocked_question: null, evidence_text: null, sample_reject_reason: null, declined_reason: null, failure: null, final_status: "rejection", details_deleted_at: new Date(RUN), details_deleted_by: "expiry" })
    expect(summary.filesReleased).toBe(2)
    // The worker does not unlink: the volume is read-only there (E4.4).
    expect(await readdir(storage)).toEqual(expect.arrayContaining(files))
  })

  it("AA-7.1 (apply-anyway.feature:1117, by automatic expiry): the minimal record keeps no override time or decision", async () => {
    const { id } = await application({ requisition: "R-4601", submissionState: "confirmed" })
    await database.db
      .updateTable("application")
      .set({ override_created_at: new Date("2025-10-20T09:00:00Z"), override_status: "skipped", override_skip_reason: "weak_core_match", override_skip_detail: null, override_violated_rules: [], candidate_override_at: new Date("2025-10-20T09:00:00Z") })
      .where("id", "=", id)
      .execute()
    await runAt(RUN)
    expect(await row(id)).toMatchObject({ details_deleted_by: "expiry", candidate_override_at: null, override_created_at: null, override_status: null, override_skip_reason: null, override_skip_detail: null, override_violated_rules: null })
  })

  it.each([
    [null, "confirmed", "documents_ready", "confirmed"],
    [null, null, "prepared", "prepared"],
    [null, "not_submitted", "documents_ready", "not_submitted"],
  ] as const)("@ac-E2.3 outcome %s, submission %s, state %s gives final status %s", async (outcome, submission, state, finalStatus) => {
    const { id } = await application({ outcome, submissionState: submission, state, documents: outcome !== null })
    await runAt(RUN)
    expect((await row(id)).final_status).toBe(finalStatus)
  })

  it("@ac-E2.4 the minimal record stays, is listed with deletedBy expiry, and still blocks a duplicate Application", async () => {
    const url = "https://boards.greenhouse.io/acme/jobs/1042"
    const { id, postingId } = await application({ requisition: "R-1042", url, outcome: "rejection" })
    await runAt(RUN)
    const records = minimalRecordsResponseSchema.parse((await (await fresh()).get(MINIMAL_RECORDS_PATH).expect(200)).body).records
    expect(records).toEqual([{ applicationId: id, company: "Acme Payments", applicationUrl: url, requisitionId: "R-1042", createdAt: "2025-10-20T08:15:00.000Z", detailsDeletedAt: "2026-10-20T02:00:00.000Z", finalStatus: "rejection", deletedBy: "expiry" }])
    const second = await (await fresh()).post(APPLICATIONS_PATH).send({ jobPostingId: postingId }).expect(200)
    expect(second.body).toMatchObject({ created: false, application: { id } })
  })

  it("@ac-E2.5 an expired Application refuses documents, submission and Outcomes", async () => {
    const { id } = await application({ requisition: "R-1042" })
    await runAt(RUN)
    await (await fresh()).post(`/v1/applications/${id}/documents/generate`).expect(409)
    await database.db.updateTable("application").set({ submission_state: "queued", submission_kind: "automatic" }).where("id", "=", id).execute()
    expect(await app.get(TenantDatabase).asOperator(() => app.get(SubmissionRepository).claim(id, "automatic", "2026-10-20", clock.now()))).toEqual({ refused: "not_claimable" })
    expect((await (await fresh()).post(applicationOutcomesPath(id)).send({ type: "interview_invitation" }).expect(409)).body).toMatchObject({ error: { code: "application_state_conflict" } })
  })

  it("@ac-E2.6 @D-E13 manual and automatic deletion of identical Applications leave identical rows; the sweep removes both files", async () => {
    const manual = await application({ requisition: "R-1042", details: true, submissionState: "confirmed" })
    const automatic = await application({ requisition: "R-1043", details: true, submissionState: "confirmed" })
    clock.set(RUN)
    // Manual first: the job then sees R-1042 already deleted and only R-1043 due.
    await (await fresh()).post(DELETE_DETAILS_PATH).send({ applicationIds: [manual.id] }).expect(200)
    const summary = await runner.run()
    expect(summary).toMatchObject({ due: 1, deleted: 1, filesReleased: 2 })
    const differing = new Set(["id", "job_posting_id", "application_url", "requisition_id", "details_deleted_by"])
    const strip = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).filter(([key]) => !differing.has(key)))
    const [m, a] = [await row(manual.id), await row(automatic.id)]
    expect(strip(a)).toEqual(strip(m))
    expect([m.details_deleted_by, a.details_deleted_by]).toEqual(["candidate", "expiry"])
    for (const table of ["tailored_document", "application_form_read", "outcome", "notification_outbox", "submission_event"] as const) {
      expect([await childCount(table, manual.id), await childCount(table, automatic.id)]).toEqual([0, 0])
    }
    const postings = await database.db
      .selectFrom("job_posting")
      .innerJoin("candidate_posting", "candidate_posting.job_posting_id", "job_posting.id")
      .select(["job_posting.title", "job_posting.company", "candidate_posting.status", "job_posting.role_family"])
      .where("job_posting.id", "in", [manual.postingId, automatic.postingId])
      .execute()
    expect(postings[0]).toEqual(postings[1])
    // Manual unlinked at once; the job's files wait for the api sweep.
    const before = await readdir(storage)
    expect(before).not.toEqual(expect.arrayContaining(manual.files))
    expect(before).toEqual(expect.arrayContaining(automatic.files))
    await sweep.sweep()
    const after = await readdir(storage)
    for (const file of [...manual.files, ...automatic.files]) expect(after).not.toContain(file)
  })

  it("@ac-E2.1 D-E10 keeps posting text, Eligibility, Match evidence, AI calls, spend and Candidate settings", async () => {
    const { id, postingId } = await application({ requisition: "R-1042" })
    await database.db.insertInto("eligibility_result").values({ candidate_id: database.operatorId, job_posting_id: postingId, arrangement: "remote", relocation_country: null, employment_type: "direct", rules: "[]", eligible: true, normalized_monthly_max_usd: null, fx_rate_date: null, evaluated_at: clock.now() }).execute()
    await database.db.insertInto("spend_month").values({ month: "2026-10-01", ceiling_micros: 50_000_000, raised_at: null, created_at: clock.now() }).onConflict((oc) => oc.column("month").doNothing()).execute()
    await database.db.insertInto("spend_entry").values({ id: randomUUID(), month: "2026-10-01", category: "ai", sub_budget: null, purpose: "seed", status: "settled", reserved_micros: 1, actual_micros: 1, application_id: id, attempt_id: null, created_at: clock.now(), settled_at: clock.now() }).execute()
    await database.db.insertInto("existing_application").values({ id: randomUUID(), candidate_id: database.operatorId, company: "Globex", role_title: "Engineer", application_url: "https://globex.test/1", requisition_id: null, applied_on: "2026-01-01", created_at: clock.now() }).execute()
    await runAt(RUN)
    expect(await database.db.selectFrom("job_posting").select("title").where("id", "=", postingId).executeTakeFirst()).toEqual({ title: "Senior Backend Engineer" })
    expect(await database.db.selectFrom("eligibility_result").select("eligible").where("job_posting_id", "=", postingId).execute()).toHaveLength(1)
    expect(await database.db.selectFrom("spend_entry").select("id").where("application_id", "=", id).execute()).toHaveLength(1)
    expect(await database.db.selectFrom("existing_application").select("company").execute()).toEqual([{ company: "Globex" }])
  })
})

describe("E3 when it runs and what it skips", () => {
  it("@ac-E3.2 catches up Applications missed by earlier runs and keeps one due tomorrow", async () => {
    const ids = [
      (await application({ requisition: "R-1042", created: "2025-10-17T10:00:00+01:00" })).id,
      (await application({ requisition: "L-77", created: "2025-10-18T10:00:00+01:00" })).id,
      (await application({ requisition: "A-9", created: "2025-10-20T10:00:00+01:00" })).id,
    ]
    const tomorrow = await application({ requisition: "B-5", created: "2025-10-21T10:00:00+01:00" })
    const summary = await runAt(RUN)
    expect(summary).toMatchObject({ outcome: "completed", due: 3, deleted: 3 })
    for (const id of ids) expect(await deleted(id)).toBe(true)
    expect(await deleted(tomorrow.id)).toBe(false)
  })

  it("@ac-E3.3 @D-E3 the global pause stops the run; the first run after it catches up", async () => {
    const { id } = await application({ requisition: "R-1042" })
    await setPause(true)
    for (const day of ["2026-10-20", "2026-10-21", "2026-10-22"]) expect((await runAt(`${day}T03:00:00+01:00`)).outcome).toBe("skipped_global_paused")
    expect(await deleted(id)).toBe(false)
    const rows = await database.db.selectFrom("retention_run").select([sql<string>`wat_date::text`.as("d"), "outcome"]).where("outcome", "=", "skipped_global_paused").orderBy("wat_date").execute()
    expect(rows.map((r) => r.d)).toEqual(["2026-10-20", "2026-10-21", "2026-10-22"])
    await setPause(false)
    await runAt("2026-10-23T03:00:00+01:00")
    expect(await deleted(id)).toBe(true)
  })

  it("@ac-E3.3 a global pause turned on during the run stops later batches; the first 100 stay deleted", async () => {
    for (let i = 0; i < 250; i++) await application({ created: new Date(Date.parse("2025-01-01T00:00:00Z") + i * 60_000).toISOString(), documents: false })
    let reads = 0
    const original = runner["globalPaused"].bind(runner)
    vi.spyOn(runner as unknown as { globalPaused: () => Promise<boolean> }, "globalPaused").mockImplementation(async () => {
      reads++
      // Read 1: start of the run. Read 2: before batch 2. Turn the pause on between them.
      if (reads === 2) await setPause(true)
      return original()
    })
    const summary = await runAt(RUN)
    expect(summary.deleted).toBe(100)
    const live = await database.db.selectFrom("application").select(sql<number>`count(*)::int`.as("n")).where("details_deleted_at", "is", null).executeTakeFirstOrThrow()
    expect(live.n).toBe(150)
  })

  it("@ac-E3.4 the cost pause does not stop the run, and the run reserves no spend", async () => {
    const { id } = await application({ requisition: "R-1042" })
    await database.db.updateTable("control_state").set({ cost_paused: true }).execute()
    await runAt(RUN)
    expect(await deleted(id)).toBe(true)
    expect(await database.db.selectFrom("spend_entry").select("id").execute()).toEqual([])
    expect(await database.db.selectFrom("ai_call").select("id").execute()).toEqual([])
  })

  it.each([
    ["generating documents", { state: "generating" as const }],
    ["claimed for submission", { submissionState: "submit_claimed" }],
    ["being submitted in the browser", { submissionState: "submitting" }],
  ])("@ac-E3.5 @ac-E3.7 an Application %s is skipped as in flight and deleted after it finishes", async (_name, seed) => {
    const { id } = await application({ requisition: "R-1042", ...seed })
    expect(await runAt(RUN)).toMatchObject({ due: 1, deleted: 0, skippedInFlight: 1, skippedLocked: 0 })
    expect(await deleted(id)).toBe(false)
    await database.db.updateTable("application").set({ state: "documents_ready", submission_state: "confirmed" }).where("id", "=", id).execute()
    await runAt("2026-10-21T03:00:00+01:00")
    expect(await row(id)).toMatchObject({ final_status: "interview_invitation", details_deleted_by: "expiry" })
  })

  it.each([
    ["an Uncertain Submission", { submissionState: "uncertain" }, { submission_state: "confirmed" }],
    ["a Blocked Application", { submissionState: "blocked" }, { submission_state: "declined" }],
    ["queued for submission", { submissionState: "queued" }, { submission_state: null, submission_kind: null }],
    ["a sample awaiting review", { sampleState: "awaiting_review" }, { sample_state: "rejected" }],
  ])("@ac-E3.6 @D-E9 %s is skipped as pending decision, and deleted on the first run after it is resolved", async (_name, seed, resolution) => {
    const { id } = await application({ requisition: "R-1042", ...seed })
    expect(await runAt(RUN)).toMatchObject({ deleted: 0, skippedPendingDecision: 1 })
    expect(await runAt("2026-10-21T03:00:00+01:00")).toMatchObject({ deleted: 0, skippedPendingDecision: 1 })
    await database.db.updateTable("application").set(resolution as never).where("id", "=", id).execute()
    await runAt("2026-10-22T03:00:00+01:00")
    expect(await deleted(id)).toBe(true)
  })

  it("@ac-E3.7 skipped Applications do not stop the rest of the run", async () => {
    const a = await application({ requisition: "R-1042" })
    await application({ requisition: "L-77", state: "generating" })
    await application({ requisition: "A-9", submissionState: "blocked" })
    const b = await application({ requisition: "B-5" })
    expect(await runAt(RUN)).toMatchObject({ due: 4, deleted: 2, skippedInFlight: 1, skippedPendingDecision: 1, skippedLocked: 0, failed: 0 })
    expect([await deleted(a.id), await deleted(b.id)]).toEqual([true, true])
  })

  // NEW-3 (code review): a Run that claims its Application after the batch's snapshot
  // used to roll the whole batch back and exclude every row in it, so up to 99 due
  // Applications were reported `skippedLocked` for the day. Only the row with the Run
  // is excluded now; the rest of that batch is still expired in the same run.
  it("NEW-3 one Application that gained a Run in flight after the batch snapshot does not starve the rest of its batch", async () => {
    const busy = await application({ requisition: "R-BUSY", documents: false })
    const others = [await application({ requisition: "R-1", documents: false }), await application({ requisition: "R-2", documents: false }), await application({ requisition: "R-3", documents: false })]
    // Idle at the batch's snapshot, so the batch selects it; the claim below commits after that read.
    await database.db
      .insertInto("outreach_message")
      .values({ id: randomUUID(), candidate_id: database.operatorId, application_id: busy.id, kind: "referral_request", created_at: new Date(RUN), updated_at: new Date(RUN) })
      .execute()
    const shared = runner.deleteDetails
    let staged = false
    runner.deleteDetails = async (trx, candidateId, rows, now, by) => {
      if (!staged && rows.some((row) => row.id === busy.id)) {
        staged = true
        await database.db
          .updateTable("outreach_message")
          .set({ run_status: "running", run_id: randomUUID(), run_started_at: now })
          .where("application_id", "=", busy.id)
          .execute()
        throw new OutreachRunInFlightError()
      }
      return shared(trx, candidateId, rows, now, by)
    }
    let summary
    try {
      summary = await runAt(RUN)
    } finally {
      runner.deleteDetails = shared
    }
    expect(summary).toMatchObject({ outcome: "completed", due: 4, deleted: 3, skippedInFlight: 1, skippedLocked: 0, failed: 0 })
    for (const { id } of others) expect(await deleted(id)).toBe(true)
    expect(await deleted(busy.id)).toBe(false)
    // The busy row keeps its Outreach row and is the only due one left.
    expect(await database.db.selectFrom("outreach_message").select("application_id").execute()).toEqual([{ application_id: busy.id }])
  })

  it("@ac-E3.6 manual deletion does not wait for a pending decision and records candidate", async () => {
    const { id } = await application({ requisition: "R-1042", submissionState: "blocked" })
    await (await fresh()).post(DELETE_DETAILS_PATH).send({ applicationIds: [id] }).expect(200)
    expect((await row(id)).details_deleted_by).toBe("candidate")
  })
})

describe("E4 idempotency, concurrency and failure", () => {
  it("@ac-E4.1 running twice the same day deletes nothing the second time and keeps the first deletion time", async () => {
    const ids = [(await application({ requisition: "R-1042" })).id, (await application({ requisition: "L-77" })).id]
    await runAt(RUN)
    expect(await runAt("2026-10-20T11:00:00+01:00")).toMatchObject({ due: 0, deleted: 0 })
    for (const id of ids) expect((await row(id)).details_deleted_at).toEqual(new Date(RUN))
  })

  it.each([
    ["a manual deletion (FOR UPDATE)", "update"],
    ["an Outcome insert (FOR SHARE)", "share"],
  ] as const)("@ac-E4.2 a row held by %s is skipped without waiting, counted locked, and still due tomorrow", async (_name, mode) => {
    const held = await application({ requisition: "R-1042" })
    const free = await application({ requisition: "L-77" })
    const started = Date.now()
    const summary = await database.db.transaction().execute(async (trx) => {
      const query = trx.selectFrom("application").select("id").where("id", "=", held.id)
      await (mode === "update" ? query.forUpdate() : query.forShare()).execute()
      return runAt(RUN)
    })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(summary).toMatchObject({ due: 2, deleted: 1, skippedLocked: 1, failed: 0, outcome: "completed" })
    expect([await deleted(held.id), await deleted(free.id)]).toEqual([false, true])
    expect(await runAt("2026-10-21T03:00:00+01:00")).toMatchObject({ deleted: 1 })
  })

  it("@ac-E4.2 an Application the Candidate deleted first is not counted", async () => {
    const { id } = await application({ requisition: "R-1042" })
    await (await fresh()).post(DELETE_DETAILS_PATH).send({ applicationIds: [id] }).expect(200)
    expect(await runAt(RUN)).toMatchObject({ due: 0, deleted: 0, skippedLocked: 0, failed: 0 })
    expect((await row(id)).details_deleted_by).toBe("candidate")
  })

  it.each([
    [1, 1],
    [100, 1],
    [101, 2],
    [250, 3],
  ])("@ac-E4.3 %d due Applications are deleted in %d batches of at most 100", async (count, batches) => {
    for (let i = 0; i < count; i++) await application({ created: new Date(Date.parse("2025-01-01T00:00:00Z") + i * 60_000).toISOString(), documents: false })
    expect(await runAt(RUN)).toMatchObject({ due: count, deleted: count, batches, outcome: "completed" })
  })

  it("@ac-E4.3 @ac-E6.3 a failed batch rolls back alone, later batches run, and only its ids are logged", async () => {
    const ids: string[] = []
    for (let i = 0; i < 250; i++) ids.push((await application({ created: new Date(Date.parse("2025-01-01T00:00:00Z") + i * 60_000).toISOString(), documents: false })).id)
    await sql`create table retention_test_fail (id uuid primary key)`.execute(database.db)
    await sql`insert into retention_test_fail values (${ids[150]!})`.execute(database.db)
    await sql`create function retention_test_fail_fn() returns trigger language plpgsql security definer as $$
      begin if exists (select 1 from retention_test_fail where id = new.id) then raise exception 'forced'; end if; return new; end $$`.execute(database.db)
    await sql`create trigger retention_test_fail_tg before update on application for each row execute function retention_test_fail_fn()`.execute(database.db)
    const warnings: string[] = []
    const infos: string[] = []
    vi.spyOn(Logger.prototype, "warn").mockImplementation((message: unknown) => void warnings.push(String(message)))
    vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => void infos.push(String(message)))
    try {
      expect(await runAt(RUN)).toMatchObject({ due: 250, deleted: 150, failed: 100, skippedLocked: 0, outcome: "failed" })
    } finally {
      await sql`drop trigger retention_test_fail_tg on application`.execute(database.db)
      await sql`drop function retention_test_fail_fn()`.execute(database.db)
      await sql`drop table retention_test_fail`.execute(database.db)
    }
    for (let i = 0; i < 250; i++) expect(await deleted(ids[i]!)).toBe(i < 100 || i >= 200)
    const failedWarning = warnings.find((w) => w.includes("batch of 100 failed"))!
    for (const id of ids.slice(100, 200)) expect(failedWarning).toContain(id)
    for (const id of [...ids.slice(0, 100), ...ids.slice(200)]) expect([...warnings, ...infos].join("\n")).not.toContain(id)
    const run = await database.db.selectFrom("retention_run").selectAll().where("outcome", "=", "failed").executeTakeFirstOrThrow()
    expect(run).toMatchObject({ due_count: 250, deleted_count: 150, failed_count: 100 })
    // The next run picks up the batch that failed (E4.5).
    expect(await runAt("2026-10-21T03:00:00+01:00")).toMatchObject({ deleted: 100, outcome: "completed" })
  })
})

describe("E4.6 launch grace (D-E5)", () => {
  beforeEach(async () => {
    await database.db.deleteFrom("retention_run").execute()
  })

  it("nothing is deleted for 30 days from the first run; grace runs record would-be-due counts; then the backlog goes", async () => {
    const ids: string[] = []
    for (let i = 0; i < 12; i++) ids.push((await application({ created: new Date(Date.parse("2024-01-05T10:00:00Z") + i * 30 * 86_400_000).toISOString(), documents: false })).id)
    expect(await runAt("2026-11-01T03:00:00+01:00")).toMatchObject({ outcome: "skipped_launch_grace", due: 12, deleted: 0 })
    expect(await runAt("2026-11-30T03:00:00+01:00")).toMatchObject({ outcome: "skipped_launch_grace", due: 12, deleted: 0 })
    for (const id of ids) expect(await deleted(id)).toBe(false)
    expect(await runAt("2026-12-01T03:00:00+01:00")).toMatchObject({ outcome: "completed", due: 12, deleted: 12 })
  })

  it("a first run during the global pause still starts the grace; the endpoint reports its end", async () => {
    await setPause(true)
    expect((await runAt("2026-11-01T03:00:00+01:00")).outcome).toBe("skipped_global_paused")
    clock.set("2026-11-10T12:00:00+01:00")
    expect(retentionResponseSchema.parse((await (await fresh()).get(RETENTION_PATH).expect(200)).body).graceEndsOn).toBe("2026-12-01")
  })

  it("an expiry date inside the grace reads as the grace end on the Application", async () => {
    await firstRanOn("2026-11-01")
    clock.set("2026-11-10T12:00:00+01:00")
    const { id } = await application({ created: "2025-11-15T10:00:00+01:00", documents: false })
    const later = await application({ created: "2025-12-02T10:00:00+01:00", documents: false })
    expect(applicationDetailSchema.parse((await (await fresh()).get(`/v1/applications/${id}`).expect(200)).body).expiresOn).toBe("2026-12-01")
    expect(applicationDetailSchema.parse((await (await fresh()).get(`/v1/applications/${later.id}`).expect(200)).body).expiresOn).toBe("2026-12-02")
  })
})

describe("E4.4 the api document sweep (D-E4)", () => {
  async function file(name: string, modified: Date): Promise<void> {
    await writeFile(join(storage, name), "x")
    await utimes(join(storage, name), modified, modified)
  }

  it("removes unreferenced storage files older than 24 h; keeps younger, referenced, non-matching and symlinked ones", async () => {
    const day = 24 * 60 * 60 * 1000
    const old = "9d1c2e4a-0b7f-4c1e-9a3d-5f6e7a8b9c0d.pdf"
    const young = "9d1c2e4a-0b7f-4c1e-9a3d-5f6e7a8b9c0d.docx"
    await file(old, new Date(Date.now() - day - 1_000))
    await file(young, new Date(Date.now() - day + 60_000))
    await file("notes.txt", new Date("2026-09-01"))
    await file(".keep", new Date("2026-09-01"))
    const target = join(tmpdir(), `ja-sweep-target-${randomUUID()}`)
    await writeFile(target, "outside")
    await symlink(target, join(storage, "1d1c2e4a-0b7f-4c1e-9a3d-5f6e7a8b9c0d.pdf"))
    const { files } = await application({ requisition: "L-77" })
    const result = await sweep.sweep()
    const left = await readdir(storage)
    expect(left).not.toContain(old)
    expect(left).toEqual(expect.arrayContaining([young, "notes.txt", ".keep", "1d1c2e4a-0b7f-4c1e-9a3d-5f6e7a8b9c0d.pdf", ...files]))
    expect(result).toMatchObject({ removed: 1, failed: 0 })
    await rm(target, { force: true })
  })

  it("keeps a name a Tailored Document starts referencing between the listing and the unlink", async () => {
    const name = "9d1c2e4a-0b7f-4c1e-9a3d-5f6e7a8b9c0d.pdf"
    await file(name, OLD_FILE_TIME)
    const { id } = await application({ documents: false })
    const original = sweep["referenced"].bind(sweep)
    let calls = 0
    vi.spyOn(sweep as unknown as { referenced: (candidateId: string, names: readonly string[]) => Promise<Set<string>> }, "referenced").mockImplementation(async (candidateId, names) => {
      calls++
      if (calls === 2) {
        await database.db.insertInto("tailored_document").values({ id: randomUUID(), candidate_id: database.operatorId, application_id: id, kind: "resume", career_profile_version: 1, content: "{}", pdf_storage_name: name, docx_storage_name: "0d1c2e4a-0b7f-4c1e-9a3d-5f6e7a8b9c0d.docx", pdf_sha256: "x", docx_sha256: "x", created_at: clock.now() }).execute()
      }
      return original(candidateId, names)
    })
    await sweep.sweep()
    expect(await readdir(storage)).toContain(name)
  })

  it("a file that cannot be removed: the other is removed, one counts line, the database is untouched", async () => {
    const { id, files } = await application({ requisition: "R-1042" })
    await runAt(RUN)
    const before = await row(id)
    const logs: string[] = []
    vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => void logs.push(String(message)))
    vi.spyOn(sweep as unknown as { removeFile: (candidateId: string, name: string) => Promise<void> }, "removeFile").mockImplementation(async (_candidateId, name) => {
      if (name === files[0]) throw Object.assign(new Error("EACCES"), { code: "EACCES" })
      await rm(join(storage, name))
    })
    expect(await sweep.sweep()).toMatchObject({ removed: 1, failed: 1 })
    expect(await readdir(storage)).toEqual([files[0]])
    expect(logs.filter((line) => line.startsWith("Document sweep"))).toEqual([expect.stringMatching(/removed 1, not removed 1/)])
    expect(await row(id)).toEqual(before)
  })

  it("an unreadable directory changes nothing and logs counts only; a sweep that removes nothing logs nothing", async () => {
    const logs: string[] = []
    vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => void logs.push(String(message)))
    await application({ requisition: "L-77" })
    expect(await sweep.sweep()).toMatchObject({ removed: 0, failed: 0 })
    expect(logs.filter((line) => line.startsWith("Document sweep"))).toEqual([])
    await chmod(storage, 0o000)
    const unreadable = sweep
    const warnings: string[] = []
    vi.spyOn(Logger.prototype, "warn").mockImplementation((message: unknown) => void warnings.push(String(message)))
    try {
      expect(await unreadable.sweep()).toMatchObject({ skipped: "unreadable" })
    } finally {
      await chmod(storage, 0o700)
    }
    expect(warnings.join("\n")).not.toContain(storageRoot)
  })

  it("two concurrent sweeps make one removal pass (advisory lock)", async () => {
    await file("9d1c2e4a-0b7f-4c1e-9a3d-5f6e7a8b9c0d.pdf", OLD_FILE_TIME)
    const results = await Promise.all([sweep.sweep(), sweep.sweep()])
    expect(results.map((r) => r.removed).sort()).toEqual([0, 1])
  })
})

describe("E5 what the Candidate sees", () => {
  it("@ac-E5.2 @ac-E5.6 GET /v1/retention reports due-in-30-days, earliest date, and no failure", async () => {
    clock.set("2026-10-20T12:00:00+01:00")
    for (const created of ["2025-10-24", "2025-11-03", "2025-11-19", "2025-11-20"]) await application({ created: `${created}T10:00:00+01:00`, documents: false })
    const body = retentionResponseSchema.parse((await (await fresh()).get(RETENTION_PATH).expect(200)).body)
    expect(body).toEqual({ rule: { months: 12 }, dueNext30Days: { count: 3, earliestOn: "2026-10-24" }, overdueDue: { count: 0 }, waitingForDecision: { count: 0 }, graceEndsOn: null, lastRun: { watDate: "2026-06-01", outcome: "completed", deletedCount: 0 }, lastFailure: null })
  })

  it("@ac-E5.2 empty: no Applications gives count 0 and no earliest date", async () => {
    const body = retentionResponseSchema.parse((await (await fresh()).get(RETENTION_PATH).expect(200)).body)
    expect(body.dueNext30Days).toEqual({ count: 0, earliestOn: null })
  })

  it("@ac-E5.6 overdue counts a live, not-busy row past its date (locked during runs)", async () => {
    clock.set("2026-12-01T12:00:00+01:00")
    await application({ created: "2025-11-30T10:00:00+01:00", documents: false })
    await application({ created: "2025-11-30T10:00:00+01:00", documents: false, state: "generating" })
    expect(retentionResponseSchema.parse((await (await fresh()).get(RETENTION_PATH).expect(200)).body).overdueDue).toEqual({ count: 1 })
  })

  it.each([
    ["2026-11-18T12:00:00+01:00", 0],
    ["2026-11-19T12:00:00+01:00", 1],
  ])("@ac-E5.5 @ac-E5.8 a Blocked Application expiring 2026-10-20 on %s is waiting %d", async (now, count) => {
    await application({ requisition: "R-1042", submissionState: "blocked", documents: false })
    clock.set(now)
    const body = retentionResponseSchema.parse((await (await fresh()).get(RETENTION_PATH).expect(200)).body)
    expect(body.waitingForDecision.count).toBe(count)
    expect(body.dueNext30Days.count).toBe(0)
  })

  it.each([
    ["2026-10-20T03:59:59+01:00", null],
    ["2026-10-20T04:00:01+01:00", "2026-10-20"],
  ])("@ac-E4.5 @ac-E6.4 a run left running since 03:00, read at %s, reports failure %s", async (now, failure) => {
    await database.db.insertInto("retention_run").values({ candidate_id: database.operatorId, id: randomUUID(), wat_date: "2026-10-20", started_at: new Date(RUN), finished_at: null, outcome: "running" }).execute()
    clock.set(now)
    expect(retentionResponseSchema.parse((await (await fresh()).get(RETENTION_PATH).expect(200)).body).lastFailure).toEqual(failure === null ? null : { watDate: failure })
  })

  it("@ac-E6.4 a failure shows until a later run completes; a paused run does not clear it", async () => {
    const add = (day: string, outcome: "failed" | "completed" | "skipped_global_paused") =>
      database.db.insertInto("retention_run").values({ candidate_id: database.operatorId, id: randomUUID(), wat_date: day, started_at: new Date(`${day}T02:00:00Z`), finished_at: new Date(`${day}T02:01:00Z`), outcome }).execute()
    await add("2026-10-20", "failed")
    clock.set("2026-10-20T12:00:00+01:00")
    expect(retentionResponseSchema.parse((await (await fresh()).get(RETENTION_PATH).expect(200)).body).lastFailure).toEqual({ watDate: "2026-10-20" })
    await add("2026-10-21", "skipped_global_paused")
    clock.set("2026-10-21T12:00:00+01:00")
    expect(retentionResponseSchema.parse((await (await fresh()).get(RETENTION_PATH).expect(200)).body).lastFailure).toEqual({ watDate: "2026-10-20" })
    await add("2026-10-22", "completed")
    clock.set("2026-10-22T12:00:00+01:00")
    const body = retentionResponseSchema.parse((await (await fresh()).get(RETENTION_PATH).expect(200)).body)
    expect(body.lastFailure).toBeNull()
    expect(body.lastRun).toEqual({ watDate: "2026-10-22", outcome: "completed", deletedCount: 0 })
  })

  it("@ac-E5.2 @ac-E5.6 expiresOn is the WAT date while details exist and null after deletion", async () => {
    const { id } = await application({ requisition: "R-1042", created: "2025-10-19T23:30:00Z", documents: false })
    clock.set("2026-10-01T12:00:00+01:00")
    expect(applicationDetailSchema.parse((await (await fresh()).get(`/v1/applications/${id}`).expect(200)).body).expiresOn).toBe("2026-10-20")
    const list = applicationsResponseSchema.parse((await (await fresh()).get(APPLICATIONS_PATH).expect(200)).body).applications
    expect(list.find((a) => a.id === id)?.expiresOn).toBe("2026-10-20")
    await runAt(RUN)
    expect(applicationDetailSchema.parse((await (await fresh()).get(`/v1/applications/${id}`).expect(200)).body).expiresOn).toBeNull()
  })

  it("@ac-E5.3 @ac-E6.1 minimal records say who deleted them; a null value reads as candidate", async () => {
    const mine = await application({ requisition: "L-77" })
    const auto = await application({ requisition: "R-1042" })
    const legacy = await application({ requisition: "B-5", created: "2026-01-01T10:00:00+01:00" })
    clock.set("2026-03-02T10:00:00+01:00")
    await (await fresh()).post(DELETE_DETAILS_PATH).send({ applicationIds: [mine.id, legacy.id] }).expect(200)
    await database.db.updateTable("application").set({ details_deleted_by: null }).where("id", "=", legacy.id).execute()
    await runAt(RUN)
    const records = minimalRecordsResponseSchema.parse((await (await fresh()).get(MINIMAL_RECORDS_PATH).expect(200)).body).records
    expect(Object.fromEntries(records.map((r) => [r.requisitionId, r.deletedBy]))).toEqual({ "L-77": "candidate", "R-1042": "expiry", "B-5": "candidate" })
    expect(auto.id).toBeTruthy()
  })

  it("@ac-E5.7 @D-E11 ?retention=due lists exactly the due count, earliest first", async () => {
    clock.set("2026-10-20T12:00:00+01:00")
    const r = await application({ requisition: "R-1042", created: "2025-11-03T10:00:00+01:00", documents: false })
    const l = await application({ requisition: "L-77", created: "2025-10-24T10:00:00+01:00", documents: false })
    const a = await application({ requisition: "A-9", created: "2025-11-19T10:00:00+01:00", documents: false })
    await application({ requisition: "B-5", created: "2025-11-20T10:00:00+01:00", documents: false })
    const list = applicationsResponseSchema.parse((await (await fresh()).get(`${APPLICATIONS_PATH}?retention=due`).expect(200)).body).applications
    expect(list.map((x) => x.id)).toEqual([l.id, r.id, a.id])
  })

  it("@ac-E5.7 @ac-E5.5 ?retention=waiting lists exactly the waiting count, earliest first, and not an in-flight one", async () => {
    clock.set("2026-12-01T12:00:00+01:00")
    const l = await application({ requisition: "L-77", created: "2025-10-25T10:00:00+01:00", submissionState: "blocked", documents: false })
    const r = await application({ requisition: "R-1042", created: "2025-10-20T10:00:00+01:00", submissionState: "uncertain", documents: false })
    await application({ requisition: "A-9", created: "2025-11-15T10:00:00+01:00", submissionState: "queued", documents: false })
    await application({ requisition: "C-3", created: "2025-10-20T10:00:00+01:00", state: "generating", documents: false })
    const list = applicationsResponseSchema.parse((await (await fresh()).get(`${APPLICATIONS_PATH}?retention=waiting`).expect(200)).body).applications
    expect(list.map((x) => x.id)).toEqual([r.id, l.id])
    expect(retentionResponseSchema.parse((await (await fresh()).get(RETENTION_PATH).expect(200)).body).waitingForDecision.count).toBe(2)
  })

  it.each([["overdue"], ["DUE"], [""], ["due,waiting"], ["due&retention=waiting"]])("@ac-E5.7 an unknown retention value %j gives the full list with no error", async (value) => {
    await application({ requisition: "R-1042", created: "2026-05-01T10:00:00+01:00", documents: false })
    await application({ requisition: "L-77", created: "2026-05-02T10:00:00+01:00", documents: false })
    const list = applicationsResponseSchema.parse((await (await fresh()).get(`${APPLICATIONS_PATH}?retention=${value}`).expect(200)).body).applications
    expect(list.map((x) => x.requisitionId)).toEqual(["L-77", "R-1042"])
  })

  it("@ac-E5.7 an empty filtered list is 200 with no Applications", async () => {
    expect(applicationsResponseSchema.parse((await (await fresh()).get(`${APPLICATIONS_PATH}?retention=waiting`).expect(200)).body).applications).toEqual([])
  })

  it("@ac-E5.4 @D-E7 the daily summary facts carry that WAT day's deleted count, and 0 on a day with none", async () => {
    for (let i = 0; i < 3; i++) await application({ documents: false })
    await runAt(RUN)
    const repository = app.get(NotificationRepository)
    const tenant = app.get(TenantDatabase)
    expect((await tenant.asOperator(() => repository.dailySummaryFacts("2026-10-20"))).retentionDeleted).toBe(3)
    expect((await tenant.asOperator(() => repository.dailySummaryFacts("2026-10-21"))).retentionDeleted).toBe(0)
  })

  it("@permission an unauthenticated request gets no retention counts; no route starts or stops the job", async () => {
    const response = await anonymous.http().get(RETENTION_PATH).expect(401)
    expect(response.body).not.toHaveProperty("dueNext30Days")
    await (await fresh()).post(RETENTION_PATH).send({}).expect(404)
    await (await fresh()).put(RETENTION_PATH).send({ enabled: false }).expect(404)
  })
})

describe("E6 audit and logging", () => {
  it("@ac-E6.2 one run row per run with times and every count, and no career data", async () => {
    const r = await application({ requisition: "R-1042", company: "Acme Payments", url: "https://boards.greenhouse.io/acme/jobs/1042" })
    await application({ requisition: "L-77", state: "generating", documents: false })
    await application({ requisition: "A-9", submissionState: "blocked", documents: false })
    const b = await application({ requisition: "B-5", documents: false })
    await application({ requisition: "C-3" })
    const infos: string[] = []
    vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => void infos.push(String(message)))
    await database.db.transaction().execute(async (trx) => {
      await trx.selectFrom("application").select("id").where("id", "=", b.id).forUpdate().execute()
      await runAt(RUN)
    })
    await sweep.sweep()
    const run = await database.db.selectFrom("retention_run").selectAll().where("outcome", "=", "completed").where(sql<boolean>`wat_date = '2026-10-20'`).executeTakeFirstOrThrow()
    expect(run).toMatchObject({ due_count: 5, deleted_count: 2, skipped_in_flight: 1, skipped_pending_decision: 1, skipped_locked: 1, failed_count: 0, files_released: 4 })
    expect(run.started_at).toEqual(new Date(RUN))
    expect(run.finished_at).not.toBeNull()
    const text = JSON.stringify(run) + infos.join("\n")
    for (const secret of ["Acme Payments", "Senior Backend Engineer", "https://boards.greenhouse.io/acme/jobs/1042", "R-1042", r.id, ...r.files]) expect(text).not.toContain(secret)
    expect(infos).toContain("Retention 2026-10-20: completed, due 5, deleted 2, in flight 1, pending decision 1, locked 1, failed 0, files released 4")
    const columns = await sql<{ column_name: string; data_type: string }>`select column_name, data_type from information_schema.columns where table_name = 'retention_run'`.execute(database.db)
    expect(columns.rows.filter((c) => c.data_type === "text").map((c) => c.column_name)).toEqual(["outcome"])
  })

  it("@empty-state a run with nothing due completes with a zero row", async () => {
    await application({ created: "2025-10-21T10:00:00+01:00", documents: false })
    expect(await runAt(RUN)).toMatchObject({ outcome: "completed", due: 0, deleted: 0 })
    await database.db.deleteFrom("application").execute()
    expect(await runAt("2026-10-21T03:00:00+01:00")).toMatchObject({ outcome: "completed", due: 0 })
  })
})
