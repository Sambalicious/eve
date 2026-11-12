import type { INestApplication } from "@nestjs/common"
import {
  CSRF_HEADER,
  DEFAULT_JOB_CRITERIA,
  DEFAULT_SENIORITY_FLOOR,
  DEFAULT_TARGET_ROLE_FAMILIES,
  JOB_CRITERIA_PATH,
  JOB_POSTINGS_CHECK_AGAIN_PATH,
  apiErrorResponseSchema,
  checkAgainResponseSchema,
  jobCriteriaResponseSchema,
} from "@eve/contracts"
import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { SESSION_COOKIE } from "../src/auth/cookies.js"
import { API_STATEMENT_TIMEOUT_MS } from "../src/db/statement-timeouts.js"
import { EvaluationQueue } from "../src/discovery/evaluation-queue.js"
import { JobCriteriaSaveLimiter } from "../src/job-criteria/job-criteria-save-limit.guard.js"
import { Browser } from "./support/browser.js"
import { FakeAnthropic, OutboundRecorder } from "./support/fake-anthropic.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { CANDIDATE_EMAIL, CANDIDATE_SUB, TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"
import {
  ALL_FAMILIES,
  DEFAULT_TARGETS,
  TODAY,
  clearPostings,
  hold,
  insertPosting,
  list,
  queuedEvaluations,
  readCriteria,
  resetCriteria,
  seed,
  setCriteria,
  signInSecondCandidate,
  snapshotPosting,
  statusOf,
} from "./support/epic-0006.js"

/**
 * EPIC-0006 QA test authoring (step [5e]): POST /v1/job-postings/check-again
 * and the Job criteria GET/PUT additions, against the real api, Postgres and
 * pg-boss schema. Source: api-contract.r1.md v1.18.0; gherkin r4
 * check-again-and-worker-key.feature (API scenarios),
 * target-families-and-seniority-settings.feature (API scenarios),
 * settings-apply-to-stored-postings.feature, per-candidate-tenancy.feature
 * (Check again and settings per Candidate). Expected to fail until the
 * EPIC-0006 backend lands.
 *
 * The api inserts evaluate.posting jobs in the claim transaction; no worker
 * runs in this file, so "the worker is not processing the queue" holds.
 * Worker-side behaviour is in evaluation-and-ingestion.epic-0006.int-spec.ts.
 */
let database: TestDatabase
let google: FakeGoogle
let anthropic: FakeAnthropic
let outbound: OutboundRecorder
let app: INestApplication
let browser: Browser
let ada: SignedInCandidate
let kofi: SignedInCandidate
let adaId: string
let kofiId: string
const clock = new TestClock(TODAY)

const BAD_REQUEST = { error: { code: "bad_request", message: "The request is not valid." } }
const CSRF_INVALID = { error: { code: "csrf_invalid", message: "The request is missing a valid CSRF token." } }
const UNAUTHENTICATED = { error: { code: "unauthenticated", message: "Sign in to continue." } }
const SESSION_EXPIRED = { error: { code: "session_expired", message: "Your session ended. Sign in with Google again to continue where you left off." } }

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  anthropic = new FakeAnthropic(google.server)
  outbound = new OutboundRecorder(google.server)
  app = await createTestApp({ databaseUrl: database.url, clock })
  browser = new Browser(app, google)
  ada = await signInCandidate(browser)
  adaId = database.operatorId
  ;({ candidate: kofi, id: kofiId } = await signInSecondCandidate(app, google, database.db))
})

