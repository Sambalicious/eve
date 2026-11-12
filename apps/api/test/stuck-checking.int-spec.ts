import type { INestApplication, INestApplicationContext } from "@nestjs/common"
import { Logger } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { CSRF_HEADER, JOB_CRITERIA_PATH, JOB_POSTINGS_CHECK_AGAIN_PATH, checkAgainResponseSchema, jobPostingStatusSchema } from "@eve/contracts"
import { sql } from "kysely"
import { HttpResponse, http } from "msw"
import pg from "pg"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { anthropicConfig } from "../src/config/env.js"
import { CandidateScope } from "../src/db/candidate-scope.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { DiscoveryPipeline } from "../src/discovery/discovery-pipeline.js"
import { DiscoveryRepository, evaluationLockKey } from "../src/discovery/discovery.repository.js"
import { DiscoveryService } from "../src/discovery/discovery.service.js"
import { STUCK_AFTER_MS, evaluationLockKeySql, stuckSql } from "../src/discovery/stuck.js"
import { CLOCK } from "../src/shared/clock.js"
import { DiscoveryJobs, EVALUATE_POSTING } from "../src/worker/discovery-jobs.js"
import { JobQueue } from "../src/worker/job-queue.js"
import { WorkerHeartbeat } from "../src/worker/worker-heartbeat.js"
import { WorkerModule } from "../src/worker/worker.module.js"
import { Browser } from "./support/browser.js"
import {
  DEFAULT_TARGETS,
  checkingSinceOf,
  clearPostings,
  hold,
  insertPosting,
  list,
  queuedEvaluations,
  resetCriteria,
  seed,
  signInSecondCandidate,
  statusOf,
} from "./support/epic-0006.js"
import { FakeAnthropic, OutboundRecorder } from "./support/fake-anthropic.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_ANTHROPIC_KEY, TEST_ANTHROPIC_MODEL, TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp, migratedStorageRoot } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0006 PRD r4 stuck `checking` recovery (AC-7.3 widened, AC-7.10 stuck row,
 * AC-7.11 to AC-7.16, P18, P19; architecture-stuck-checking.md). Source:
 * gherkin/stuck-checking-recovery.feature. Each case names its feature line.
 *
 * Real api (HTTP list and Check again, pg-boss inserts in the claim
 * transaction) and the real worker providers (DiscoveryJobs, PostingEvaluator,
 * ModelGateway, SpendLedger) on one Postgres database. The worker module is
 * compiled but not started: its JobQueue records `sendForCandidate` instead of
 * talking to pg-boss, so no job runs on its own and every job a test counts is
 * run explicitly through `DiscoveryJobs.evaluateJob` (the worker's own path:
 * CandidateJobRunner, D13 check, evaluator). Anthropic is the MSW fake.
 *
 * "Evaluation running and holding the lock" is a second session that holds the
 * evaluator's advisory lock (`evaluationLockKey`), exactly what
 * `exclusiveEvaluation` takes.
 *
 * Gherkin clock: 2026-10-29, 10:00:00 WAT unless a case says otherwise.
 */
let database: TestDatabase
let google: FakeGoogle
let anthropic: FakeAnthropic
let outbound: OutboundRecorder
let app: INestApplication
let worker: INestApplicationContext
let ada: SignedInCandidate
let kofi: SignedInCandidate
let adaId: string
let kofiId: string
let locker: pg.Client

/** 2026-10-29 at `time` WAT ("HH:MM:SS"). */
const at = (time: string, date = "2026-10-29") => new Date(`${date}T${time}+01:00`)
const NOW = at("10:00:00")
const clock = new TestClock(NOW)

type Sent = { candidateId: string; postingId: string }
const sent: Sent[] = []
const recordingQueue = {
  sendForCandidate: async (_queue: unknown, candidateId: string, data: { postingId: string }) => {
    sent.push({ candidateId, postingId: data.postingId })
    return "recorded"
  },
  sendShared: async () => "recorded",
  createQueue: async () => undefined,
  schedule: async () => undefined,
  unschedule: async () => undefined,
  workShared: async () => "recorded",
}

const SECTIONS = [
  { id: "s1", kind: "experience", title: "Senior Frontend Engineer", organization: "Brightwave Ltd", period: "2021-2024", sourceQuote: null, facts: [{ id: "F1", text: "Built React features", sourceQuote: null }] },
]
const STRONG = {
  workArrangement: "remote",
  locationQuote: "Remote, open to candidates in Nigeria",
  relocationCountry: null,
  relocationQuote: null,
  sponsorshipQuote: null,
  payQuote: null,
  hoursQuote: null,
  employerBusiness: null,
  businessQuote: null,
  employmentType: null,
  coreResponsibilities: [{ text: "Build React features", quote: "Build React features", factId: "F1" }],
  mandatoryPrerequisites: [],
  niceToHave: [],
}

const CSRF_INVALID = { error: { code: "csrf_invalid", message: "The request is missing a valid CSRF token." } }
const UNAUTHENTICATED = { error: { code: "unauthenticated", message: "Sign in to continue." } }

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  anthropic = new FakeAnthropic(google.server)
  outbound = new OutboundRecorder(google.server)
  app = await createTestApp({ databaseUrl: database.url, clock })
  ada = await signInCandidate(new Browser(app, google))
  adaId = database.operatorId
  ;({ candidate: kofi, id: kofiId } = await signInSecondCandidate(app, google, database.db, { sub: "200000000000000000926", email: "kofi.stuck@example.test" }))
  await ada.post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(200)
  await database.db
    .insertInto("career_profile_version")
    .values({ candidate_id: adaId, version: 1, status: "approved", source: "edit", resume_upload_id: null, sections: JSON.stringify(SECTIONS), created_at: new Date(), approved_at: new Date() })
    .execute()
  worker = await Test.createTestingModule({
    imports: [WorkerModule.forRoot({ databaseUrl: database.url, anthropic: anthropicConfig(TEST_ANTHROPIC_KEY, TEST_ANTHROPIC_MODEL), candidateStorageDir: migratedStorageRoot() })],
  })
    .overrideProvider(JobQueue)
    .useValue(recordingQueue)
    .overrideProvider(WorkerHeartbeat)
    .useValue({ onApplicationBootstrap: () => undefined, onApplicationShutdown: () => undefined })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile()
  locker = new pg.Client({ connectionString: database.adminUrl })
  await locker.connect()
})

