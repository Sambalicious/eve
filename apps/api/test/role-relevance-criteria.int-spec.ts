import { randomUUID } from "node:crypto"

import type { INestApplication } from "@nestjs/common"
import { CSRF_HEADER, DEFAULT_TARGET_ROLE_FAMILIES, JOB_CRITERIA_PATH, apiErrorResponseSchema, jobCriteriaResponseSchema } from "@eve/contracts"
import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { CandidateScope } from "../src/db/candidate-scope.js"
import { JobCriteriaService } from "../src/job-criteria/job-criteria.service.js"
import { JobCriteriaSaveLimiter } from "../src/job-criteria/job-criteria-save-limit.guard.js"
import { Browser } from "./support/browser.js"
import { insertPostingFor } from "./support/candidate-posting.js"
import { FakeAnthropic, OutboundRecorder } from "./support/fake-anthropic.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { insertSecondCandidate } from "./support/second-candidate.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0006 target-families-and-seniority-settings.feature and
 * settings-apply-to-stored-postings.feature (AC-1.5, 1.9, 2.1, 4.1, 4.2)
 * against the real api and Postgres.
 */
let database: TestDatabase
let google: FakeGoogle
let anthropic: FakeAnthropic
let outbound: OutboundRecorder
let app: INestApplication
let browser: Browser
let ada: SignedInCandidate
let kofiId: string
const clock = new TestClock("2026-10-24T08:00:00.000Z")
const valid = { minCoreMatchPercent: 70, frameworks: [], technologies: [], targetRoleFamilies: [...DEFAULT_TARGET_ROLE_FAMILIES], seniorityFloor: "hide_entry_level" }
const NOT_VALID = { code: "bad_request", message: "The request is not valid." }

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  anthropic = new FakeAnthropic(google.server)
  outbound = new OutboundRecorder(google.server)
  app = await createTestApp({ databaseUrl: database.url, clock })
  browser = new Browser(app, google)
  ada = await signInCandidate(browser)
  kofiId = await insertSecondCandidate(database.db, "kofi@example.test")
  await database.db.insertInto("job_criteria").values({ candidate_id: kofiId, min_core_match_percent: 70 }).onConflict((oc) => oc.column("candidate_id").doNothing()).execute()
})