beforeEach(async () => {
  clock.set(TODAY)
  app.get(JobCriteriaSaveLimiter).reset()
  anthropic.install()
  anthropic.reset()
  outbound.reset()
  await clearPostings(database.db)
  await resetCriteria(database.db)
  await database.db.deleteFrom("spend_entry").execute()
  await database.db.updateTable("control_state").set({ global_paused: false, cost_paused: false }).execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

const failed = (kind = "not_configured") => ({ status: "evaluation_failed", evaluationFailure: kind }) as const
const checkAgain = (who: SignedInCandidate) => who.post(JOB_POSTINGS_CHECK_AGAIN_PATH)
const spendRows = async () => Number((await sql<{ n: string }>`select count(*) as n from spend_entry`.execute(database.db)).rows[0]!.n)

async function seedFailed(candidateId: string, n: number, kind = "not_configured"): Promise<string[]> {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(await seed(database.db, candidateId, { title: `Senior Frontend Engineer ${i}` }, failed(kind)))
  return out
}

describe("AC-7.3 @AC-7.3 @AC-7.5 @AC-7.10 Check again for the Operator claims visible failed and not-checked rows (check-again:218-256, 383-432)", () => {
  it("check-again:218 confirming queues 3 failed + 1 not-checked, reports 4, moves them to checking, and the count drops to 0", async () => {
    const failedIds = await seedFailed(adaId, 3)
    const notChecked = await seed(database.db, adaId, { title: "Senior Software Engineer", family: "software_engineering" }, { status: "not_checked" })
    const response = await checkAgain(ada).send({}).expect(200)
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(checkAgainResponseSchema.parse(response.body)).toEqual({ queued: 4, movedTo: "checking" })
    for (const id of [...failedIds, notChecked]) expect((await statusOf(database.db, adaId, id)).status).toBe("checking")
    expect((await list(ada, "tab=all")).recheckableCount).toBe(0)
    const jobs = await queuedEvaluations(database.db)
    expect(jobs.map((j) => j.postingId).sort()).toEqual([...failedIds, notChecked].sort())
    expect(jobs.every((j) => j.candidateId === adaId)).toBe(true)
    expect(anthropic.requests).toHaveLength(0)
  })

  it("check-again:236 @AC-7.10 queuing keeps the failure kind; the checking row counts in neither count", async () => {
    const [id] = await seedFailed(adaId, 1, "not_configured")
    await checkAgain(ada).send({}).expect(200)
    expect(await statusOf(database.db, adaId, id!)).toMatchObject({ status: "checking", evaluation_failure: "not_configured" })
    const page = await list(ada, "tab=all")
    expect(page).toMatchObject({ recheckableCount: 0, waitingToBeCheckedCount: 0 })
    expect(page.postings.find((p) => p.id === id)?.evaluationFailure).toBeNull()
  })

  it("check-again:383 @AC-7.1 hidden failed and not-checked postings are not queued and keep status and kind", async () => {
    await seedFailed(adaId, 2)
    const hiddenFailed: string[] = []
    for (let i = 0; i < 6; i++) hiddenFailed.push(await seed(database.db, adaId, { title: "Senior Data Engineer", family: "data_ml" }, failed("provider_error")))
    const hiddenNotChecked: string[] = []
    for (let i = 0; i < 3; i++) hiddenNotChecked.push(await seed(database.db, adaId, { postedAt: null }, { status: "not_checked" }))
    expect(checkAgainResponseSchema.parse((await checkAgain(ada).send({}).expect(200)).body)).toEqual({ queued: 2, movedTo: "checking" })
    for (const id of hiddenFailed) expect(await statusOf(database.db, adaId, id)).toMatchObject({ status: "evaluation_failed", evaluation_failure: "provider_error" })
    for (const id of hiddenNotChecked) expect((await statusOf(database.db, adaId, id)).status).toBe("not_checked")
    expect(await queuedEvaluations(database.db)).toHaveLength(2)
  })

  it("never claims checking, waiting_to_be_checked, ranked, skipped or excluded rows", async () => {
    const others = [
      // r4 (AC-7.11): not stuck, it moved into checking at the press.
      await seed(database.db, adaId, {}, { status: "checking", checkingSince: clock.now() }),
      await seed(database.db, adaId, {}, { status: "waiting_to_be_checked" }),
      await seed(database.db, adaId, {}, { status: "ranked" }),
      await seed(database.db, adaId, {}, { status: "skipped", skipReason: "weak_core_match", covered: 5 }),
      await seed(database.db, adaId, {}, { status: "excluded", skipReason: "violated_rule" }),
    ]
    const before = await Promise.all(others.map((id) => snapshotPosting(database.db, id)))
    expect(checkAgainResponseSchema.parse((await checkAgain(ada).send({}).expect(200)).body)).toEqual({ queued: 0, movedTo: "checking" })
    expect(await Promise.all(others.map((id) => snapshotPosting(database.db, id)))).toEqual(before)
    expect(await queuedEvaluations(database.db)).toEqual([])
  })

  it("check-again:187 / P13 the request ignores the tab, the Posting filter and the cursor: every eligible row is claimed", async () => {
    await seed(database.db, adaId, { title: "Senior Backend Engineer", family: "backend" }, failed())
    await seed(database.db, adaId, { title: "Senior iOS Engineer", family: "mobile" }, failed())
    const response = await ada.post(`${JOB_POSTINGS_CHECK_AGAIN_PATH}?tab=ranked&families=mobile`).send({})
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ queued: 2, movedTo: "checking" })
  })
})

describe("AC-7.5 @AC-7.5 @duplicate the claim is the only dedupe (check-again:393-432)", () => {
  it("check-again:394 pressing twice: 3 then 0, each posting queued once", async () => {
    const posted = await seedFailed(adaId, 3)
    expect((await checkAgain(ada).send({}).expect(200)).body).toEqual({ queued: 3, movedTo: "checking" })
    expect((await checkAgain(ada).send({}).expect(200)).body).toEqual({ queued: 0, movedTo: "checking" })
    const jobs = await queuedEvaluations(database.db)
    expect(jobs.map((j) => j.postingId).sort()).toEqual([...posted].sort())
  })

  it("check-again:405 a press while earlier checks are queued adds only the newly failed posting", async () => {
    await seedFailed(adaId, 3)
    await checkAgain(ada).send({}).expect(200)
    const late = await seed(database.db, adaId, { title: "Late" }, failed("provider_error"))
    expect((await checkAgain(ada).send({}).expect(200)).body).toEqual({ queued: 1, movedTo: "checking" })
    const jobs = await queuedEvaluations(database.db)
    expect(jobs).toHaveLength(4)
    expect(new Set(jobs.map((j) => j.postingId)).size).toBe(4)
    expect(jobs.filter((j) => j.postingId === late)).toHaveLength(1)
  })

  it("check-again:413 postings waiting for the cost pause are not queued a second time", async () => {
    for (let i = 0; i < 3; i++) await seed(database.db, adaId, {}, { status: "waiting_to_be_checked" })
    await seedFailed(adaId, 1)
    expect((await checkAgain(ada).send({}).expect(200)).body).toEqual({ queued: 1, movedTo: "checking" })
    expect(await queuedEvaluations(database.db)).toHaveLength(1)
  })

  it("check-again:421 a posting already checking (queued by discovery) is not queued again", async () => {
    await seed(database.db, adaId, { title: "Senior Software Engineer at Lumon", family: "software_engineering" }, { status: "checking", checkingSince: clock.now() })
    expect((await checkAgain(ada).send({}).expect(200)).body).toEqual({ queued: 0, movedTo: "checking" })
    expect(await queuedEvaluations(database.db)).toEqual([])
  })

  it("check-again:435 (@manual in Gherkin, automated here) two concurrent presses claim disjoint rows summing to 50", async () => {
    await seedFailed(adaId, 50)
    const [a, b] = await Promise.all([checkAgain(ada).send({}), checkAgain(ada).send({})])
    expect([a.status, b.status]).toEqual([200, 200])
    expect(a.body.queued + b.body.queued).toBe(50)
    const jobs = await queuedEvaluations(database.db)
    expect(jobs).toHaveLength(50)
    expect(new Set(jobs.map((j) => j.postingId)).size).toBe(50)
  })
})