beforeEach(async () => {
  clock.set(NOW)
  await app.get(DiscoveryService).settled()
  await locker.query("select pg_advisory_unlock_all()")
  google.server.resetHandlers()
  anthropic.install()
  anthropic.reset()
  anthropic.onRequest = null
  outbound.reset()
  sent.length = 0
  await clearPostings(database.db)
  await resetCriteria(database.db)
  await database.db.deleteFrom("spend_entry").execute()
  await database.db.deleteFrom("spend_month").execute()
  await database.db.updateTable("employer_list_state").set({ approved_at: null }).execute()
  await database.db.updateTable("control_state").set({ global_paused: false, cost_paused: false, cost_paused_month: null }).execute()
})

afterAll(async () => {
  await locker?.end()
  await worker?.close()
  await app?.close()
  google?.close()
  await database?.stop()
})

/** A visible posting held by `candidateId`, `checking` since `since`. */
async function checkingSince(candidateId: string, since: Date, posting: Parameters<typeof insertPosting>[1] = {}, failure: string | null = null): Promise<string> {
  return seed(database.db, candidateId, posting, { status: "checking", evaluationFailure: failure, checkingSince: since })
}
/** Stuck at NOW (checking since 08:00 WAT, no lock). */
const stuck = (candidateId: string, posting: Parameters<typeof insertPosting>[1] = {}, failure: string | null = null) => checkingSince(candidateId, at("08:00:00"), posting, failure)

/** Another session holds the evaluator's lock for (candidate, posting), as a running evaluation does. */
async function holdLock(candidateId: string, postingId: string): Promise<void> {
  await locker.query("select pg_advisory_lock($1::bigint)", [String(evaluationLockKey(candidateId, postingId))])
}
const releaseLocks = () => locker.query("select pg_advisory_unlock_all()")

const recheckable = async (who: SignedInCandidate = ada) => (await list(who, "tab=all&limit=100")).recheckableCount
async function recheckableAt(time: Date, who: SignedInCandidate = ada): Promise<number> {
  clock.set(time)
  return recheckable(who)
}
const checkAgain = (who: SignedInCandidate = ada) => who.post(JOB_POSTINGS_CHECK_AGAIN_PATH).send({})
const runScheduled = () => worker.get(DiscoveryJobs).runDiscovery()
const spendTick = () => worker.get(DiscoveryJobs).spendTick()
const aiSpend = async () => Number((await sql<{ n: string }>`select count(*) as n from spend_entry where category = 'ai'`.execute(database.db)).rows[0]!.n)

/** Every queued evaluation: the api's pg-boss rows and the worker's recorded sends. */
async function allJobs(): Promise<Sent[]> {
  const boss = (await queuedEvaluations(database.db)).map((job) => ({ candidateId: job.candidateId ?? adaId, postingId: job.postingId }))
  return [...boss, ...sent]
}
const jobsFor = async (postingId: string) => (await allJobs()).filter((job) => job.postingId === postingId)

/** Runs every queued evaluation through the worker's job path, all at once (the lock decides) or one by one. */
async function runAllJobs(mode: "concurrent" | "sequential" = "sequential"): Promise<void> {
  const jobs = await allJobs()
  const run = (job: Sent) => worker.get(DiscoveryJobs).evaluateJob({ postingId: job.postingId, candidateId: job.candidateId })
  if (mode === "concurrent") await Promise.all(jobs.map(run))
  else for (const job of jobs) await run(job)
}

/** The `discovery.stuck_requeued` log line of one scheduled run. */
async function runScheduledLogged(): Promise<{ requeued: number; returnedHidden: number }> {
  const log = vi.spyOn(Logger.prototype, "log")
  try {
    await runScheduled()
    const line = log.mock.calls.map((call) => String(call[0])).find((text) => text.includes('"event":"discovery.stuck_requeued"'))
    expect(line, "the run logs its stuck re-queue count").toBeDefined()
    const { requeued, returnedHidden } = JSON.parse(line!) as { requeued: number; returnedHidden: number }
    return { requeued, returnedHidden }
  } finally {
    log.mockRestore()
  }
}

