import type { INestApplication, INestApplicationContext } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { JOB_POSTINGS_CHECK_AGAIN_PATH, JOB_POSTING_LINKS_PATH } from "@eve/contracts"
import { sql } from "kysely"
import pg from "pg"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { anthropicConfig } from "../src/config/env.js"
import { DiscoveryService } from "../src/discovery/discovery.service.js"
import { CLOCK } from "../src/shared/clock.js"
import { DiscoveryJobs } from "../src/worker/discovery-jobs.js"
import { JobQueue } from "../src/worker/job-queue.js"
import { WorkerHeartbeat } from "../src/worker/worker-heartbeat.js"
import { WorkerModule } from "../src/worker/worker.module.js"
import { Browser } from "./support/browser.js"
import {
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
 * SEC-R-02 (EPIC-0010 security-review.r1): pasted links and pasted descriptions are evaluated in the api
 * process after the response, so an api restart leaves `candidate_posting.status = 'checking'` forever.
 * EPIC-0006 r4 AC-7.11 to AC-7.17 recover it (Check again, the 08:00 run's requeueStuck). Real api and
 * the real worker providers on one Postgres database, as stuck-checking.int-spec.ts; the worker's queue
 * records its sends and every job runs through `DiscoveryJobs.evaluateJob`. A "restart" is a `checking`
 * row with an old `checking_since`, no lock and no evaluation behind it.
 */
let database: TestDatabase
let google: FakeGoogle
let anthropic: FakeAnthropic
let outbound: OutboundRecorder
let app: INestApplication
let worker: INestApplicationContext
let ada: SignedInCandidate
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


beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  anthropic = new FakeAnthropic(google.server)
  outbound = new OutboundRecorder(google.server)
  app = await createTestApp({ databaseUrl: database.url, clock })
  ada = await signInCandidate(new Browser(app, google))
  adaId = database.operatorId
  ;({ id: kofiId } = await signInSecondCandidate(app, google, database.db, { sub: "200000000000000000926", email: "kofi.stuck@example.test" }))
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

const BODY_TEXT = "Remote, open to candidates in Nigeria. Build React features."
const DESCRIPTION = `Senior Frontend Engineer\n\n${BODY_TEXT}\n\n${"We ship a payments dashboard used across Africa. ".repeat(6)}`
const LINKEDIN = "https://www.linkedin.com/jobs/view/4012345678"
const named = { title: "Senior Frontend Engineer", company: "Paystack" }

const aiSpend = async () => Number((await sql<{ n: string }>`select count(*) as n from spend_entry where category = 'ai'`.execute(database.db)).rows[0]!.n)
const checkAgain = (who: SignedInCandidate = ada) => who.post(JOB_POSTINGS_CHECK_AGAIN_PATH).send({})
const runScheduled = () => worker.get(DiscoveryJobs).runDiscovery()
const STUCK_SINCE = at("08:00:00")

/** Every queued evaluation: the api's pg-boss rows and the worker's recorded sends. */
async function allJobs(): Promise<Sent[]> {
  const boss = (await queuedEvaluations(database.db)).map((job) => ({ candidateId: job.candidateId ?? adaId, postingId: job.postingId }))
  return [...boss, ...sent]
}
const jobsFor = async (postingId: string) => (await allJobs()).filter((job) => job.postingId === postingId)
async function runAllJobs(): Promise<void> {
  for (const job of await allJobs()) await worker.get(DiscoveryJobs).evaluateJob({ postingId: job.postingId, candidateId: job.candidateId })
}

/** `who` pastes a description (the api evaluates it after the response); returns the posting id once that has finished. */
async function pasteDescription(who: SignedInCandidate, body: Record<string, unknown>, status: 200 | 201 = 201): Promise<string> {
  anthropic.replyWithObject(STRONG)
  anthropic.replyWithObject(STRONG)
  const response = await who.post(JOB_POSTING_LINKS_PATH).send(body)
  expect(response.status, JSON.stringify(response.body)).toBe(status)
  await app.get(DiscoveryService).settled()
  return response.body.posting.id as string
}

/**
 * Simulates the api restarting mid-evaluation: the row is `checking` since 08:00, the evaluation's work is gone
 * (no verdict, no evidence) and nothing holds the lock. Clears the fake's call record so later counts are the recovery's.
 */
async function strandInChecking(candidateId: string, postingId: string): Promise<void> {
  await database.db.deleteFrom("eligibility_result").where("candidate_id", "=", candidateId).where("job_posting_id", "=", postingId).execute()
  await database.db.deleteFrom("match_evidence").where("candidate_id", "=", candidateId).where("job_posting_id", "=", postingId).execute()
  await database.db
    .updateTable("candidate_posting")
    .set({ status: "checking", skip_reason: null, skip_detail: null, evaluation_failure: null, evaluated_at: null, checking_since: STUCK_SINCE })
    .where("candidate_id", "=", candidateId)
    .where("job_posting_id", "=", postingId)
    .execute()
  anthropic.reset()
  await database.db.deleteFrom("spend_entry").execute()
  sent.length = 0
}

describe("SEC-R-02 a pasted description stranded in checking by an api restart (AC-7.11, AC-7.13, AC-7.14)", () => {
  it("a new pasted description stores checking_since at paste time", async () => {
    const id = await pasteDescription(ada, { description: DESCRIPTION, ...named })
    // The paste moved it into checking (clock NOW); the in-process evaluation then ranked it.
    expect(await checkingSinceOf(database.db, adaId, id)).toEqual(NOW)
  })

  it("Check again recovers the stranded description; the queued job evaluates it end to end (one reservation, one call, ranked)", async () => {
    const id = await pasteDescription(ada, { description: DESCRIPTION, ...named })
    await strandInChecking(adaId, id)
    expect((await list(ada, "tab=all")).recheckableCount).toBe(1)
    anthropic.replyWithObject(STRONG)
    anthropic.replyWithObject(STRONG)
    const response = await checkAgain().expect(200)
    expect(response.body).toMatchObject({ queued: 1 })
    expect(await jobsFor(id)).toHaveLength(1)
    await runAllJobs()
    expect(anthropic.requests).toHaveLength(1)
    expect(await aiSpend()).toBe(1)
    expect((await statusOf(database.db, adaId, id)).status).toBe("ranked")
  })

  it("the 08:00 run's requeueStuck recovers it the same way", async () => {
    const id = await pasteDescription(ada, { description: DESCRIPTION, ...named })
    await strandInChecking(adaId, id)
    clock.set(at("08:30:00"))
    anthropic.replyWithObject(STRONG)
    anthropic.replyWithObject(STRONG)
    await runScheduled()
    expect(sent.map((job) => job.postingId)).toEqual([id])
    await runAllJobs()
    expect(anthropic.requests).toHaveLength(1)
    expect((await statusOf(database.db, adaId, id)).status).toBe("ranked")
  })

  it("a stranded description inside its 15 minutes is left alone by both recoveries", async () => {
    const id = await pasteDescription(ada, { description: DESCRIPTION, ...named })
    await strandInChecking(adaId, id)
    clock.set(at("08:10:00"))
    await checkAgain().expect(200)
    await runScheduled()
    expect(await jobsFor(id)).toEqual([])
    expect((await statusOf(database.db, adaId, id)).status).toBe("checking")
  })

  it("after recovery a re-paste of the same link with a new description no longer gets still_checking 409", async () => {
    const id = await pasteDescription(ada, { url: LINKEDIN, description: DESCRIPTION, ...named })
    await strandInChecking(adaId, id)
    const refused = await ada.post(JOB_POSTING_LINKS_PATH).send({ url: LINKEDIN, description: `${DESCRIPTION} v2`, ...named })
    expect(refused.status).toBe(409)
    expect(refused.body.error.code).toBe("posting_still_checking")
    anthropic.replyWithObject(STRONG)
    anthropic.replyWithObject(STRONG)
    await checkAgain().expect(200)
    await runAllJobs()
    expect((await statusOf(database.db, adaId, id)).status).toBe("ranked")
    anthropic.replyWithObject(STRONG)
    anthropic.replyWithObject(STRONG)
    const again = await ada.post(JOB_POSTING_LINKS_PATH).send({ url: LINKEDIN, description: `${DESCRIPTION} v2`, ...named })
    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(again.body).toMatchObject({ created: false, descriptionOutcome: "replaced" })
    await app.get(DiscoveryService).settled()
    // The replace restarts the 15 minutes.
    expect(await checkingSinceOf(database.db, adaId, id)).toEqual(NOW)
  })
})

describe("SEC-R-02 a stranded pasted link follows P19 (AC-7.15)", () => {
  it("a visible one is requeued; an undated one and one older than 60 days return to not_checked with no job or call", async () => {
    const visible = await seed(database.db, adaId, { origin: "pasted_link" }, { status: "checking", checkingSince: STUCK_SINCE })
    const undated = await seed(database.db, adaId, { origin: "pasted_link", postedAt: null }, { status: "checking", checkingSince: STUCK_SINCE })
    const old = await seed(database.db, adaId, { origin: "pasted_link", postedAt: new Date("2026-08-01T09:00:00Z") }, { status: "checking", checkingSince: STUCK_SINCE, evaluationFailure: "timed_out" })
    clock.set(at("08:30:00"))
    anthropic.replyWithObject(STRONG)
    anthropic.replyWithObject(STRONG)
    await runScheduled()
    expect(sent.map((job) => job.postingId)).toEqual([visible])
    expect(await statusOf(database.db, adaId, undated)).toMatchObject({ status: "not_checked", evaluation_failure: null })
    expect(await statusOf(database.db, adaId, old)).toMatchObject({ status: "evaluation_failed", evaluation_failure: "timed_out" })
    await runAllJobs()
    expect(anthropic.requests).toHaveLength(1)
    expect((await statusOf(database.db, adaId, visible)).status).toBe("ranked")
  })
})

describe("SEC-R-02 the Operator's recovery never touches an invitee's private pasted row (RLS)", () => {
  it("Kofi's stranded private pasted description stays checking after Ada's Check again and the scheduled run", async () => {
    const kofiPosting = await insertPasted(kofiId)
    const adaPosting = await insertPasted(adaId)
    clock.set(at("08:30:00"))
    anthropic.replyWithObject(STRONG)
    anthropic.replyWithObject(STRONG)
    await checkAgain().expect(200)
    await runScheduled()
    expect((await allJobs()).map((job) => job.postingId)).toContain(adaPosting)
    expect(await jobsFor(kofiPosting)).toEqual([])
    expect(await statusOf(database.db, kofiId, kofiPosting)).toMatchObject({ status: "checking" })
    expect(await checkingSinceOf(database.db, kofiId, kofiPosting)).toEqual(STUCK_SINCE)
    await runAllJobs()
    expect(await statusOf(database.db, kofiId, kofiPosting)).toMatchObject({ status: "checking" })
  })

  /** A Candidate-private pasted-description posting held by `candidateId`, stuck in checking since 08:00. */
  async function insertPasted(candidateId: string): Promise<string> {
    const id = await insertPosting(database.db, { title: "Senior Frontend Engineer", company: "Paystack", postingText: DESCRIPTION })
    await sql`update job_posting set origin = 'pasted_description', owner_candidate_id = ${candidateId}::uuid, paste_fingerprint = ${id}, apply_mode = 'manual' where id = ${id}::uuid`.execute(database.db)
    await hold(database.db, candidateId, id, { status: "checking", checkingSince: STUCK_SINCE })
    await sql`update candidate_posting set origin = 'pasted_description' where candidate_id = ${candidateId}::uuid and job_posting_id = ${id}::uuid`.execute(database.db)
    return id
  }
})