describe("AC-7.5 @AC-7.5 @permission @validation Check again auth, CSRF and strict body (check-again:444-511)", () => {
  async function nothingQueued(postings: string[]) {
    expect(await queuedEvaluations(database.db)).toEqual([])
    for (const id of postings) expect((await statusOf(database.db, adaId, id)).status).toBe("evaluation_failed")
    expect(anthropic.requests).toHaveLength(0)
  }

  it.each(["no CSRF token", "a CSRF token from a different session", "an altered CSRF token"])("check-again:445 %s is 403 csrf_invalid and queues nothing", async (label) => {
    const posted = await seedFailed(adaId, 3)
    let token: string | null = null
    if (label === "a CSRF token from a different session") token = kofi.csrfToken
    if (label === "an altered CSRF token") token = `${ada.csrfToken}x`
    let call = browser.http().post(JOB_POSTINGS_CHECK_AGAIN_PATH).set("cookie", ada.cookie)
    if (token !== null) call = call.set(CSRF_HEADER, token)
    const response = await call.send({}).expect(403)
    expect(response.body).toEqual(CSRF_INVALID)
    await nothingQueued(posted)
  })

  it("check-again:459 without a session: 401 unauthenticated, nothing queued", async () => {
    const posted = await seedFailed(adaId, 3)
    expect((await browser.http().post(JOB_POSTINGS_CHECK_AGAIN_PATH).send({}).expect(401)).body).toEqual(UNAUTHENTICATED)
    await nothingQueued(posted)
  })

  it("check-again:467 after the 14-day idle expiry: 401 session_expired, nothing queued", async () => {
    const posted = await seedFailed(adaId, 3)
    const { sessionCookie } = await browser.signIn({ sub: CANDIDATE_SUB, email: CANDIDATE_EMAIL, email_verified: true })
    const csrf = (await browser.getSession(sessionCookie).expect(200)).body.csrfToken as string
    clock.set("2026-11-08T09:00:01+01:00")
    const response = await browser.http().post(JOB_POSTINGS_CHECK_AGAIN_PATH).set("cookie", `${SESSION_COOKIE}=${sessionCookie}`).set(CSRF_HEADER, csrf).send({}).expect(401)
    expect(response.body).toEqual(SESSION_EXPIRED)
    await nothingQueued(posted)
  })

  it("check-again:475 a body naming the hidden posting's id is 400 with no fieldErrors, and all 3 keep their status and kind", async () => {
    const visible = await seedFailed(adaId, 2)
    const hidden = await seed(database.db, adaId, { title: "Senior Data Engineer", family: "data_ml" }, failed("provider_error"))
    const response = await checkAgain(ada).send({ postingIds: [hidden] }).expect(400)
    expect(response.body).toEqual(BAD_REQUEST)
    await nothingQueued([...visible, hidden])
    expect((await statusOf(database.db, adaId, hidden)).evaluation_failure).toBe("provider_error")
  })

  it.each([
    ['{"postingIds": ["p-1"]}', { postingIds: ["p-1"] }],
    ['{"ids": []}', { ids: [] }],
    ['{"candidateId": "c-1"}', { candidateId: "c-1" }],
    ["[]", []],
  ])("check-again:484 body %s is 400 bad_request with no fieldErrors, nothing queued", async (_label, body) => {
    const posted = await seedFailed(adaId, 3)
    const response = await checkAgain(ada).send(body).expect(400)
    expect(response.body).toEqual(BAD_REQUEST)
    await nothingQueued(posted)
  })

  it.each([
    ["null", "null"],
    ['"x"', '"x"'],
  ])("check-again:484 raw JSON body %s is 400 bad_request, nothing queued", async (_label, raw) => {
    const posted = await seedFailed(adaId, 3)
    const response = await checkAgain(ada).set("content-type", "application/json").send(raw).expect(400)
    expect(apiErrorResponseSchema.parse(response.body)).toEqual(BAD_REQUEST)
    await nothingQueued(posted)
  })

  it.each(["no body", "the body {}"])("check-again:501 a request with %s is accepted, 3 queued, moved to checking", async (label) => {
    const posted = await seedFailed(adaId, 3)
    const call = checkAgain(ada)
    const response = label === "no body" ? await call.expect(200) : await call.send({}).expect(200)
    expect(response.body).toEqual({ queued: 3, movedTo: "checking" })
    for (const id of posted) expect((await statusOf(database.db, adaId, id)).status).toBe("checking")
  })

  it("a ?candidateId= query naming Kofi is ignored; the press acts for the session Candidate", async () => {
    const kofiPosting = await seed(database.db, kofiId, {}, failed())
    expect((await ada.post(`${JOB_POSTINGS_CHECK_AGAIN_PATH}?candidateId=${kofiId}`).send({}).expect(200)).body).toEqual({ queued: 0, movedTo: "checking" })
    expect((await statusOf(database.db, kofiId, kofiPosting)).status).toBe("evaluation_failed")
  })
})

describe("AC-7.4 @AC-7.4 @AC-7.9 pauses and spend at the request (check-again:329-381)", () => {
  it("check-again:329 during the cost pause the Operator's rows still move to checking with jobs; the request spends nothing", async () => {
    await database.db.updateTable("control_state").set({ cost_paused: true }).execute()
    await seedFailed(adaId, 4)
    expect((await checkAgain(ada).send({}).expect(200)).body).toEqual({ queued: 4, movedTo: "checking" })
    expect(await queuedEvaluations(database.db)).toHaveLength(4)
    expect(await spendRows()).toBe(0)
    expect(anthropic.requests).toHaveLength(0)
  })

  it("check-again:341 during the global pause the request is accepted and queues", async () => {
    await database.db.updateTable("control_state").set({ global_paused: true }).execute()
    await seedFailed(adaId, 1)
    expect((await checkAgain(ada).send({}).expect(200)).body).toEqual({ queued: 1, movedTo: "checking" })
    expect(await queuedEvaluations(database.db)).toHaveLength(1)
  })

  it("check-again:375 Check again adds no budget, cap or price", async () => {
    const before = await sql`select * from spend_month order by month`.execute(database.db)
    const activation = await sql`select * from activation_state`.execute(database.db)
    await seedFailed(adaId, 5)
    await checkAgain(ada).send({}).expect(200)
    expect((await sql`select * from spend_month order by month`.execute(database.db)).rows).toEqual(before.rows)
    expect((await sql`select * from activation_state`.execute(database.db)).rows).toEqual(activation.rows)
  })
})