describe("stuck predicate (AC-7.11, AC-7.10)", () => {
  it("stuck:50 checking since 09:44 with no evaluation running counts toward Check again, not waiting; status stays checking", async () => {
    const id = await checkingSince(adaId, at("09:44:00"), { title: "Senior Frontend Engineer at Globex" })
    const page = await list(ada, "tab=all")
    expect(page).toMatchObject({ recheckableCount: 1, waitingToBeCheckedCount: 0 })
    expect(page.postings.find((p) => p.id === id)?.status).toBe("checking")
  })

  it("stuck:61 a queued evaluation job that has not started for 20 minutes holds no lock: stuck", async () => {
    const id = await checkingSince(adaId, at("09:40:00"), { title: "Senior Backend Engineer at Hooli", family: "backend" })
    await CandidateScope.run(adaId, () => worker.get(JobQueue).sendForCandidate(EVALUATE_POSTING, adaId, { postingId: id }))
    expect(await jobsFor(id)).toHaveLength(1)
    expect(await recheckable()).toBe(1)
  })

  it("stuck:69 stuck is not a status: the row keeps checking and its stored failure kind; the contract statuses are unchanged", async () => {
    const id = await checkingSince(adaId, at("09:00:00"), { title: "Fullstack Engineer at Initech", family: "fullstack" }, "timed_out")
    const page = await list(ada, "tab=all")
    expect(page.postings.find((p) => p.id === id)?.status).toBe("checking")
    expect(await statusOf(database.db, adaId, id)).toMatchObject({ status: "checking", evaluation_failure: "timed_out" })
    expect(jobPostingStatusSchema.options).toEqual(["checking", "waiting_to_be_checked", "not_checked", "ranked", "excluded", "skipped", "evaluation_failed"])
  })

  it.each([
    ["09:45:00", 0],
    ["09:59:59", 0],
    ["10:00:00", 0],
    ["10:00:01", 1],
    ["11:45:00", 1],
  ] as const)("stuck:81 entered 09:45:00, read at %s WAT: recheckableCount %i (strictly more than 15 minutes)", async (time, count) => {
    await checkingSince(adaId, at("09:45:00"))
    expect(await recheckableAt(at(time))).toBe(count)
  })

  it("stuck:81 boundary at millisecond precision: 15 min exactly is not stuck, 15 min + 1 ms is", async () => {
    await checkingSince(adaId, at("09:45:00"))
    expect(await recheckableAt(new Date(at("09:45:00").getTime() + STUCK_AFTER_MS))).toBe(0)
    expect(await recheckableAt(new Date(at("09:45:00").getTime() + STUCK_AFTER_MS + 1))).toBe(1)
  })

  it.each(["09:50:00", "09:44:00", "09:00:00"])("stuck:97 a posting whose evaluation holds the lock since %s is never stuck", async (entered) => {
    const id = await checkingSince(adaId, at(entered))
    await holdLock(adaId, id)
    expect(await recheckable()).toBe(0)
    await releaseLocks()
    expect(await recheckable()).toBe(entered === "09:50:00" ? 0 : 1)
  })

  it.each([
    ["waiting_to_be_checked", 0, 1],
    ["ranked", 0, 0],
    ["skipped", 0, 0],
    ["not_checked", 1, 0],
    ["evaluation_failed", 1, 0],
  ] as const)("stuck:111 a %s posting whose state last changed at 08:00 is never stuck: recheckable %i, waiting %i", async (status, count, waiting) => {
    await seed(database.db, adaId, {}, {
      status,
      evaluationFailure: status === "evaluation_failed" ? "provider_error" : null,
      skipReason: status === "skipped" ? "weak_core_match" : null,
      ...(status === "skipped" ? { covered: 5 } : {}),
      checkingSince: at("08:00:00"),
    })
    expect(await list(ada, "tab=all")).toMatchObject({ recheckableCount: count, waitingToBeCheckedCount: waiting })
  })

  it("the SQL lock key equals evaluationLockKey, and a held lock in this database is seen by the predicate", async () => {
    const id = await stuck(adaId)
    const { rows } = await sql<{ key: string; stuck: boolean }>`
      select ${evaluationLockKeySql("cp")}::text as key, ${stuckSql("cp", NOW)} as stuck
      from candidate_posting cp where cp.candidate_id = ${adaId}::uuid and cp.job_posting_id = ${id}::uuid`.execute(database.db)
    expect(rows).toEqual([{ key: String(evaluationLockKey(adaId, id)), stuck: true }])
    await holdLock(adaId, id)
    const held = await sql<{ stuck: boolean }>`select ${stuckSql("cp", NOW)} as stuck from candidate_posting cp where cp.job_posting_id = ${id}::uuid`.execute(database.db)
    expect(held.rows).toEqual([{ stuck: false }])
  })

  it("a lock on the same key held only for another Candidate's pair does not count", async () => {
    const id = await stuck(adaId)
    await holdLock(kofiId, id)
    expect(await recheckable()).toBe(1)
  })
})

