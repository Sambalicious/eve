import { randomUUID } from "node:crypto"

import type { INestApplication } from "@nestjs/common"
import {
  APPLICATIONS_PATH,
  CSRF_HEADER,
  DEFAULT_TARGET_ROLE_FAMILIES,
  JOB_CRITERIA_PATH,
  JOB_POSTINGS_CHECK_AGAIN_PATH,
  checkAgainResponseSchema,
  jobPostingDetailSchema,
  jobPostingsResponseSchema,
} from "@eve/contracts"
import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { CandidateScope } from "../src/db/candidate-scope.js"
import { DiscoveryRepository } from "../src/discovery/discovery.repository.js"
import { DiscoveryService } from "../src/discovery/discovery.service.js"
import { PostingEvaluator } from "../src/discovery/posting-evaluator.js"
import { EMPTY_STRUCTURED } from "../src/discovery/sources/discovered-posting.js"
import { JobCriteriaSaveLimiter } from "../src/job-criteria/job-criteria-save-limit.guard.js"
import { Browser } from "./support/browser.js"
import { insertCandidatePosting } from "./support/candidate-posting.js"
import { FakeAnthropic } from "./support/fake-anthropic.js"
import { FakeGoogle } from "./support/fake-google.js"
import { ROLE_RELEVANCE_DEFAULTS } from "./support/job-criteria-body.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { insertSecondCandidate } from "./support/second-candidate.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0006 against the real api and Postgres: hidden-postings-board,
 * posting-age, posted-date backfill, applications-and-links, check-again and
 * evaluation-of-hidden (backend rows of the responsibility map). No model call
 * is made: the evaluator's gate runs before any reservation, and the FakeAnthropic
 * records any request so tests can assert there was none.
 */
let database: TestDatabase
let google: FakeGoogle
let anthropic: FakeAnthropic
let app: INestApplication
let browser: Browser
let ada: SignedInCandidate
let kofiId: string
const NOW = "2026-10-24T08:00:00.000Z" // 09:00 WAT
const clock = new TestClock(NOW)

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  anthropic = new FakeAnthropic(google.server)
  app = await createTestApp({ databaseUrl: database.url, clock })
  browser = new Browser(app, google)
  ada = await signInCandidate(browser)
  kofiId = await insertSecondCandidate(database.db, "kofi.board@example.test")
  await database.db.insertInto("job_criteria").values({ candidate_id: kofiId, min_core_match_percent: 70 }).onConflict((oc) => oc.column("candidate_id").doNothing()).execute()
})