describe("per-candidate-tenancy Check again per Candidate (@AC-7.3 @AC-7.4 @AC-7.5, per-candidate:260-410)", () => {
  it("per-candidate:260 the Operator's press queues only the Operator's rows; Kofi's rows (two of them shared) are unchanged", async () => {
    const adaRows = await seedFailed(adaId, 3)
    const kofiRows = [adaRows[0]!, adaRows[1]!]
    for (const id of kofiRows) await hold(database.db, kofiId, id, failed("timed_out"))
    for (let i = 0; i < 2; i++) kofiRows.push(await seed(database.db, kofiId, {}, failed("timed_out")))
    expect((await checkAgain(ada).send({}).expect(200)).body).toEqual({ queued: 3, movedTo: "checking" })
    for (const id of adaRows) expect((await statusOf(database.db, adaId, id)).status).toBe("checking")
    for (const id of kofiRows) expect(await statusOf(database.db, kofiId, id)).toMatchObject({ status: "evaluation_failed", evaluation_failure: "timed_out" })
    expect((await queuedEvaluations(database.db)).every((j) => j.candidateId === adaId)).toBe(true)
  })

  it("per-candidate:271 a non-Operator's press moves 2 failed + 3 not-checked to waiting, queues no job, spends nothing", async () => {
    const rows = [...(await seedFailed(kofiId, 2)), ...(await Promise.all([0, 1, 2].map(() => seed(database.db, kofiId, {}, { status: "not_checked" }))))]
    const response = await checkAgain(kofi).send({}).expect(200)
    expect(checkAgainResponseSchema.parse(response.body)).toEqual({ queued: 5, movedTo: "waiting_to_be_checked" })
    for (const id of rows) expect((await statusOf(database.db, kofiId, id)).status).toBe("waiting_to_be_checked")
    expect(await queuedEvaluations(database.db)).toEqual([])
    expect(anthropic.requests).toHaveLength(0)
    expect(await spendRows()).toBe(0)
    expect(await list(kofi, "tab=all")).toMatchObject({ waitingToBeCheckedCount: 5, recheckableCount: 0, waitingReason: "checks_not_enabled" })
  })

  it("per-candidate:307 / :315 a non-Operator's second press reports 0, moved to waiting_to_be_checked", async () => {
    await seedFailed(kofiId, 3)
    expect((await checkAgain(kofi).send({}).expect(200)).body).toEqual({ queued: 3, movedTo: "waiting_to_be_checked" })
    expect((await checkAgain(kofi).send({}).expect(200)).body).toEqual({ queued: 0, movedTo: "waiting_to_be_checked" })
  })

  it("per-candidate:324 a non-Operator's press leaves the Operator's row of the same posting unchanged", async () => {
    const id = await insertPosting(database.db, { title: "Senior Frontend Engineer at Globex" })
    await hold(database.db, adaId, id, failed("not_configured"))
    await hold(database.db, kofiId, id, { status: "not_checked" })
    await checkAgain(kofi).send({}).expect(200)
    expect((await statusOf(database.db, kofiId, id)).status).toBe("waiting_to_be_checked")
    expect(await statusOf(database.db, adaId, id)).toMatchObject({ status: "evaluation_failed", evaluation_failure: "not_configured" })
    expect((await list(ada, "tab=all")).recheckableCount).toBe(1)
  })

  it("per-candidate:399 a body naming Kofi's id or posting ids is 400 and nothing changes for either Candidate", async () => {
    const kofiRows = await seedFailed(kofiId, 3)
    for (const body of [{ candidateId: kofiId }, { postingIds: kofiRows }]) {
      expect((await checkAgain(ada).send(body).expect(400)).body).toEqual(BAD_REQUEST)
    }
    for (const id of kofiRows) expect((await statusOf(database.db, kofiId, id)).status).toBe("evaluation_failed")
    expect(await queuedEvaluations(database.db)).toEqual([])
  })

  it("per-candidate:410 (@manual in Gherkin, automated here) simultaneous presses: Ada 20 checking with jobs, Kofi 20 waiting with none", async () => {
    const shared: string[] = []
    for (let i = 0; i < 20; i++) {
      const id = await insertPosting(database.db, { title: `Shared ${i}` })
      await hold(database.db, adaId, id, failed())
      await hold(database.db, kofiId, id, failed())
      shared.push(id)
    }
    const [a, k] = await Promise.all([checkAgain(ada).send({}), checkAgain(kofi).send({})])
    expect(a.body).toEqual({ queued: 20, movedTo: "checking" })
    expect(k.body).toEqual({ queued: 20, movedTo: "waiting_to_be_checked" })
    const jobs = await queuedEvaluations(database.db)
    expect(jobs).toHaveLength(20)
    expect(jobs.every((j) => j.candidateId === adaId)).toBe(true)
    for (const id of shared) expect((await statusOf(database.db, kofiId, id)).status).toBe("waiting_to_be_checked")
  })
})

const body = (over: Record<string, unknown> = {}) => ({ minCoreMatchPercent: 70, frameworks: [], technologies: [], targetRoleFamilies: [...DEFAULT_TARGETS], seniorityFloor: "hide_entry_level", ...over })
const put = (who: SignedInCandidate, payload: unknown) => who.put(JOB_CRITERIA_PATH).send(payload as object)