describe("the 15 minutes restart on every move into checking (AC-7.12)", () => {
  /** The row first entered checking at 07:00, left, then moved back at 09:50 through `move`. */
  async function expectRestartedAt0950(): Promise<void> {
    expect(await recheckableAt(at("10:00:00"))).toBe(0)
    expect(await recheckableAt(at("10:05:01"))).toBe(1)
  }

  it("stuck:129 a discovery backfill claim of a not-checked row", async () => {
    const id = await insertPosting(database.db, { postedAt: null, title: "Senior Frontend Engineer", company: "Globex", requisitionId: "GH-4012345" })
    await sql`update job_posting set application_url = 'https://boards.greenhouse.io/canonical/jobs/4012345', apply_url = 'https://boards.greenhouse.io/canonical/jobs/4012345' where id = ${id}`.execute(database.db)
    await hold(database.db, adaId, id, { status: "not_checked", checkingSince: at("07:00:00") })
    google.server.use(
      http.get("https://boards-api.greenhouse.io/v1/boards/:token/jobs", ({ params }) =>
        HttpResponse.json(params.token === "canonical"
          ? { jobs: [{ id: 4012345, title: "Senior Frontend Engineer", absolute_url: "https://boards.greenhouse.io/canonical/jobs/4012345", requisition_id: "GH-4012345", content: "Remote, open to candidates in Nigeria. Build React features.", location: { name: "Remote" }, internal_job_id: 1, metadata: null, company_name: "Canonical", first_published: "2026-10-20T09:00:00Z" }] }
          : { jobs: [] })
      ),
      http.get("https://api.lever.co/v0/postings/:token", () => HttpResponse.json([])),
      http.get("https://api.ashbyhq.com/posting-api/job-board/:token", () => HttpResponse.json({ jobs: [] }))
    )
    await database.db.updateTable("employer_board").set({ last_read_at: null }).execute()
    await database.db.updateTable("remote_board").set({ enabled: false }).execute()
    clock.set(at("09:50:00"))
    const summary = await app.get(TenantDatabase).asOperator(() => app.get(DiscoveryPipeline).runDaily({ ignoreApproval: true }))
    expect(summary.postingIdsToEvaluate).toEqual([id])
    expect(await checkingSinceOf(database.db, adaId, id)).toEqual(at("09:50:00"))
    await expectRestartedAt0950()
  })

  it("stuck:129 a paste backfill claim of a not-checked row (AC-5.8), then the evaluation dies", async () => {
    const lookup = (dated: boolean) =>
      http.get("https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345", () =>
        HttpResponse.json({ id: 4012345, title: "Senior Frontend Engineer", absolute_url: "https://boards.greenhouse.io/acme/jobs/4012345", requisition_id: "4012345", company_name: "Acme", content: "Remote, open to candidates in Nigeria. Build React features.", ...(dated ? { first_published: "2026-10-20T10:00:00Z" } : {}) })
      )
    clock.set(at("07:00:00"))
    google.server.use(lookup(false))
    const first = await ada.post("/v1/job-postings/links").send({ url: "https://boards.greenhouse.io/acme/jobs/4012345" }).expect(201)
    const id = first.body.posting.id as string
    expect((await statusOf(database.db, adaId, id)).status).toBe("not_checked")
    google.server.resetHandlers()
    anthropic.install()
    google.server.use(lookup(true))
    clock.set(at("09:50:00"))
    let during: Date | null = null
    anthropic.onRequest = async () => {
      during = await checkingSinceOf(database.db, adaId, id)
    }
    anthropic.replyWithStatus(500)
    const again = await ada.post("/v1/job-postings/links").send({ url: "https://boards.greenhouse.io/embed/job_app?for=acme&token=4012345" }).expect(200)
    expect(again.body.posting).toMatchObject({ id, status: "checking" })
    await app.get(DiscoveryService).settled()
    expect(during).toEqual(at("09:50:00"))
    // The process dies after the move: the row is left checking with the timer the paste wrote.
    await database.db.updateTable("candidate_posting").set({ status: "checking" }).where("candidate_id", "=", adaId).where("job_posting_id", "=", id).execute()
    await expectRestartedAt0950()
  })

  it("stuck:129 a Check again claim of a failed row", async () => {
    const id = await seed(database.db, adaId, {}, { status: "evaluation_failed", evaluationFailure: "provider_error", checkingSince: at("07:00:00") })
    clock.set(at("09:50:00"))
    expect((await checkAgain().expect(200)).body).toEqual({ queued: 1, movedTo: "checking" })
    expect(await checkingSinceOf(database.db, adaId, id)).toEqual(at("09:50:00"))
    await expectRestartedAt0950()
  })

  it("stuck:129 a Check again claim of a stuck row", async () => {
    const id = await checkingSince(adaId, at("07:00:00"))
    clock.set(at("09:50:00"))
    expect((await checkAgain().expect(200)).body).toEqual({ queued: 1, movedTo: "checking" })
    expect(await checkingSinceOf(database.db, adaId, id)).toEqual(at("09:50:00"))
    await expectRestartedAt0950()
  })

  it("stuck:129 a stuck re-queue by the scheduled discovery run", async () => {
    const id = await checkingSince(adaId, at("07:00:00"))
    clock.set(at("09:50:00"))
    await runScheduled()
    expect(sent).toEqual([{ candidateId: adaId, postingId: id }])
    expect(await checkingSinceOf(database.db, adaId, id)).toEqual(at("09:50:00"))
    await expectRestartedAt0950()
  })

  it("stuck:129 the evaluator's own move into checking at a cost-pause release, then the evaluation dies", async () => {
    const id = await seed(database.db, adaId, {}, { status: "waiting_to_be_checked", checkingSince: at("07:00:00") })
    clock.set(at("09:50:00"))
    let during: { since: Date; status: string } | null = null
    anthropic.onRequest = async () => {
      during = { since: await checkingSinceOf(database.db, adaId, id), status: (await statusOf(database.db, adaId, id)).status }
    }
    anthropic.replyWithStatus(500)
    await worker.get(DiscoveryJobs).evaluateJob({ postingId: id, candidateId: adaId })
    expect(during).toEqual({ since: at("09:50:00"), status: "checking" })
    await database.db.updateTable("candidate_posting").set({ status: "checking" }).where("candidate_id", "=", adaId).where("job_posting_id", "=", id).execute()
    await expectRestartedAt0950()
  })

  it("stuck:148 a newly stored posting's 15 minutes start when it is first stored as checking", async () => {
    google.server.use(
      http.get("https://boards-api.greenhouse.io/v1/boards/:token/jobs", ({ params }) =>
        HttpResponse.json(params.token === "canonical"
          ? { jobs: [{ id: 7012345, title: "Senior Frontend Engineer", absolute_url: "https://boards.greenhouse.io/canonical/jobs/7012345", requisition_id: "GH-7012345", content: "Remote, open to candidates in Nigeria. Build React features.", location: { name: "Remote" }, internal_job_id: 2, metadata: null, company_name: "Canonical", first_published: "2026-10-20T09:00:00Z" }] }
          : { jobs: [] })
      ),
      http.get("https://api.lever.co/v0/postings/:token", () => HttpResponse.json([])),
      http.get("https://api.ashbyhq.com/posting-api/job-board/:token", () => HttpResponse.json({ jobs: [] }))
    )
    await database.db.updateTable("employer_board").set({ last_read_at: null }).execute()
    await database.db.updateTable("remote_board").set({ enabled: false }).execute()
    clock.set(at("09:50:00"))
    const summary = await app.get(TenantDatabase).asOperator(() => app.get(DiscoveryPipeline).runDaily({ ignoreApproval: true }))
    expect(summary.postingIdsToEvaluate).toHaveLength(1)
    expect(await recheckableAt(at("10:05:00"))).toBe(0)
    expect(await recheckableAt(at("10:05:01"))).toBe(1)
  })

  it("stuck:156 a stuck posting re-queued by Check again whose new job is lost is stuck again 15 minutes after the re-queue", async () => {
    await checkingSince(adaId, at("08:00:00"))
    expect((await checkAgain().expect(200)).body).toEqual({ queued: 1, movedTo: "checking" })
    await sql`delete from pgboss.job where name = 'evaluate.posting'`.execute(database.db)
    expect(await recheckableAt(at("10:15:00"))).toBe(0)
    expect(await recheckableAt(at("10:15:01"))).toBe(1)
  })
})

