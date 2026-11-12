import { randomUUID } from "node:crypto"

import type { INestApplication } from "@nestjs/common"
import { CSRF_HEADER, JOB_CRITERIA_PATH, apiErrorResponseSchema } from "@eve/contracts"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { JobCriteriaSaveLimiter } from "../src/job-criteria/job-criteria-save-limit.guard.js"
import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"
import { insertPostingFor, postingsOf } from "./support/candidate-posting.js"
import { ROLE_RELEVANCE_DEFAULTS } from "./support/job-criteria-body.js"

/**
 * SEC-006 (EPIC-0004 security review): `PUT /v1/candidate-settings/job-criteria`
 * re-decides every ranked or skipped posting in one transaction, so it is
 * limited to 10 saves per minute per session. Real api, real Postgres, real
 * sessions; only the clock is moved by hand.
 */
const T0 = "2026-10-22T09:00:00.000Z"
const LIMIT = 10
const TOO_MANY = {
  error: { code: "too_many_requests", message: "Too many requests. Wait a minute, then try again." },
}

let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let browser: Browser
let candidate: SignedInCandidate
const clock = new TestClock(T0)

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  browser = new Browser(app, google)
  candidate = await signInCandidate(browser)
})

beforeEach(async () => {
  clock.set(T0)
  app.get(JobCriteriaSaveLimiter).reset()
  for (const table of ["match_evidence", "eligibility_result", "candidate_posting", "job_posting"] as const) await database.db.deleteFrom(table).execute()
  await database.db.updateTable("job_criteria").set({ min_core_match_percent: 70, frameworks: [], technologies: [], target_role_families: [...ROLE_RELEVANCE_DEFAULTS.targetRoleFamilies], seniority_floor: ROLE_RELEVANCE_DEFAULTS.seniorityFloor, version: 1 }).execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

function saveAs(who: SignedInCandidate, minCoreMatchPercent = 75) {
  return who.put(JOB_CRITERIA_PATH).send({ ...ROLE_RELEVANCE_DEFAULTS, minCoreMatchPercent, frameworks: [], technologies: [] })
}

async function saveTimes(who: SignedInCandidate, times: number) {
  for (let index = 0; index < times; index += 1) await saveAs(who).expect(200)
}

async function storedCriteria() {
  return database.db.selectFrom("job_criteria").select(["min_core_match_percent", "version"]).executeTakeFirstOrThrow()
}

/** A ranked 8 of 10 posting with Match evidence: ranked at 75, skipped by a save at 81. */
async function rankedPosting(): Promise<string> {
  const id = randomUUID()
  const url = `https://boards.greenhouse.io/globex/jobs/${id}`
  await insertPostingFor(database.db, database.operatorId, {
      id,
      application_url: url,
      requisition_id: id.slice(0, 8),
      apply_url: url,
      application_system: "Greenhouse",
      apply_mode: "automatic",
      origin: "employer_board",
      employer_board_id: null,
      remote_board_key: null,
      attribution_name: null,
      attribution_url: null,
      title: "Senior Frontend Engineer",
      company: "Globex",
      posting_text: "Posting",
      status: "ranked",
      skip_reason: null,
      skip_detail: null,
      evaluation_failure: null,
      role_family: "senior_frontend",
      discovered_at: clock.now(),
      evaluated_at: clock.now(),
      technologies: null,
    })
  await database.db
    .insertInto("match_evidence")
    .values({
      candidate_id: database.operatorId,
      job_posting_id: id,
      career_profile_version: 1,
      verdict: "strong",
      weak_reason: null,
      covered_count: 8,
      total_count: 10,
      threshold: "0.700",
      items: "[]",
      evaluated_at: clock.now(),
      criteria_version: 1,
    })
    .execute()
  return id
}

describe("PUT /v1/candidate-settings/job-criteria rate limit (SEC-006)", () => {
  it("allows 10 saves in a minute; the 11th is 429 too_many_requests with Retry-After and changes nothing", async () => {
    const posting = await rankedPosting()
    await saveTimes(candidate, LIMIT)
    expect(await storedCriteria()).toEqual({ min_core_match_percent: 75, version: 1 + LIMIT })

    clock.set("2026-10-22T09:00:20.000Z")
    const refused = await saveAs(candidate, 81).expect(429)
    expect(refused.body).toEqual(TOO_MANY)
    expect(apiErrorResponseSchema.parse(refused.body)).toEqual(TOO_MANY)
    expect(refused.headers["retry-after"]).toBe("40")
    expect(refused.headers["content-type"]).toMatch(/^application\/json/)

    expect(await storedCriteria()).toEqual({ min_core_match_percent: 75, version: 1 + LIMIT })
    const after = await postingsOf(database.db, database.operatorId).select("status").where("id", "=", posting).executeTakeFirstOrThrow()
    expect(after.status).toBe("ranked")
  })

  it("resets once the minute has passed since the first counted save", async () => {
    await saveTimes(candidate, LIMIT)
    clock.set("2026-10-22T09:00:59.999Z")
    const stillRefused = await saveAs(candidate).expect(429)
    expect(stillRefused.headers["retry-after"]).toBe("1")

    clock.set("2026-10-22T09:01:00.000Z")
    const response = await saveAs(candidate, 80).expect(200)
    expect(response.body).toMatchObject({ minCoreMatchPercent: 80, version: 2 + LIMIT })
  })

  // G5 CR-01 (.runs/g5/reports/review.md): the refusals sit at T0+59 s, inside the next window. If they were
  // counted, the window opening at T0+60 s would hold them, fewer than 10 saves would fit, and Retry-After would
  // run from 59 s. Only counted saves at T0+60 s may fill it.
  it("a refused save does not count: retrying while refused does not extend the wait", async () => {
    await saveTimes(candidate, LIMIT)
    clock.set("2026-10-22T09:00:59.000Z")
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const refused = await saveAs(candidate).expect(429)
      expect(refused.headers["retry-after"]).toBe("1")
    }

    clock.set("2026-10-22T09:01:00.000Z")
    await saveTimes(candidate, LIMIT)
    expect(await storedCriteria()).toEqual({ min_core_match_percent: 75, version: 1 + 2 * LIMIT })
    const refused = await saveAs(candidate).expect(429)
    expect(refused.headers["retry-after"]).toBe("60")
  })

  it("is per session: a second session saves while the first is limited, and has its own 10", async () => {
    const other = await signInCandidate(browser)
    await saveTimes(candidate, LIMIT)
    await saveAs(candidate).expect(429)

    await saveTimes(other, LIMIT)
    const refused = await saveAs(other).expect(429)
    expect(refused.body).toEqual(TOO_MANY)
    expect(await storedCriteria()).toMatchObject({ version: 1 + 2 * LIMIT })
  })

  it("refusals for a missing session or CSRF token come first and do not use up the session's saves", async () => {
    for (let index = 0; index < LIMIT + 2; index += 1) {
      await browser.http().put(JOB_CRITERIA_PATH).send({ ...ROLE_RELEVANCE_DEFAULTS, minCoreMatchPercent: 60, frameworks: [], technologies: [] }).expect(401)
      await browser.http().put(JOB_CRITERIA_PATH).set("cookie", candidate.cookie).send({ ...ROLE_RELEVANCE_DEFAULTS, minCoreMatchPercent: 60, frameworks: [], technologies: [] }).expect(403)
      await browser.http().put(JOB_CRITERIA_PATH).set("cookie", candidate.cookie).set(CSRF_HEADER, "wrong").send({ ...ROLE_RELEVANCE_DEFAULTS, minCoreMatchPercent: 60, frameworks: [], technologies: [] }).expect(403)
    }
    await saveTimes(candidate, LIMIT)
  })

  it("an invalid save counts toward the limit (it is refused before the transaction, but the limit sees every attempt)", async () => {
    for (let index = 0; index < LIMIT; index += 1) await saveAs(candidate, 101).expect(400)
    await saveAs(candidate).expect(429)
    expect(await storedCriteria()).toEqual({ min_core_match_percent: 70, version: 1 })
  })

  it("reading the criteria is not limited and does not use up saves", async () => {
    for (let index = 0; index < LIMIT * 2; index += 1) await candidate.get(JOB_CRITERIA_PATH).expect(200)
    await saveTimes(candidate, LIMIT)
    await candidate.get(JOB_CRITERIA_PATH).expect(200)
  })

  it("another state-changing route is not limited by the Job criteria limit", async () => {
    await saveTimes(candidate, LIMIT)
    await saveAs(candidate).expect(429)
    await candidate.put("/v1/candidate-settings/work-authorization").send({ workAuthorization: "Nigeria" }).expect(200)
  })
})