describe("AC-1.5 @AC-1.5 @AC-1.6 @AC-2.1 Job criteria GET and PUT gain targetRoleFamilies and seniorityFloor (target-families feature, API)", () => {
  it("target-families:64 / per-candidate:41 a Candidate who never saved reads the 9 defaults and hide_entry_level", async () => {
    for (const who of [ada, kofi]) {
      const response = await who.get(JOB_CRITERIA_PATH).expect(200)
      expect(response.headers["cache-control"]).toBe("no-store")
      expect(jobCriteriaResponseSchema.parse(response.body)).toEqual({ minCoreMatchPercent: 70, frameworks: [], technologies: [], targetRoleFamilies: [...DEFAULT_TARGETS], seniorityFloor: "hide_entry_level", version: 1 })
    }
    expect([...DEFAULT_TARGET_ROLE_FAMILIES]).toEqual([...DEFAULT_TARGETS])
    expect(DEFAULT_SENIORITY_FLOOR).toBe("hide_entry_level")
    expect(DEFAULT_JOB_CRITERIA).toMatchObject({ targetRoleFamilies: [...DEFAULT_TARGETS], seniorityFloor: "hide_entry_level" })
  })

  it("target-families:81 / :103 one save stores families, seniority and the EPIC-0004 fields together, version+1", async () => {
    const response = await put(ada, body({ minCoreMatchPercent: 80, frameworks: ["React"], targetRoleFamilies: [...DEFAULT_TARGETS, "data_ml"], seniorityFloor: "all_levels" })).expect(200)
    expect(jobCriteriaResponseSchema.parse(response.body)).toMatchObject({ minCoreMatchPercent: 80, frameworks: ["React"], targetRoleFamilies: [...DEFAULT_TARGETS.slice(0, 8), "people_management", "data_ml"], seniorityFloor: "all_levels", version: 2 })
    expect(await readCriteria(database.db, adaId)).toMatchObject({ floor: "all_levels", min: 80, version: 2 })
  })

  it("target-families:113 exactly one family is accepted", async () => {
    expect((await put(ada, body({ targetRoleFamilies: ["backend"] })).expect(200)).body.targetRoleFamilies).toEqual(["backend"])
  })

  it("target-families:120 all thirteen families can be saved", async () => {
    expect((await put(ada, body({ targetRoleFamilies: [...ALL_FAMILIES] })).expect(200)).body.targetRoleFamilies).toEqual([...ALL_FAMILIES])
  })

  it("target-families:243 any order is accepted and stored in catalog order", async () => {
    expect((await put(ada, body({ targetRoleFamilies: ["other", "data_ml", "senior_frontend"] })).expect(200)).body.targetRoleFamilies).toEqual(["senior_frontend", "data_ml", "other"])
    expect((await readCriteria(database.db, adaId)).targets).toEqual(["senior_frontend", "data_ml", "other"])
  })

  it("target-families:265 saving the same families twice gives the same result and changes no posting", async () => {
    const id = await seed(database.db, adaId, {}, { status: "ranked" })
    const before = await snapshotPosting(database.db, id)
    await put(ada, body({ targetRoleFamilies: [...DEFAULT_TARGETS, "data_ml"] })).expect(200)
    const second = await put(ada, body({ targetRoleFamilies: [...DEFAULT_TARGETS, "data_ml"] })).expect(200)
    expect(second.body.version).toBe(3)
    const after = JSON.parse(await snapshotPosting(database.db, id)) as unknown[][]
    const was = JSON.parse(before) as unknown[][]
    expect(after[0]).toEqual(was[0])
    expect(after[1]).toEqual(was[1])
  })

  it.each([
    [[], null, "too_few_entries"],
    [["robotics"], 1, "unknown_entry"],
    [["senior_frontend", "robotics"], 2, "unknown_entry"],
    [["Senior_Frontend"], 1, "unknown_entry"],
    [["senior-frontend"], 1, "unknown_entry"],
    [["frontend"], 1, "unknown_entry"],
    [[""], 1, "unknown_entry"],
    [[null], 1, "invalid"],
    [[1], 1, "invalid"],
    [["backend", "backend"], 2, "duplicate_entry"],
    [["backend", "mobile", "backend"], 3, "duplicate_entry"],
    ["backend", null, "invalid"],
    [null, null, "invalid"],
    [{ backend: true }, null, "invalid"],
  ])("target-families:162 families %j: 400 with fieldError position %j problem %s, nothing stored", async (families, position, problem) => {
    await setCriteria(database.db, adaId, { min: 70 })
    const response = await put(ada, body({ minCoreMatchPercent: 60, targetRoleFamilies: families })).expect(400)
    const error = apiErrorResponseSchema.parse(response.body).error
    expect(error.code).toBe("bad_request")
    expect(error.message).toBe("The request is not valid.")
    expect(error.fieldErrors).toContainEqual({ field: "targetRoleFamilies", position, problem })
    expect(await readCriteria(database.db, adaId)).toEqual({ targets: [...DEFAULT_TARGETS], floor: "hide_entry_level", min: 70, version: 1 })
  })

  it("target-families:189 more than thirteen entries gives exactly one whole-field too_many_entries error", async () => {
    const response = await put(ada, body({ targetRoleFamilies: [...ALL_FAMILIES, "backend"] })).expect(400)
    expect(response.body.error.fieldErrors).toEqual([{ field: "targetRoleFamilies", position: null, problem: "too_many_entries" }])
    expect((await readCriteria(database.db, adaId)).targets).toEqual([...DEFAULT_TARGETS])
  })

  it.each(["targetRoleFamilies", "seniorityFloor"])("target-families:196 a save without %s is 400 invalid at position null", async (field) => {
    const payload = body() as Record<string, unknown>
    delete payload[field]
    const response = await put(ada, payload).expect(400)
    expect(response.body.error.fieldErrors).toContainEqual({ field, position: null, problem: "invalid" })
    expect(await readCriteria(database.db, adaId)).toMatchObject({ targets: [...DEFAULT_TARGETS], floor: "hide_entry_level" })
  })

  it.each(["senior_only", "", null, true, 1])("target-families:211 seniority floor %j is 400 invalid, floor unchanged", async (floor) => {
    const response = await put(ada, body({ seniorityFloor: floor })).expect(400)
    expect(response.body.error.fieldErrors).toContainEqual({ field: "seniorityFloor", position: null, problem: "invalid" })
    expect((await readCriteria(database.db, adaId)).floor).toBe("hide_entry_level")
  })

  it.each([{ version: 4 }, { baseVersion: 4 }, { notes: "x" }])("target-families:226 an unknown field %j is 400 with no fieldErrors; version stays 4", async (extra) => {
    await setCriteria(database.db, adaId, { version: 4 })
    const response = await put(ada, { ...body({ targetRoleFamilies: ["data_ml"] }), ...extra }).expect(400)
    expect(response.body).toEqual(BAD_REQUEST)
    expect(await readCriteria(database.db, adaId)).toMatchObject({ targets: [...DEFAULT_TARGETS], floor: "hide_entry_level", version: 4 })
  })

  it("target-families:275 saving without a session is 401 and nothing changes", async () => {
    expect((await browser.http().put(JOB_CRITERIA_PATH).send(body({ targetRoleFamilies: ["data_ml"] })).expect(401)).body).toEqual(UNAUTHENTICATED)
    expect((await readCriteria(database.db, adaId)).targets).toEqual([...DEFAULT_TARGETS])
  })

  it.each(["no CSRF token", "a CSRF token from a different session", "an altered CSRF token"])("target-families:283 %s is 403 and nothing changes", async (label) => {
    let call = browser.http().put(JOB_CRITERIA_PATH).set("cookie", ada.cookie)
    if (label === "a CSRF token from a different session") call = call.set(CSRF_HEADER, kofi.csrfToken)
    if (label === "an altered CSRF token") call = call.set(CSRF_HEADER, `${ada.csrfToken}x`)
    expect((await call.send(body({ targetRoleFamilies: ["data_ml"], seniorityFloor: "all_levels" })).expect(403)).body).toEqual(CSRF_INVALID)
    expect(await readCriteria(database.db, adaId)).toMatchObject({ targets: [...DEFAULT_TARGETS], floor: "hide_entry_level" })
  })

  it("target-families:298 a body naming Kofi's id is 400 with no fieldErrors; neither Candidate's criteria change", async () => {
    await setCriteria(database.db, adaId, { version: 3 })
    const response = await put(ada, { ...body({ targetRoleFamilies: ["data_ml"] }), candidateId: kofiId }).expect(400)
    expect(response.body).toEqual(BAD_REQUEST)
    expect(await readCriteria(database.db, adaId)).toMatchObject({ targets: [...DEFAULT_TARGETS], version: 3 })
    expect(await readCriteria(database.db, kofiId)).toMatchObject({ targets: [...DEFAULT_TARGETS], version: 1 })
  })

  it("target-families:308 a Candidate id in the address is ignored and the save applies to the session Candidate", async () => {
    await ada.put(`${JOB_CRITERIA_PATH}?candidateId=${kofiId}`).send(body({ targetRoleFamilies: ["data_ml"] })).expect(200)
    expect((await readCriteria(database.db, adaId)).targets).toEqual(["data_ml"])
    expect((await readCriteria(database.db, kofiId)).targets).toEqual([...DEFAULT_TARGETS])
  })

  it("target-families:317 reading Job criteria without a session is 401 with no families", async () => {
    const response = await browser.http().get(JOB_CRITERIA_PATH).expect(401)
    expect(response.body).toEqual(UNAUTHENTICATED)
  })

  it("target-families:336 with two tabs, the last successful family save wins without a version check", async () => {
    await put(ada, body({ targetRoleFamilies: ["backend"] })).expect(200)
    await put(ada, body({ targetRoleFamilies: ["mobile"] })).expect(200)
    expect((await readCriteria(database.db, adaId)).targets).toEqual(["mobile"])
  })

  it("per-candidate:48 / :55 a family save and a floor save change only the saving Candidate", async () => {
    await put(kofi, body({ targetRoleFamilies: [...DEFAULT_TARGETS, "data_ml"] })).expect(200)
    await put(ada, body({ seniorityFloor: "all_levels" })).expect(200)
    expect(await readCriteria(database.db, kofiId)).toMatchObject({ targets: [...DEFAULT_TARGETS.slice(0, 9), "data_ml"], floor: "hide_entry_level" })
    expect(await readCriteria(database.db, adaId)).toMatchObject({ targets: [...DEFAULT_TARGETS], floor: "all_levels" })
  })
})