describe("Check again claims stuck postings (AC-7.13, AC-7.3)", () => {
  it("stuck:197 counts and claims failed, not-checked and stuck rows, but not a recent checking row or one whose lock is held", async () => {
    const failed = await seed(database.db, adaId, { title: "Senior Frontend Engineer at Globex" }, { status: "evaluation_failed", evaluationFailure: "not_configured" })
    const notChecked = await seed(database.db, adaId, { title: "Senior Software Engineer at Lumon", family: "software_engineering" }, { status: "not_checked" })
    const hooli = await checkingSince(adaId, at("09:30:00"), { title: "Senior Backend Engineer at Hooli", family: "backend" })
    const piedPiper = await checkingSince(adaId, at("09:55:00"), { title: "Senior iOS Engineer at Pied Piper", family: "mobile" })
    const vandelay = await checkingSince(adaId, at("09:00:00"), { title: "Lead Engineer at Vandelay", family: "technical_lead" })
    await holdLock(adaId, vandelay)
    expect(await recheckable()).toBe(3)
    expect(checkAgainResponseSchema.parse((await checkAgain().expect(200)).body)).toEqual({ queued: 3, movedTo: "checking" })
    for (const id of [failed, notChecked, hooli]) expect(await jobsFor(id)).toHaveLength(1)
    for (const id of [piedPiper, vandelay]) expect(await jobsFor(id)).toEqual([])
  })

  it("stuck:211 / :218 the count includes stuck postings, and stuck postings alone show the action", async () => {
    await seed(database.db, adaId, {}, { status: "evaluation_failed", evaluationFailure: "provider_error" })
    await stuck(adaId)
    await stuck(adaId)
    expect(await recheckable()).toBe(3)
    await clearPostings(database.db)
    await stuck(adaId)
    await stuck(adaId)
    expect(await recheckable()).toBe(2)
  })

  it("stuck:224 a stuck posting Check again claims is evaluated through the normal path: one reservation, one call, ranked", async () => {
    const id = await stuck(adaId, { title: "Senior Backend Engineer at Hooli", family: "backend" }, "provider_error")
    anthropic.replyWithObject(STRONG)
    anthropic.replyWithObject(STRONG)
    await checkAgain().expect(200)
    await runAllJobs()
    expect(anthropic.requests).toHaveLength(1)
    expect(await aiSpend()).toBe(1)
    expect((await statusOf(database.db, adaId, id)).status).toBe("ranked")
  })

  it("stuck:232 Kofi's Check again moves his not-checked and stuck postings to waiting with no job, call or spend (D13)", async () => {
    const ids = [await seed(database.db, kofiId, {}, { status: "not_checked" }), await stuck(kofiId), await stuck(kofiId)]
    expect(await recheckable(kofi)).toBe(3)
    expect((await checkAgain(kofi).expect(200)).body).toEqual({ queued: 3, movedTo: "waiting_to_be_checked" })
    for (const id of ids) expect((await statusOf(database.db, kofiId, id)).status).toBe("waiting_to_be_checked")
    expect(await allJobs()).toEqual([])
    expect(anthropic.requests).toHaveLength(0)
    expect(await aiSpend()).toBe(0)
  })

  it("stuck:241 the only checking posting is not yet stuck: queued 0", async () => {
    const id = await checkingSince(adaId, at("09:50:00"))
    expect((await checkAgain().expect(200)).body).toEqual({ queued: 0, movedTo: "checking" })
    expect(await jobsFor(id)).toEqual([])
  })

  it("stuck:248 Check again ignores a hidden stuck posting", async () => {
    const id = await stuck(adaId, { title: "Senior Data Engineer at Globex", family: "data_ml" })
    expect(await recheckable()).toBe(0)
    expect((await checkAgain().expect(200)).body).toEqual({ queued: 0, movedTo: "checking" })
    expect((await statusOf(database.db, adaId, id)).status).toBe("checking")
    expect(await jobsFor(id)).toEqual([])
  })

  it("stuck:260 Ada's Check again claims none of Kofi's stuck postings, including the same posting", async () => {
    const shared = await stuck(adaId)
    await hold(database.db, kofiId, shared, { status: "checking", checkingSince: at("08:00:00") })
    const kofiOnly = await stuck(kofiId)
    expect((await checkAgain().expect(200)).body).toEqual({ queued: 1, movedTo: "checking" })
    for (const id of [shared, kofiOnly]) expect((await statusOf(database.db, kofiId, id)).status).toBe("checking")
    expect((await allJobs()).filter((job) => job.candidateId === kofiId)).toEqual([])
  })

  it.each(["no CSRF token", "a wrong CSRF token", "no session"])("stuck:269 a refused request (%s) claims no stuck posting", async (label) => {
    const ids = [await stuck(adaId), await stuck(adaId)]
    const request = new Browser(app, google).http().post(JOB_POSTINGS_CHECK_AGAIN_PATH)
    if (label === "no session") {
      expect((await request.send({}).expect(401)).body).toEqual(UNAUTHENTICATED)
    } else {
      const call = request.set("cookie", ada.cookie)
      const response = await (label === "a wrong CSRF token" ? call.set(CSRF_HEADER, `${ada.csrfToken}x`) : call).send({}).expect(403)
      expect(response.body).toEqual(CSRF_INVALID)
    }
    for (const id of ids) expect((await statusOf(database.db, adaId, id)).status).toBe("checking")
    expect(await allJobs()).toEqual([])
  })
})