beforeEach(async () => {
  app.get(JobCriteriaSaveLimiter).reset()
  google.server.resetHandlers()
  anthropic.install()
  anthropic.reset()
  outbound.reset()
  await database.db.deleteFrom("candidate_posting").execute()
  await database.db.deleteFrom("job_posting").execute()
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

const save = (body: unknown) => ada.put(JOB_CRITERIA_PATH).send(body as object)
const criteriaOf = (candidateId: string) => database.db.selectFrom("job_criteria").selectAll().where("candidate_id", "=", candidateId).executeTakeFirstOrThrow()

describe("GET job criteria (AC-1.5, AC-1.6, AC-2.1)", () => {
  it("a Candidate who never saved reads the nine default families and hide_entry_level", async () => {
    const response = await ada.get(JOB_CRITERIA_PATH).expect(200)
    expect(jobCriteriaResponseSchema.parse(response.body)).toEqual({ ...valid, version: 1 })
  })
})

describe("PUT job criteria targets and floor (AC-1.5, AC-1.9, AC-2.1)", () => {
  it("stores families in catalog order and returns version + 1", async () => {
    const response = await save({ ...valid, targetRoleFamilies: ["other", "data_ml", "senior_frontend"], seniorityFloor: "all_levels" }).expect(200)
    expect(jobCriteriaResponseSchema.parse(response.body)).toMatchObject({ targetRoleFamilies: ["senior_frontend", "data_ml", "other"], seniorityFloor: "all_levels", version: 2 })
    expect(await criteriaOf(database.operatorId)).toMatchObject({ target_role_families: ["senior_frontend", "data_ml", "other"], seniority_floor: "all_levels" })
  })

  it("one family and all thirteen are accepted; the same save twice adds one version each", async () => {
    await save({ ...valid, targetRoleFamilies: ["mobile"] }).expect(200)
    const all = ["senior_frontend", "technical_lead", "fullstack", "product_engineering", "software_engineering", "backend", "mobile", "platform_engineering", "devops_platform", "people_management", "data_ml", "solutions_customer", "other"]
    await save({ ...valid, targetRoleFamilies: all }).expect(200)
    const again = await save({ ...valid, targetRoleFamilies: all }).expect(200)
    expect(again.body).toMatchObject({ targetRoleFamilies: all, version: 4 })
  })

  it.each<[string, Record<string, unknown>, unknown[]]>([
    ["empty families", { targetRoleFamilies: [] }, [{ field: "targetRoleFamilies", position: null, problem: "too_few_entries" }]],
    ["missing families", { targetRoleFamilies: undefined }, [{ field: "targetRoleFamilies", position: null, problem: "invalid" }]],
    ["an unknown family", { targetRoleFamilies: ["backend", "robotics"] }, [{ field: "targetRoleFamilies", position: 2, problem: "unknown_entry" }]],
    ["a duplicate", { targetRoleFamilies: ["backend", "backend"] }, [{ field: "targetRoleFamilies", position: 2, problem: "duplicate_entry" }]],
    ["a non-string entry", { targetRoleFamilies: [1] }, [{ field: "targetRoleFamilies", position: 1, problem: "invalid" }]],
    ["a bad floor", { seniorityFloor: "senior" }, [{ field: "seniorityFloor", position: null, problem: "invalid" }]],
    ["a missing floor", { seniorityFloor: undefined }, [{ field: "seniorityFloor", position: null, problem: "invalid" }]],
  ])("refuses %s with 400 and fieldErrors; nothing changes", async (_name, patch, fieldErrors) => {
    const response = await save({ ...valid, ...patch }).expect(400)
    expect(apiErrorResponseSchema.parse(response.body).error).toEqual({ ...NOT_VALID, fieldErrors })
    expect(await criteriaOf(database.operatorId)).toMatchObject({ version: 1, target_role_families: [...DEFAULT_TARGET_ROLE_FAMILIES], seniority_floor: "hide_entry_level" })
  })

  it.each([["candidateId"], ["version"], ["baseVersion"]])("a body with %s is a plain 400 and neither Candidate changes (target-families:298)", async (key) => {
    const value = key === "candidateId" ? kofiId : 1
    const response = await save({ ...valid, targetRoleFamilies: ["data_ml"], [key]: value }).expect(400)
    expect(response.body).toEqual({ error: NOT_VALID })
    expect(await criteriaOf(database.operatorId)).toMatchObject({ version: 1, target_role_families: [...DEFAULT_TARGET_ROLE_FAMILIES] })
    expect(await criteriaOf(kofiId)).toMatchObject({ version: 1, target_role_families: [...DEFAULT_TARGET_ROLE_FAMILIES] })
  })

  it("no session is 401 and a wrong CSRF token is 403; nothing changes", async () => {
    await browser.http().put(JOB_CRITERIA_PATH).send(valid).expect(401)
    const csrf = await browser.http().put(JOB_CRITERIA_PATH).set("cookie", ada.cookie).set(CSRF_HEADER, "wrong").send(valid).expect(403)
    expect(csrf.body.error.code).toBe("csrf_invalid")
    expect((await criteriaOf(database.operatorId)).version).toBe(1)
  })
})

describe("a families- or floor-only save (AC-4.1, AC-4.2)", () => {
  async function ranked(title: string, family: string): Promise<string> {
    const id = randomUUID()
    const url = `https://boards.greenhouse.io/acme/jobs/${id}`
    await insertPostingFor(database.db, database.operatorId, {
      id, application_url: url, requisition_id: id.slice(0, 8), apply_url: url, application_system: "Greenhouse", apply_mode: "automatic", origin: "employer_board",
      employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null, title, title_folded: title.toLowerCase(), company: "Acme",
      posting_text: "Remote.", status: "ranked", role_family: family, discovered_at: clock.now(), evaluated_at: clock.now(), posted_at: new Date("2026-10-20T12:00:00Z"), posted_date_kind: "published", seniority_marker: "mid_plus",
    })
    await database.db
      .insertInto("match_evidence")
      .values({ candidate_id: database.operatorId, job_posting_id: id, career_profile_version: 1, verdict: "strong", weak_reason: null, covered_count: 7, total_count: 10, threshold: "0.700", items: "[]", evaluated_at: clock.now(), criteria_version: 1 })
      .execute()
    return id
  }

  it("makes no AI call, no fetch and no spend, changes no status or evidence, and restamps the version", async () => {
    const data = await ranked("Senior Data Engineer", "data_ml")
    const front = await ranked("Senior Frontend Engineer", "senior_frontend")
    const before = await database.db.selectFrom("candidate_posting").select(["job_posting_id", "status", "skip_reason"]).orderBy("job_posting_id").execute()
    const spendBefore = await database.db.selectFrom("spend_entry").select(sql<string>`count(*)`.as("n")).executeTakeFirstOrThrow()
    await save({ ...valid, targetRoleFamilies: [...DEFAULT_TARGET_ROLE_FAMILIES, "data_ml"], seniorityFloor: "all_levels" }).expect(200)
    expect(anthropic.requests).toHaveLength(0)
    expect(outbound.urls).toEqual([])
    expect(await database.db.selectFrom("spend_entry").select(sql<string>`count(*)`.as("n")).executeTakeFirstOrThrow()).toEqual(spendBefore)
    expect(await database.db.selectFrom("candidate_posting").select(["job_posting_id", "status", "skip_reason"]).orderBy("job_posting_id").execute()).toEqual(before)
    const evidence = await database.db.selectFrom("match_evidence").select(["job_posting_id", "verdict", "threshold", "criteria_version"]).orderBy("job_posting_id").execute()
    expect(evidence).toEqual(
      [data, front].sort().map((id) => ({ job_posting_id: id, verdict: "strong", threshold: "0.700", criteria_version: 2 }))
    )
  })

  it("Kofi's save changes only Kofi's row (per-candidate-tenancy)", async () => {
    await CandidateScope.run(kofiId, () => app.get(JobCriteriaService).save({ ...valid, targetRoleFamilies: ["data_ml"], seniorityFloor: "all_levels" } as never))
    expect(await criteriaOf(kofiId)).toMatchObject({ target_role_families: ["data_ml"], seniority_floor: "all_levels", version: 2 })
    expect(await criteriaOf(database.operatorId)).toMatchObject({ target_role_families: [...DEFAULT_TARGET_ROLE_FAMILIES], seniority_floor: "hide_entry_level", version: 1 })
  })
})