describe("AC-4.1 @AC-4.1 @AC-4.2 @AC-4.3 @AC-4.4 a families or floor save applies to stored postings with no AI, fetch or spend (settings-apply feature)", () => {
  it("settings-apply:26 checking then unchecking Data and ML shows then hides an evaluated posting", async () => {
    const id = await seed(database.db, adaId, { title: "Senior Data Engineer at Initech", family: "data_ml" }, { status: "ranked" })
    expect((await list(ada)).postings.map((p) => p.id)).not.toContain(id)
    await put(ada, body({ targetRoleFamilies: [...DEFAULT_TARGETS, "data_ml"] })).expect(200)
    expect((await list(ada)).postings.find((p) => p.id === id)).toMatchObject({ status: "ranked", rank: 1 })
    await put(ada, body()).expect(200)
    expect((await list(ada)).postings.map((p) => p.id)).not.toContain(id)
  })

  it("settings-apply:46 / :57 / :105 / :117 families and floor saves make no AI call, no network fetch, no spend and change no status, skip reason or Match evidence", async () => {
    const rows = [
      await seed(database.db, adaId, { title: "Senior Data Engineer", family: "data_ml" }, { status: "ranked" }),
      await seed(database.db, adaId, { title: "Junior Frontend Developer", marker: "entry" }, { status: "skipped", skipReason: "weak_core_match", covered: 5 }),
      await seed(database.db, adaId, {}, { status: "not_checked" }),
      await seed(database.db, adaId, {}, failed()),
    ]
    const before = await Promise.all(rows.map(async (id) => JSON.parse(await snapshotPosting(database.db, id)) as unknown[][]))
    await put(ada, body({ targetRoleFamilies: [...ALL_FAMILIES] })).expect(200)
    await put(ada, body({ targetRoleFamilies: [...ALL_FAMILIES], seniorityFloor: "all_levels" })).expect(200)
    expect(anthropic.requests).toHaveLength(0)
    expect(outbound.urls).toEqual([])
    expect(await spendRows()).toBe(0)
    expect(await queuedEvaluations(database.db)).toEqual([])
    for (const [i, id] of rows.entries()) {
      const after = JSON.parse(await snapshotPosting(database.db, id)) as Record<string, unknown>[][]
      expect(after[0]).toEqual(before[i]![0])
      expect(after[1]).toEqual(before[i]![1])
      // Match evidence: only criteria_version is restamped.
      const strip = (rowsOf: unknown[]) => (rowsOf as Record<string, unknown>[]).map((row) => ({ ...row, criteria_version: "restamped" }))
      expect(strip(after[2]!)).toEqual(strip(before[i]![2]!))
    }
  })

  it("settings-apply:67 / :75 Show all levels shows entry-level postings on the next load; hiding again hides them", async () => {
    const id = await seed(database.db, adaId, { title: "Junior Frontend Developer", marker: "entry" }, { status: "ranked" })
    await put(ada, body({ seniorityFloor: "all_levels" })).expect(200)
    expect((await list(ada)).postings.map((p) => p.id)).toContain(id)
    await put(ada, body({ seniorityFloor: "hide_entry_level" })).expect(200)
    expect((await list(ada)).postings.map((p) => p.id)).not.toContain(id)
  })

  it("settings-apply:94 a save applies to every stored posting, not only the loaded page", async () => {
    for (let i = 0; i < 60; i++) await seed(database.db, adaId, { title: `Senior iOS Engineer ${i}`, family: "mobile" }, { status: "ranked" })
    await list(ada, "tab=ranked&limit=25")
    await put(ada, body({ targetRoleFamilies: DEFAULT_TARGETS.filter((f) => f !== "mobile") })).expect(200)
    const page = await list(ada, "tab=ranked")
    expect(page.totalCount).toBe(0)
    expect(page.hiddenCounts.offTarget).toBe(60)
  })

  it("settings-apply:126 a save changing families and the minimum re-decides by the minimum only", async () => {
    const weak = await seed(database.db, adaId, { title: "Senior Frontend A" }, { status: "ranked", covered: 7 })
    const data = await seed(database.db, adaId, { title: "Senior Data B", family: "data_ml" }, { status: "ranked", covered: 7 })
    await put(ada, body({ minCoreMatchPercent: 80, targetRoleFamilies: DEFAULT_TARGETS.filter((f) => f !== "senior_frontend") })).expect(200)
    expect(await statusOf(database.db, adaId, weak)).toMatchObject({ status: "skipped", skip_reason: "weak_core_match" })
    expect(await statusOf(database.db, adaId, data)).toMatchObject({ status: "skipped", skip_reason: "weak_core_match" })
  })

  it("settings-apply:147 / :156 / :163 / :171 a posting made visible by a save is not sent for evaluation; it is on All only, recheckable, not waiting", async () => {
    const id = await seed(database.db, adaId, { title: "Senior Data Engineer", family: "data_ml" }, { status: "not_checked" })
    await put(ada, body({ targetRoleFamilies: [...DEFAULT_TARGETS, "data_ml"] })).expect(200)
    expect(await queuedEvaluations(database.db)).toEqual([])
    expect(anthropic.requests).toHaveLength(0)
    expect((await statusOf(database.db, adaId, id)).status).toBe("not_checked")
    expect((await list(ada, "tab=all")).postings.map((p) => p.id)).toContain(id)
    expect((await list(ada, "tab=ranked")).postings.map((p) => p.id)).not.toContain(id)
    expect((await list(ada, "tab=skipped")).postings.map((p) => p.id)).not.toContain(id)
    expect(await list(ada, "tab=all")).toMatchObject({ recheckableCount: 1, waitingToBeCheckedCount: 0 })
  })

  it("settings-apply:189 a not-checked posting hidden again keeps its status and appears nowhere", async () => {
    const id = await seed(database.db, adaId, { title: "Senior Data Engineer", family: "data_ml" }, { status: "not_checked" })
    await put(ada, body({ targetRoleFamilies: [...DEFAULT_TARGETS, "data_ml"] })).expect(200)
    await put(ada, body()).expect(200)
    expect((await statusOf(database.db, adaId, id)).status).toBe("not_checked")
    for (const tab of ["ranked", "skipped", "all"]) expect((await list(ada, `tab=${tab}`)).postings.map((p) => p.id)).not.toContain(id)
    expect((await list(ada)).recheckableCount).toBe(0)
  })

  it("settings-apply:211 a family save with no stored postings succeeds", async () => {
    await put(ada, body({ targetRoleFamilies: ["data_ml"] })).expect(200)
  })

  it("per-candidate:61 Kofi's save leaves Ada's list, statuses and spend unchanged", async () => {
    const id = await insertPosting(database.db, { title: "Senior Data Engineer at Initech", family: "data_ml" })
    await hold(database.db, adaId, id, { status: "ranked" })
    await hold(database.db, kofiId, id, { status: "not_checked" })
    const adaBefore = await list(ada, "tab=all")
    await put(kofi, body({ targetRoleFamilies: [...DEFAULT_TARGETS, "data_ml"] })).expect(200)
    expect(await list(ada, "tab=all")).toEqual(adaBefore)
    expect((await statusOf(database.db, adaId, id)).status).toBe("ranked")
    expect((await statusOf(database.db, kofiId, id)).status).toBe("not_checked")
    expect(anthropic.requests).toHaveLength(0)
    expect(await spendRows()).toBe(0)
  })
})