describe("the scheduled discovery run re-queues stuck postings (AC-7.14, P18)", () => {
  it("stuck:285 re-queues the Operator's 3 visible stuck postings, not the one checking since 07:55, and logs 3", async () => {
    clock.set(at("08:00:00"))
    const stuckIds = [await checkingSince(adaId, at("07:00:00")), await checkingSince(adaId, at("07:30:00")), await checkingSince(adaId, at("07:44:59"))]
    const recent = await checkingSince(adaId, at("07:55:00"))
    expect(await runScheduledLogged()).toEqual({ requeued: 3, returnedHidden: 0 })
    expect(sent.map((job) => job.postingId).sort()).toEqual([...stuckIds].sort())
    expect(sent.every((job) => job.candidateId === adaId)).toBe(true)
    expect(await jobsFor(recent)).toEqual([])
  })

  it("stuck:294 a re-queued stuck posting is evaluated through the normal path: one reservation, one call, ranked", async () => {
    clock.set(at("08:00:00"))
    const id = await checkingSince(adaId, at("07:00:00"), { title: "Senior Backend Engineer at Hooli", family: "backend" })
    anthropic.replyWithObject(STRONG)
    anthropic.replyWithObject(STRONG)
    await runScheduled()
    await runAllJobs()
    expect(anthropic.requests).toHaveLength(1)
    expect(await aiSpend()).toBe(1)
    expect((await statusOf(database.db, adaId, id)).status).toBe("ranked")
  })

  it.each(["the employer list is not approved", "the global pause is on"])("stuck:302 re-queues stuck postings even when it reads no source: %s", async (condition) => {
    clock.set(at("08:00:00"))
    if (condition === "the global pause is on") {
      await database.db.updateTable("employer_list_state").set({ approved_at: at("07:00:00") }).execute()
      await database.db.updateTable("control_state").set({ global_paused: true }).execute()
    }
    const ids = [await checkingSince(adaId, at("07:00:00")), await checkingSince(adaId, at("07:00:00"))]
    expect(await runScheduledLogged()).toEqual({ requeued: 2, returnedHidden: 0 })
    expect(outbound.urls).toEqual([])
    expect(sent.map((job) => job.postingId).sort()).toEqual([...ids].sort())
  })

  it("stuck:316 during the global pause a re-queued stuck posting is evaluated and ranked; no Application is submitted", async () => {
    clock.set(at("08:00:00"))
    await database.db.updateTable("control_state").set({ global_paused: true }).execute()
    const id = await checkingSince(adaId, at("07:00:00"), { title: "Senior Backend Engineer at Hooli", family: "backend" })
    anthropic.replyWithObject(STRONG)
    await runScheduled()
    await runAllJobs()
    expect((await statusOf(database.db, adaId, id)).status).toBe("ranked")
    expect(await database.db.selectFrom("application").select("id").execute()).toEqual([])
  })

  it("stuck:325 with no stuck posting the run queues nothing and logs 0", async () => {
    clock.set(at("08:00:00"))
    await seed(database.db, adaId, {}, { status: "ranked" })
    expect(await runScheduledLogged()).toEqual({ requeued: 0, returnedHidden: 0 })
    expect(sent).toEqual([])
  })

  it("stuck:332 a posting checking since 06:00 whose evaluation holds the lock is not re-queued", async () => {
    clock.set(at("08:00:00"))
    const id = await checkingSince(adaId, at("06:00:00"), { title: "Lead Engineer at Vandelay", family: "technical_lead" })
    await holdLock(adaId, id)
    expect(await runScheduledLogged()).toEqual({ requeued: 0, returnedHidden: 0 })
    expect(sent).toEqual([])
    expect(await checkingSinceOf(database.db, adaId, id)).toEqual(at("06:00:00"))
  })

  it("stuck:340 the run re-queues no invitee's stuck postings; Kofi's count still includes them", async () => {
    clock.set(at("08:00:00"))
    const kofiIds = [await checkingSince(kofiId, at("07:00:00")), await checkingSince(kofiId, at("07:00:00"))]
    await checkingSince(adaId, at("07:00:00"))
    expect(await runScheduledLogged()).toEqual({ requeued: 1, returnedHidden: 0 })
    for (const id of kofiIds) expect((await statusOf(database.db, kofiId, id)).status).toBe("checking")
    expect(sent.filter((job) => job.candidateId === kofiId)).toEqual([])
    expect(await recheckable(kofi)).toBe(2)
  })

  it("stuck:350 the every-minute spend tick recovers no stuck posting", async () => {
    const id = await checkingSince(adaId, at("10:00:00"), { title: "Senior Backend Engineer at Hooli", family: "backend" })
    for (let minute = 16; minute <= 45; minute++) {
      clock.set(at(`10:${String(minute).padStart(2, "0")}:00`))
      await spendTick()
    }
    expect(sent).toEqual([])
    expect(await allJobs()).toEqual([])
    expect((await statusOf(database.db, adaId, id)).status).toBe("checking")
  })

  it("a failed recovery does not stop the source read step", async () => {
    clock.set(at("08:00:00"))
    const repository = worker.get(DiscoveryRepository)
    const spy = vi.spyOn(repository, "requeueStuck").mockRejectedValueOnce(new Error("boom"))
    const read = vi.spyOn(worker.get(DiscoveryPipeline), "runDaily")
    try {
      await runScheduled()
      expect(read).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
      read.mockRestore()
    }
  })
})