beforeEach(async () => {
  clock.set(NOW)
  app.get(JobCriteriaSaveLimiter).reset()
  google.server.resetHandlers()
  anthropic.install()
  anthropic.reset()
  for (const table of ["application", "match_evidence", "candidate_posting", "job_posting"] as const) await database.db.deleteFrom(table).execute()
  await sql`delete from pgboss.job where name = 'evaluate.posting'`.execute(database.db)
  await database.db
    .updateTable("job_criteria")
    .set({ min_core_match_percent: 70, frameworks: [], technologies: [], target_role_families: [...DEFAULT_TARGET_ROLE_FAMILIES], seniority_floor: "hide_entry_level", version: 1 })
    .execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

type Facts = Readonly<{ title?: string | null; family?: string | null; marker?: "entry" | "mid_plus" | "none" | null; postedAt?: Date | null; prefilter?: "not_software_role" | null }>

/** A shared posting with the given facts (a stored row as 0020 and storeOnce leave it). */
async function posting(facts: Facts = {}): Promise<string> {
  const id = randomUUID()
  const url = `https://boards.greenhouse.io/board/jobs/${id}`
  const title = facts.title === undefined ? "Senior Frontend Engineer" : facts.title
  const postedAt = facts.postedAt === undefined ? new Date("2026-10-20T12:00:00Z") : facts.postedAt
  await database.db
    .insertInto("job_posting")
    .values({
      id, application_url: url, requisition_id: id.slice(0, 8), apply_url: url, application_system: "Greenhouse", apply_mode: "automatic", origin: "employer_board",
      employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null, title, title_folded: title === null ? null : title.toLowerCase(),
      company: "Acme", posting_text: "Remote.", role_family: facts.family === undefined ? "senior_frontend" : facts.family, discovered_at: new Date("2026-10-20T12:00:00Z"),
      prefilter_skip: facts.prefilter ?? null, seniority_marker: facts.marker === undefined ? (title === null ? null : "none") : facts.marker,
      posted_at: postedAt, posted_date_kind: postedAt === null ? null : "published",
    })
    .execute()
  return id
}

async function hold(candidateId: string, id: string, status: Parameters<typeof insertCandidatePosting>[3]["status"], extra: Partial<Parameters<typeof insertCandidatePosting>[3]> = {}) {
  await insertCandidatePosting(database.db, candidateId, id, { status, ...extra })
}

async function evidence(id: string, covered = 8) {
  await database.db
    .insertInto("match_evidence")
    .values({ candidate_id: database.operatorId, job_posting_id: id, career_profile_version: 1, verdict: "strong", weak_reason: null, covered_count: covered, total_count: 10, threshold: "0.700", items: "[]", evaluated_at: new Date(NOW), criteria_version: 1 })
    .execute()
}

const list = async (query = "tab=all") => jobPostingsResponseSchema.parse((await ada.get(`/v1/job-postings?${query}`).expect(200)).body)
const statusOf = async (candidateId: string, id: string) =>
  (await database.db.selectFrom("candidate_posting").select(["status", "evaluation_failure"]).where("candidate_id", "=", candidateId).where("job_posting_id", "=", id).executeTakeFirstOrThrow())
const jobs = async () => (await sql<{ data: { postingId: string; candidateId: string } }>`select data from pgboss.job where name = 'evaluate.posting' order by created_on`.execute(database.db)).rows.map((row) => row.data)

describe("hidden postings on the board (AC-1.7, 2.2, 3.1 to 3.8, 5.5, 6.2)", () => {
  it("lists only visible postings, counts each hidden one once by its first reason, and ranks visible ones only", async () => {
    const visible = await posting({ title: "Senior Frontend Engineer" })
    const offTarget = await posting({ title: "Senior Data Engineer", family: "data_ml" })
    const prefiltered = await posting({ title: "Sales Engineer", family: null, prefilter: "not_software_role" })
    const junior = await posting({ title: "Junior Frontend Developer", marker: "entry" })
    const undated = await posting({ title: "Staff Engineer", family: "software_engineering", postedAt: null })
    const old = await posting({ title: "Lead Engineer", family: "technical_lead", postedAt: new Date("2026-08-24T22:59:59Z") })
    const all = await posting({ title: "Junior Data Analyst", family: "data_ml", marker: "entry", postedAt: null })
    for (const id of [visible, offTarget, junior, undated, old, all]) {
      await hold(database.operatorId, id, "ranked")
      await evidence(id)
    }
    await hold(database.operatorId, prefiltered, "skipped", { skipReason: "not_software_role" })
    const page = await list()
    expect(page.postings.map((row) => row.id)).toEqual([visible])
    expect(page.postings[0]).toMatchObject({ rank: 1, hiddenReason: null, postedOn: "2026-10-20", postedDateKind: "published", ageDays: 4, postedAt: "2026-10-20T12:00:00.000Z" })
    expect(page.totalCount).toBe(1)
    expect(page.hiddenCounts).toEqual({ offTarget: 3, belowSeniorityFloor: 1, undated: 1, olderThan60Days: 1, total: 6 })
    expect(page.targetRoleFamilies).toEqual([...DEFAULT_TARGET_ROLE_FAMILIES])
    expect((await list("tab=ranked")).postings.map((row) => row.id)).toEqual([visible])
    expect((await list("tab=skipped")).postings).toEqual([])
  })

  it("a hidden posting still opens with its hiddenReason and a null rank (AC-3.8)", async () => {
    const id = await posting({ title: "Senior Data Engineer", family: "data_ml" })
    await hold(database.operatorId, id, "ranked")
    await evidence(id)
    const detail = jobPostingDetailSchema.parse((await ada.get(`/v1/job-postings/${id}`).expect(200)).body)
    expect(detail).toMatchObject({ status: "ranked", rank: null, hiddenReason: "off_target" })
  })

  it("posted 60 days ago at 00:00 WAT is visible; 23:59 WAT the day before is hidden (AC-6.6)", async () => {
    const sixty = await posting({ postedAt: new Date("2026-08-24T23:00:00Z") })
    const sixtyOne = await posting({ postedAt: new Date("2026-08-24T22:59:00Z") })
    for (const id of [sixty, sixtyOne]) await hold(database.operatorId, id, "evaluation_failed", { evaluationFailure: "not_configured" })
    const page = await list()
    expect(page.postings.map((row) => [row.id, row.ageDays])).toEqual([[sixty, 60]])
    expect(page.hiddenCounts.olderThan60Days).toBe(1)
    expect(page.recheckableCount).toBe(1)
  })

  it("saving targets and floor changes what shows, with no status change (AC-4.1, 4.2)", async () => {
    const data = await posting({ title: "Senior Data Engineer", family: "data_ml" })
    const junior = await posting({ title: "Junior Frontend Developer", marker: "entry" })
    for (const id of [data, junior]) await hold(database.operatorId, id, "evaluation_failed", { evaluationFailure: "not_configured" })
    expect((await list()).postings).toEqual([])
    await ada.put(JOB_CRITERIA_PATH).send({ ...ROLE_RELEVANCE_DEFAULTS, minCoreMatchPercent: 70, frameworks: [], technologies: [], targetRoleFamilies: [...DEFAULT_TARGET_ROLE_FAMILIES, "data_ml"], seniorityFloor: "all_levels" }).expect(200)
    const page = await list()
    expect(page.postings.map((row) => row.id).sort()).toEqual([data, junior].sort())
    expect(page.postings.every((row) => row.status === "evaluation_failed")).toBe(true)
  })

  it("waitingReason is cost_pause for the Operator and null with nothing waiting (r1)", async () => {
    expect((await list()).waitingReason).toBeNull()
    const id = await posting()
    await hold(database.operatorId, id, "waiting_to_be_checked")
    expect(await list()).toMatchObject({ waitingToBeCheckedCount: 1, waitingReason: "cost_pause" })
  })

  it("a non-Operator's visible waiting rows wait for checks_not_enabled", async () => {
    const id = await posting()
    await hold(kofiId, id, "waiting_to_be_checked")
    const theirs = await CandidateScope.run(kofiId, () => app.get(DiscoveryService).listPostings({ tab: "all", limit: 25, families: [], keyword: null, cursor: null }))
    expect(theirs).toMatchObject({ waitingToBeCheckedCount: 1, waitingReason: "checks_not_enabled" })
  })
})

describe("POST /v1/job-postings/check-again (AC-7.3 to 7.5)", () => {
  it("claims the Operator's visible failed and not-checked rows, queues one job each with candidateId, and keeps the stored kind", async () => {
    const failed = await posting()
    const notChecked = await posting({ title: "Senior Backend Engineer", family: "backend" })
    const hidden = await posting({ title: "Senior Data Engineer", family: "data_ml" })
    const ranked = await posting()
    await hold(database.operatorId, failed, "evaluation_failed", { evaluationFailure: "not_configured" })
    await hold(database.operatorId, notChecked, "not_checked")
    await hold(database.operatorId, hidden, "evaluation_failed", { evaluationFailure: "provider_error" })
    await hold(database.operatorId, ranked, "ranked")
    expect((await list()).recheckableCount).toBe(2)
    const response = await ada.post(JOB_POSTINGS_CHECK_AGAIN_PATH).send({}).expect(200)
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(checkAgainResponseSchema.parse(response.body)).toEqual({ queued: 2, movedTo: "checking" })
    expect(await statusOf(database.operatorId, failed)).toEqual({ status: "checking", evaluation_failure: "not_configured" })
    expect(await statusOf(database.operatorId, notChecked)).toEqual({ status: "checking", evaluation_failure: null })
    expect(await statusOf(database.operatorId, hidden)).toEqual({ status: "evaluation_failed", evaluation_failure: "provider_error" })
    expect((await jobs()).map((job) => job.postingId).sort()).toEqual([failed, notChecked].sort())
    expect((await jobs()).every((job) => job.candidateId === database.operatorId)).toBe(true)
    // A queued (checking) row sends evaluationFailure null (v1.18.0).
    const detail = jobPostingDetailSchema.parse((await ada.get(`/v1/job-postings/${failed}`).expect(200)).body)
    expect(detail).toMatchObject({ status: "checking", evaluationFailure: null })
    expect(anthropic.requests).toHaveLength(0)
  })

  it("an absent body works; a second press finds nothing new", async () => {
    const failed = await posting()
    await hold(database.operatorId, failed, "evaluation_failed", { evaluationFailure: "provider_error" })
    expect((await ada.post(JOB_POSTINGS_CHECK_AGAIN_PATH).expect(200)).body).toEqual({ queued: 1, movedTo: "checking" })
    expect((await ada.post(JOB_POSTINGS_CHECK_AGAIN_PATH).expect(200)).body).toEqual({ queued: 0, movedTo: "checking" })
    expect(await jobs()).toHaveLength(1)
  })

  it("two concurrent presses claim disjoint rows: each row is queued once", async () => {
    const ids: string[] = []
    for (let index = 0; index < 12; index++) {
      const id = await posting()
      ids.push(id)
      await hold(database.operatorId, id, "evaluation_failed", { evaluationFailure: "provider_error" })
    }
    const [first, second] = await Promise.all([ada.post(JOB_POSTINGS_CHECK_AGAIN_PATH).send({}), ada.post(JOB_POSTINGS_CHECK_AGAIN_PATH).send({})])
    expect(first.body.queued + second.body.queued).toBe(12)
    expect((await jobs()).map((job) => job.postingId).sort()).toEqual([...ids].sort())
  })

  it.each([[{ postingIds: [] }], [{ candidateId: "x" }], [[]], [null], ["x"], [{ "": 1 }]])("body %j is a plain 400 and claims nothing", async (body) => {
    const failed = await posting()
    await hold(database.operatorId, failed, "evaluation_failed", { evaluationFailure: "provider_error" })
    const response = await ada.post(JOB_POSTINGS_CHECK_AGAIN_PATH).set("content-type", "application/json").send(JSON.stringify(body)).expect(400)
    expect(response.body).toEqual({ error: { code: "bad_request", message: "The request is not valid." } })
    expect((await statusOf(database.operatorId, failed)).status).toBe("evaluation_failed")
    expect(await jobs()).toEqual([])
  })

  it("no session is 401 and a wrong CSRF token is 403; nothing is claimed", async () => {
    const failed = await posting()
    await hold(database.operatorId, failed, "evaluation_failed", { evaluationFailure: "provider_error" })
    await browser.http().post(JOB_POSTINGS_CHECK_AGAIN_PATH).send({}).expect(401)
    await browser.http().post(JOB_POSTINGS_CHECK_AGAIN_PATH).set("cookie", ada.cookie).set(CSRF_HEADER, "wrong").send({}).expect(403)
    expect((await statusOf(database.operatorId, failed)).status).toBe("evaluation_failed")
    expect(await jobs()).toEqual([])
  })

  it("a non-Operator's rows move to waiting with no job and no model call", async () => {
    const failed = await posting()
    await hold(kofiId, failed, "evaluation_failed", { evaluationFailure: "provider_error" })
    const result = await CandidateScope.run(kofiId, () => app.get(DiscoveryService).checkAgain())
    expect(result).toEqual({ queued: 1, movedTo: "waiting_to_be_checked" })
    expect(await statusOf(kofiId, failed)).toEqual({ status: "waiting_to_be_checked", evaluation_failure: "provider_error" })
    expect(await jobs()).toEqual([])
  })
})

describe("evaluator gate (AC-7.1)", () => {
  const evaluateAsOperator = (id: string) => CandidateScope.run(database.operatorId, () => app.get(PostingEvaluator).evaluate(id))

  it.each<[string, Parameters<typeof insertCandidatePosting>[3], string, string | null]>([
    ["checking with no stored kind", { status: "checking" }, "not_checked", null],
    ["checking with a stored kind", { status: "checking", evaluationFailure: "not_configured" }, "evaluation_failed", "not_configured"],
    ["waiting", { status: "waiting_to_be_checked" }, "waiting_to_be_checked", null],
    ["evaluation_failed", { status: "evaluation_failed", evaluationFailure: "provider_error" }, "evaluation_failed", "provider_error"],
  ])("a hidden posting found %s returns hidden, reserves nothing and goes back", async (_name, state, status, kind) => {
    const id = await posting({ title: "Senior Data Engineer", family: "data_ml" })
    await hold(database.operatorId, id, state.status, state)
    const spend = await sql<{ n: number }>`select count(*)::int as n from spend_entry`.execute(database.db)
    expect(await evaluateAsOperator(id)).toBe("hidden")
    expect(await statusOf(database.operatorId, id)).toEqual({ status, evaluation_failure: kind })
    expect((await sql<{ n: number }>`select count(*)::int as n from spend_entry`.execute(database.db)).rows).toEqual(spend.rows)
    expect(anthropic.requests).toHaveLength(0)
  })

  it("a non-Operator's paste evaluation is deferred to waiting with no model call (TM-05, CHK-38)", async () => {
    const id = await posting()
    await hold(kofiId, id, "checking")
    expect(await CandidateScope.run(kofiId, () => app.get(PostingEvaluator).evaluate(id))).toBe("waiting")
    expect((await statusOf(kofiId, id)).status).toBe("waiting_to_be_checked")
    expect(anthropic.requests).toHaveLength(0)
  })
})

describe("store-time facts and the posted-date backfill (AC-1.8, 2.2, 4.3, 5.6, 5.8)", () => {
  const store = (candidateId: string, postedAt: Date | null, title = "Senior Frontend Engineer") =>
    CandidateScope.run(candidateId, () =>
      app.get(DiscoveryRepository).storeOnce(
        {
          applicationUrl: "https://boards.greenhouse.io/acme/jobs/777",
          requisitionId: "777",
          applyUrl: "https://boards.greenhouse.io/acme/jobs/777",
          applicationSystem: "Greenhouse",
          applyMode: "automatic",
          origin: "employer_board",
          employerBoardId: null,
          remoteBoardKey: null,
          attribution: null,
          title,
          company: "Acme",
          postingText: "Remote.",
          structured: EMPTY_STRUCTURED,
          discoveredAt: new Date(NOW),
          postedAt,
          postedDateKind: postedAt === null ? null : "published",
        },
        () => ({ pass: true })
      )
    )

  it("a new titled posting stores its family, marker and date; undated it starts not_checked and is not evaluated", async () => {
    const stored = await store(database.operatorId, null, "Junior Frontend Developer")
    expect(stored).toMatchObject({ created: true, evaluate: false, state: { status: "not_checked" } })
    const row = await database.db.selectFrom("job_posting").select(["role_family", "seniority_marker", "posted_at"]).where("id", "=", stored.id).executeTakeFirstOrThrow()
    expect(row).toEqual({ role_family: "senior_frontend", seniority_marker: "entry", posted_at: null })
  })

  it("a later read with a date backfills it once, never overwrites, and claims only that Candidate's not_checked row", async () => {
    // Ada and Kofi both hold the undated posting; Ada's rediscovery dates it.
    const first = await store(database.operatorId, null)
    await hold(kofiId, first.id, "not_checked")
    const again = await store(database.operatorId, new Date("2026-10-20T12:00:00Z"))
    expect(again).toMatchObject({ id: first.id, created: false, evaluate: true })
    expect((await statusOf(database.operatorId, first.id)).status).toBe("checking")
    expect((await statusOf(kofiId, first.id)).status).toBe("not_checked")
    // A different date later never overwrites the stored one.
    await store(database.operatorId, new Date("2026-10-23T12:00:00Z"))
    const row = await database.db.selectFrom("job_posting").select(["posted_at", "posted_date_kind"]).where("id", "=", first.id).executeTakeFirstOrThrow()
    expect(row).toEqual({ posted_at: new Date("2026-10-20T12:00:00Z"), posted_date_kind: "published" })
  })
})

describe("409 posting_hidden (AC-3.9)", () => {
  const MESSAGE = "This Job Posting is hidden from your board. Eve won't start a new Application or sample from it. Reload the page to see why."

  it("POST /v1/applications refuses a hidden ranked posting with 409 and creates nothing", async () => {
    const id = await posting({ title: "Senior Data Engineer", family: "data_ml" })
    await hold(database.operatorId, id, "ranked")
    const response = await ada.post(APPLICATIONS_PATH).send({ jobPostingId: id }).expect(409)
    expect(response.body).toEqual({ error: { code: "posting_hidden", message: MESSAGE } })
    expect(await database.db.selectFrom("application").select("id").execute()).toEqual([])
  })

  it("a posting the Candidate does not hold is 404 before any hidden check", async () => {
    const id = await posting({ title: "Senior Data Engineer", family: "data_ml" })
    await hold(kofiId, id, "ranked")
    await ada.post(APPLICATIONS_PATH).send({ jobPostingId: id }).expect(404)
  })

  it("an existing Application on a now-hidden posting gets 409, not 200 created:false", async () => {
    const id = await posting()
    await hold(database.operatorId, id, "ranked")
    await evidence(id)
    const created = await ada.post(APPLICATIONS_PATH).send({ jobPostingId: id }).expect(201)
    await database.db.updateTable("job_posting").set({ posted_at: null, posted_date_kind: null }).where("id", "=", id).execute()
    expect((await ada.post(APPLICATIONS_PATH).send({ jobPostingId: id }).expect(409)).body.error.code).toBe("posting_hidden")
    await ada.post(`/v1/applications/${created.body.application.id}/sample`).expect(409)
    await ada.post(`/v1/applications/${randomUUID()}/sample`).expect(404)
  })
})