describe("CHK-5 / CHK-7 @AC-7.5 Check again claim and enqueue are atomic and bounded (threat-model CHK-5, CHK-7, SEC-603)", () => {
  it("CHK-5 a failure while inserting the jobs, after the claim UPDATE, rolls back: no status changes, no job, 500", async () => {
    const posted = await seedFailed(adaId, 3)
    const queue = app.get(EvaluationQueue)
    const seen: { trxIsTransaction: boolean; ids: readonly string[] }[] = []
    const spy = vi.spyOn(queue, "enqueue").mockImplementation(async (trx, _candidateId, ids) => {
      // The claim already ran in `trx`: the rows read as claimed inside the transaction.
      const inside = await sql<{ n: string }>`select count(*) as n from candidate_posting where status = 'checking'`.execute(trx)
      seen.push({ trxIsTransaction: trx.isTransaction, ids })
      expect(inside.rows[0]!.n).toBe("3")
      throw new Error("forced enqueue failure (CHK-5)")
    })
    try {
      const response = await checkAgain(ada).send({}).expect(500)
      expect(response.body).toEqual({ error: { code: "internal_error", message: "Something went wrong." } })
    } finally {
      spy.mockRestore()
    }
    expect(seen).toHaveLength(1)
    expect(seen[0]!.trxIsTransaction).toBe(true)
    expect([...seen[0]!.ids].sort()).toEqual([...posted].sort())
    for (const id of posted) expect(await statusOf(database.db, adaId, id)).toMatchObject({ status: "evaluation_failed", evaluation_failure: "not_configured" })
    expect(await queuedEvaluations(database.db)).toEqual([])
    expect((await list(ada, "tab=all")).recheckableCount).toBe(3)
  })

  it("CHK-5 a job-insert failure inside pg-boss (not a mocked enqueue) rolls back the claim too", async () => {
    const posted = await seedFailed(adaId, 2)
    // Make pg-boss's own insert fail in the claim transaction: a trigger on its job table raises for this queue.
    await sql`create or replace function pgboss.e6_refuse_insert() returns trigger language plpgsql as $$ begin raise exception 'e6 forced job insert failure'; end $$`.execute(database.db)
    await sql`create trigger e6_refuse_insert before insert on pgboss.job for each row when (new.name = 'evaluate.posting') execute function pgboss.e6_refuse_insert()`.execute(database.db)
    try {
      await checkAgain(ada).send({}).expect(500)
    } finally {
      await sql`drop trigger if exists e6_refuse_insert on pgboss.job`.execute(database.db)
      await sql`drop function if exists pgboss.e6_refuse_insert()`.execute(database.db)
    }
    for (const id of posted) expect((await statusOf(database.db, adaId, id)).status).toBe("evaluation_failed")
    expect(await queuedEvaluations(database.db)).toEqual([])
    // Afterwards the same press succeeds: nothing was left half-claimed.
    expect((await checkAgain(ada).send({}).expect(200)).body).toEqual({ queued: 2, movedTo: "checking" })
  })

  it("CHK-7 a 929-row claim with its 929 jobs completes inside the api statement timeout (5 s)", async () => {
    // 929 visible failed postings (the live failure count), inserted in bulk.
    await sql`insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, title_folded, company, structured, role_family, discovered_at, posted_at, posted_date_kind, seniority_marker, posting_text)
      select gen_random_uuid(), 'https://x.test/chk7/' || g, 'CHK7-' || g, 'https://x.test/chk7/' || g, 'greenhouse', 'automatic', 'employer_board',
        'Senior Frontend Engineer ' || g, 'senior frontend engineer ' || g, 'Co', '{}', 'senior_frontend', now(), timestamptz '2026-10-20T00:00:00Z', 'published', 'mid_plus', 'x'
      from generate_series(1, 929) g`.execute(database.db)
    await sql`insert into candidate_posting (candidate_id, job_posting_id, origin, status, evaluation_failure, discovered_at, evaluated_at)
      select ${adaId}::uuid, id, origin, 'evaluation_failed', 'not_configured', discovered_at, now() from job_posting where application_url like 'https://x.test/chk7/%'`.execute(database.db)
    const started = performance.now()
    const response = await checkAgain(ada).send({}).expect(200)
    const elapsed = performance.now() - started
    expect(response.body).toEqual({ queued: 929, movedTo: "checking" })
    expect(elapsed).toBeLessThan(API_STATEMENT_TIMEOUT_MS)
    expect(await queuedEvaluations(database.db)).toHaveLength(929)
  }, 60_000)

  it("CHK-7 a claim blocked past the statement timeout returns 500 and rolls back fully", async () => {
    const posted = await seedFailed(adaId, 3)
    // Another session holds Ada's job_criteria row FOR UPDATE, so the claim's FOR SHARE read waits until the api
    // statement_timeout cancels it.
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let locked!: () => void
    const isLocked = new Promise<void>((resolve) => (locked = resolve))
    const holder = database.db.transaction().execute(async (trx) => {
      await sql`select 1 from job_criteria where candidate_id = ${adaId} for update`.execute(trx)
      locked()
      await held
    })
    await isLocked
    try {
      const response = await checkAgain(ada).send({})
      expect(response.status).toBe(500)
      expect(response.body.error.code).toBe("internal_error")
    } finally {
      release()
      await holder
    }
    for (const id of posted) expect((await statusOf(database.db, adaId, id)).status).toBe("evaluation_failed")
    expect(await queuedEvaluations(database.db)).toEqual([])
  }, 30_000)
})