describe("hidden stuck postings (AC-7.15, P19)", () => {
  it.each([
    ["Senior Data Engineer at Globex", { family: "data_ml" }, "provider_error", "off-target", "evaluation_failed"],
    ["Senior Data Engineer at Globex", { family: "data_ml" }, null, "off-target", "not_checked"],
    ["Junior Frontend Developer at Hooli", { marker: "entry" }, "timed_out", "below the seniority floor", "evaluation_failed"],
    ["Senior Frontend Engineer at Initech", { postedAt: null }, null, "undated", "not_checked"],
    ["Senior Frontend Engineer at Lumon", { postedAt: new Date("2026-08-01T09:00:00Z") }, "not_configured", "older than 60 days", "evaluation_failed"],
    ["Senior Frontend Engineer at Lumon", { postedAt: new Date("2026-08-01T09:00:00Z") }, null, "older than 60 days", "not_checked"],
  ] as const)("stuck:359 %s, stuck with kind %s and hidden as %s, returns to its AC-7.1 state with no job or call", async (title, facts, failure, _reason, result) => {
    clock.set(at("08:00:00"))
    const id = await checkingSince(adaId, at("07:00:00"), { title, ...facts }, failure)
    expect(await runScheduledLogged()).toEqual({ requeued: 0, returnedHidden: 1 })
    expect(await statusOf(database.db, adaId, id)).toMatchObject({ status: result, evaluation_failure: failure })
    expect(sent).toEqual([])
    expect(anthropic.requests).toHaveLength(0)
    expect(await aiSpend()).toBe(0)
  })

  it("stuck:378 a hidden stuck posting returned to not_checked counts toward Check again once a save makes it visible", async () => {
    clock.set(at("08:00:00"))
    const id = await checkingSince(adaId, at("07:00:00"), { title: "Senior Data Engineer at Globex", family: "data_ml" })
    await runScheduled()
    expect((await statusOf(database.db, adaId, id)).status).toBe("not_checked")
    await ada.put(JOB_CRITERIA_PATH).send({ minCoreMatchPercent: 70, frameworks: [], technologies: [], targetRoleFamilies: [...DEFAULT_TARGETS, "data_ml"], seniorityFloor: "hide_entry_level" }).expect(200)
    expect(await recheckable()).toBe(1)
    expect(anthropic.requests).toHaveLength(0)
  })

  it("stuck:386 a posting Ada does not hold, stuck for Kofi, is left alone", async () => {
    clock.set(at("08:00:00"))
    const id = await checkingSince(kofiId, at("07:00:00"))
    await runScheduled()
    expect((await statusOf(database.db, kofiId, id)).status).toBe("checking")
    expect(sent).toEqual([])
  })
})