describe("CHK-21 @AC-1.5 prototype-pollution keys in Job criteria and Check again input (threat-model CHK-21, SEC-603)", () => {
  const raw = (who: SignedInCandidate, path: string, method: "put" | "post", text: string) =>
    who[method](path).set("content-type", "application/json").send(text)

  it.each([
    ["a top-level __proto__ key", `{"minCoreMatchPercent":70,"frameworks":[],"technologies":[],"targetRoleFamilies":["data_ml"],"seniorityFloor":"all_levels","__proto__":{"targetRoleFamilies":["other"],"isAdmin":true}}`],
    ["a top-level constructor.prototype key", `{"minCoreMatchPercent":70,"frameworks":[],"technologies":[],"targetRoleFamilies":["data_ml"],"seniorityFloor":"all_levels","constructor":{"prototype":{"isAdmin":true}}}`],
    ["a prototype key", `{"minCoreMatchPercent":70,"frameworks":[],"technologies":[],"targetRoleFamilies":["data_ml"],"seniorityFloor":"all_levels","prototype":{"isAdmin":true}}`],
  ])("a criteria save with %s is 400 bad_request (unknown field), stores nothing and pollutes no object", async (_label, body) => {
    const response = await raw(ada, JOB_CRITERIA_PATH, "put", body)
    // An own key outside the request schema is an unknown field: 400 with no fieldErrors (target-families:226).
    expect(response.status).toBe(400)
    expect(response.body).toEqual(BAD_REQUEST)
    expect(await readCriteria(database.db, adaId)).toMatchObject({ targets: [...DEFAULT_TARGETS], floor: "hide_entry_level", version: 1 })
    const probe: Record<string, unknown> = {}
    expect(probe.isAdmin).toBeUndefined()
    expect(probe.targetRoleFamilies).toBeUndefined()
    expect((Object.prototype as Record<string, unknown>).isAdmin).toBeUndefined()
  })

  it("a Check again body of {\"__proto__\":{…}} is 400 with nothing claimed and no pollution", async () => {
    const posted = await seedFailed(adaId, 2)
    const response = await raw(ada, JOB_POSTINGS_CHECK_AGAIN_PATH, "post", `{"__proto__":{"postingIds":["x"],"isAdmin":true}}`)
    // A strict empty body: __proto__ as an own JSON key is an unknown field.
    expect(response.status).toBe(400)
    expect(response.body).toEqual(BAD_REQUEST)
    for (const id of posted) expect((await statusOf(database.db, adaId, id)).status).toBe("evaluation_failed")
    expect(await queuedEvaluations(database.db)).toEqual([])
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined()
  })
})