describe("cost and duplicates are unchanged (AC-7.16)", () => {
  it.each(["Ada confirms Check again", "the scheduled discovery run starts"])("stuck:397 during the cost pause a stuck posting re-queued by %s waits: no call, no spend", async (requeue) => {
    clock.set(at("08:00:00"))
    const ids = [await checkingSince(adaId, at("07:00:00")), await checkingSince(adaId, at("07:00:00"))]
    await database.db.updateTable("control_state").set({ cost_paused: true, cost_paused_month: "2026-10-01" }).execute()
    if (requeue === "Ada confirms Check again") await checkAgain().expect(200)
    else await runScheduled()
    expect(await allJobs()).toHaveLength(2)
    await runAllJobs()
    for (const id of ids) expect((await statusOf(database.db, adaId, id)).status).toBe("waiting_to_be_checked")
    expect(anthropic.requests).toHaveLength(0)
    expect(await aiSpend()).toBe(0)
    expect(await list(ada, "tab=all")).toMatchObject({ waitingToBeCheckedCount: 2, recheckableCount: 0 })
  })

  it("stuck:411 the installation ceiling stops a stuck re-queue after one check; the other two wait and paid automation pauses", async () => {
    clock.set(at("08:00:00"))
    for (let i = 0; i < 3; i++) await checkingSince(adaId, at("07:00:00"))
    for (let i = 0; i < 3; i++) anthropic.replyWithObject(STRONG)
    await runScheduled()
    const [first, ...rest] = await allJobs()
    await worker.get(DiscoveryJobs).evaluateJob({ postingId: first!.postingId, candidateId: adaId })
    expect(anthropic.requests).toHaveLength(1)
    // Leave less than one more check's estimate under the ceiling (the room was for exactly one check).
    const estimate = Number((await database.db.selectFrom("spend_entry").select("reserved_micros").where("category", "=", "ai").executeTakeFirstOrThrow()).reserved_micros)
    const spent = Number((await sql<{ n: string }>`select coalesce(sum(case when status = 'settled' then actual_micros else reserved_micros end), 0) as n from spend_entry`.execute(database.db)).rows[0]!.n)
    await database.db.updateTable("spend_month").set({ ceiling_micros: spent + Math.floor(estimate / 2) }).execute()
    for (const job of rest) await worker.get(DiscoveryJobs).evaluateJob({ postingId: job.postingId, candidateId: adaId })
    expect(anthropic.requests).toHaveLength(1)
    const statuses = (await database.db.selectFrom("candidate_posting").select("status").where("candidate_id", "=", adaId).execute()).map((row) => row.status).sort()
    expect(statuses).toEqual(["ranked", "waiting_to_be_checked", "waiting_to_be_checked"])
    expect((await database.db.selectFrom("control_state").select("cost_paused").executeTakeFirstOrThrow()).cost_paused).toBe(true)
  })

  type Requeue = "check" | "run"
  const requeue = async (how: Requeue) => (how === "check" ? void (await checkAgain().expect(200)) : runScheduled())
  it.each([
    ["check", "check", "sequential"],
    ["check", "check", "concurrent"],
    ["check", "run", "sequential"],
    ["run", "check", "concurrent"],
    ["run", "run", "sequential"],
  ] as const)("stuck:429 a stuck posting re-queued by %s then %s (%s) is evaluated exactly once", async (first: Requeue, second: Requeue, timing) => {
    clock.set(at("08:00:00"))
    const id = await checkingSince(adaId, at("07:00:00"), { title: "Senior Backend Engineer at Hooli", family: "backend" })
    for (let i = 0; i < 3; i++) anthropic.replyWithObject(STRONG)
    if (timing === "concurrent") await Promise.all([requeue(first), requeue(second)])
    else {
      await requeue(first)
      await requeue(second)
    }
    expect((await jobsFor(id)).length).toBeGreaterThanOrEqual(1)
    await runAllJobs(timing === "concurrent" ? "concurrent" : "sequential")
    expect(anthropic.requests).toHaveLength(1)
    expect(await aiSpend()).toBe(1)
    expect(await database.db.selectFrom("match_evidence").select("job_posting_id").where("job_posting_id", "=", id).execute()).toHaveLength(1)
    expect((await statusOf(database.db, adaId, id)).status).toBe("ranked")
  })

  it("stuck:446 a second job that finds the evaluation running (lock held) does nothing", async () => {
    const id = await checkingSince(adaId, at("09:59:00"))
    await holdLock(adaId, id)
    anthropic.replyWithObject(STRONG)
    await worker.get(DiscoveryJobs).evaluateJob({ postingId: id, candidateId: adaId })
    expect(anthropic.requests).toHaveLength(0)
    expect(await aiSpend()).toBe(0)
    expect(await statusOf(database.db, adaId, id)).toMatchObject({ status: "checking" })
    expect(await checkingSinceOf(database.db, adaId, id)).toEqual(at("09:59:00"))
  })

  it.each([false, true])("stuck:454 a second job that finds the evaluation finished (ranked) does nothing (cost pause on: %s)", async (costPaused) => {
    const id = await seed(database.db, adaId, {}, { status: "ranked" })
    if (costPaused) await database.db.updateTable("control_state").set({ cost_paused: true, cost_paused_month: "2026-10-01" }).execute()
    anthropic.replyWithObject(STRONG)
    await worker.get(DiscoveryJobs).evaluateJob({ postingId: id, candidateId: adaId })
    expect(anthropic.requests).toHaveLength(0)
    expect(await aiSpend()).toBe(0)
    expect((await statusOf(database.db, adaId, id)).status).toBe("ranked")
  })

  it("stuck:462 a Check again that races an evaluation already holding the lock claims nothing; one call in total", async () => {
    const id = await stuck(adaId, { title: "Senior Backend Engineer at Hooli", family: "backend" })
    expect(await recheckable()).toBe(1)
    await holdLock(adaId, id)
    expect((await checkAgain().expect(200)).body).toEqual({ queued: 0, movedTo: "checking" })
    await releaseLocks()
    // The evaluation that held the lock is the only one: it runs to its verdict.
    anthropic.replyWithObject(STRONG)
    anthropic.replyWithObject(STRONG)
    await worker.get(DiscoveryJobs).evaluateJob({ postingId: id, candidateId: adaId })
    await runAllJobs()
    expect(anthropic.requests).toHaveLength(1)
  })

  it("stuck:471 a re-paste racing a Check again press on a stuck posting starts one evaluation", async () => {
    const lookup = http.get("https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345", () =>
      HttpResponse.json({ id: 4012345, title: "Senior Frontend Engineer", absolute_url: "https://boards.greenhouse.io/acme/jobs/4012345", requisition_id: "4012345", company_name: "Acme", content: "Remote, open to candidates in Nigeria. Build React features.", first_published: "2026-10-20T10:00:00Z" })
    )
    google.server.use(lookup)
    anthropic.replyWithStatus(500)
    const first = await ada.post("/v1/job-postings/links").send({ url: "https://boards.greenhouse.io/acme/jobs/4012345" }).expect(201)
    await app.get(DiscoveryService).settled()
    const id = first.body.posting.id as string
    anthropic.reset()
    await database.db.deleteFrom("spend_entry").execute()
    await database.db.updateTable("candidate_posting").set({ status: "checking", checking_since: at("08:00:00") }).where("candidate_id", "=", adaId).where("job_posting_id", "=", id).execute()
    for (let i = 0; i < 3; i++) anthropic.replyWithObject(STRONG)
    const [pressed, pasted] = await Promise.all([checkAgain(), ada.post("/v1/job-postings/links").send({ url: "https://boards.greenhouse.io/embed/job_app?for=acme&token=4012345" })])
    expect(pressed.status).toBe(200)
    expect(pasted.status).toBe(200)
    await app.get(DiscoveryService).settled()
    await runAllJobs()
    expect(anthropic.requests).toHaveLength(1)
    expect(await aiSpend()).toBe(1)
  })
})
