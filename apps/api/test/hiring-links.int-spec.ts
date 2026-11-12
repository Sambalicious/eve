import { randomUUID } from "node:crypto"

import { type INestApplication, Logger, type LoggerService } from "@nestjs/common"
import { HIRING_SEARCH_INPUTS_PATH, apiErrorResponseSchema, buildHiringSearchGroups, hiringSearchInputsResponseSchema } from "@eve/contracts"
import { type Kysely, sql } from "kysely"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { CandidateScope } from "../src/db/candidate-scope.js"
import { createDatabase } from "../src/db/create-database.js"
import { ownerValues } from "../src/db/migrations/0018-owner-preferences.js"
import type { Database } from "../src/db/schema.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { renderDailySummary } from "../src/notification/email-content.js"
import { StackPostsSummaryReader } from "../src/stack-posts/stack-posts-summary.js"
import { StackPostsService } from "../src/stack-posts/stack-posts.service.js"
import { Browser } from "./support/browser.js"
import { OutboundRecorder } from "./support/fake-anthropic.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { insertSecondCandidate } from "./support/second-candidate.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0007 Phase 1 (contract v1.19.0) against the real api and Postgres
 * (runtime role, forced RLS): `GET /v1/stack-posts/hiring-search-inputs` and the
 * daily summary's hiring links part. Two Candidates: the signed-in Operator (A,
 * with the 0018 Job Preferences) and a synthetic invitee (B). Nothing leaves
 * 127.0.0.1 (OutboundRecorder), no AI call, no spend, no row written.
 */
const HIRING = '("we\'re hiring" OR "we are hiring" OR "now hiring" OR "join our team")'
const FRONTEND = '("frontend engineer" OR "frontend developer" OR "front-end engineer")'
const BACKEND = '("backend engineer" OR "backend developer" OR "back-end engineer")'
const BASE = "https://dashboard.test"
const OWNER_VALUES = ownerValues("Africa/Lagos", "23:00", { amount: "5000.00", currency: "USD" })

let database: TestDatabase
let runtime: Kysely<Database>
let google: FakeGoogle
let outbound: OutboundRecorder
let app: INestApplication
let browser: Browser
let owner: SignedInCandidate
let otherId: string
let summaries: StackPostsSummaryReader
const clock = new TestClock("2026-10-21T09:00:00.000Z")
const logs: string[] = []
const line = (message: unknown, ...rest: unknown[]) => void logs.push([message, ...rest].map(String).join(" "))
const capture: LoggerService = { log: line, warn: line, error: line, debug: line, verbose: line }
const asOther = <T>(work: () => Promise<T>) => CandidateScope.run(otherId, work)
const asOwner = <T>(work: () => Promise<T>) => CandidateScope.run(database.operatorId, work)

/** Every row of the tables a hiring read could touch, to prove it writes nothing. */
async function snapshot(): Promise<string> {
  const tables = ["job_preferences", "job_preferences_version", "job_criteria", "notification_outbox", "ai_call", "spend_entry", "stack_post", "alert_feed"] as const
  const rows = await Promise.all(tables.map((table) => database.db.selectFrom(table).selectAll().execute()))
  return JSON.stringify(rows)
}

async function setPreferences(candidateId: string, values: unknown): Promise<void> {
  await database.db.deleteFrom("job_preferences").where("candidate_id", "=", candidateId).execute()
  await database.db.insertInto("job_preferences").values({ candidate_id: candidateId, version: 1, values: JSON.stringify(values) }).execute()
}

async function setCriteria(candidateId: string, values: { targets?: string[]; frameworks?: string[]; technologies?: string[] }): Promise<void> {
  await database.db
    .insertInto("job_criteria")
    .values({ candidate_id: candidateId, min_core_match_percent: 70 })
    .onConflict((oc) => oc.column("candidate_id").doNothing())
    .execute()
  await database.db
    .updateTable("job_criteria")
    .set({ target_role_families: values.targets ?? ["senior_frontend"], frameworks: values.frameworks ?? [], technologies: values.technologies ?? [] })
    .where("candidate_id", "=", candidateId)
    .execute()
}

const summaryFor = (candidateId: string) => CandidateScope.run(candidateId, () => summaries.summary(randomUUID(), clock.now()))

beforeAll(async () => {
  Logger.overrideLogger(capture)
  database = await startMigratedDatabase()
  runtime = createDatabase(database.url)
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  outbound = new OutboundRecorder(google.server)
  app = await createTestApp({ databaseUrl: database.url, clock })
  Logger.overrideLogger(capture)
  browser = new Browser(app, google)
  owner = await signInCandidate(browser)
  otherId = await insertSecondCandidate(database.db)
  summaries = new StackPostsSummaryReader(new TenantDatabase(runtime))
})

beforeEach(async () => {
  outbound.reset()
  logs.length = 0
  Logger.overrideLogger(capture)
  for (const table of ["alert_feed_candidate_verification", "notification_outbox", "ai_call", "spend_entry"] as const) await database.db.deleteFrom(table).execute()
  await database.db.updateTable("control_state").set({ global_paused: false, cost_paused: false }).execute()
  await setPreferences(database.operatorId, OWNER_VALUES)
  await database.db.deleteFrom("job_preferences").where("candidate_id", "=", otherId).execute()
  await setCriteria(database.operatorId, { targets: ["senior_frontend"], frameworks: ["React"], technologies: ["TypeScript"] })
  await setCriteria(otherId, { targets: ["backend"], frameworks: ["Django"], technologies: [] })
})

afterEach(() => {
  // AC 10.3: no request to LinkedIn, Google or anywhere else.
  expect(outbound.urls).toEqual([])
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await runtime?.destroy()
  await database?.stop()
  Logger.overrideLogger(false)
})

describe("GET /v1/stack-posts/hiring-search-inputs (HSL @ac-2.5, HV @ac-1.3)", () => {
  it("the Operator's current Job Preferences give all three hint terms, no-store", async () => {
    const response = await owner.get(HIRING_SEARCH_INPUTS_PATH).expect(200)
    expect(hiringSearchInputsResponseSchema.parse(response.body)).toEqual({ hintTerms: ["remote", "relocation", "visa sponsorship"] })
    expect(response.headers["cache-control"]).toBe("no-store")
  })

  it.each([
    [{ remoteAccepted: true, relocationAccepted: false, sponsorshipNeededForRelocation: false }, ["remote"]],
    [{ remoteAccepted: false, relocationAccepted: true, sponsorshipNeededForRelocation: false }, ["relocation"]],
    [{ remoteAccepted: false, relocationAccepted: true, sponsorshipNeededForRelocation: true }, ["relocation", "visa sponsorship"]],
    [{ remoteAccepted: false, relocationAccepted: false, sponsorshipNeededForRelocation: true }, []],
  ])("hint terms follow the Job Preferences %j -> %j", async (flags, expected) => {
    await setPreferences(database.operatorId, { ...OWNER_VALUES, ...flags })
    expect((await owner.get(HIRING_SEARCH_INPUTS_PATH).expect(200)).body).toEqual({ hintTerms: expected })
  })

  it("pay floor, hours, countries, industries, employment types and seniority add no terms (AC 2.6)", async () => {
    await setPreferences(database.operatorId, { ...OWNER_VALUES, remoteAccepted: false, relocationAccepted: false, payFloor: { amount: "9000.00", currency: "USD", period: "month", basis: "gross" }, latestWorkHour: "18:00", excludedRelocationCountries: [], employmentTypes: ["contract"], seniorityLevels: "senior" })
    expect((await owner.get(HIRING_SEARCH_INPUTS_PATH).expect(200)).body).toEqual({ hintTerms: [] })
  })

  it("no Job Preferences row gives [] with 200 and no parse-failure log", async () => {
    await database.db.deleteFrom("job_preferences").where("candidate_id", "=", database.operatorId).execute()
    expect((await owner.get(HIRING_SEARCH_INPUTS_PATH).expect(200)).body).toEqual({ hintTerms: [] })
    expect(logs.join("\n")).not.toContain("hiring.preferences_parse_failed")
  })

  it("a malformed row gives [] with 200 and logs hiring.preferences_parse_failed with no values (P1-7)", async () => {
    await setPreferences(database.operatorId, { remoteAccepted: "VALUE-SENTINEL", relocationAccepted: true, payFloor: { amount: "7777.00" } })
    expect((await owner.get(HIRING_SEARCH_INPUTS_PATH).expect(200)).body).toEqual({ hintTerms: [] })
    const logged = logs.join("\n")
    expect(logged).toContain("hiring.preferences_parse_failed")
    expect(logged).not.toContain("VALUE-SENTINEL")
    expect(logged).not.toContain("7777")
  })

  it("ignores unknown query parameters and takes no Candidate or family input", async () => {
    const response = await owner.get(`${HIRING_SEARCH_INPUTS_PATH}?family=backend&candidate=${otherId}`).expect(200)
    expect(response.body).toEqual({ hintTerms: ["remote", "relocation", "visa sponsorship"] })
  })

  it("without a session is 401 unauthenticated and runs no handler", async () => {
    const response = await browser.http().get(HIRING_SEARCH_INPUTS_PATH).expect(401)
    expect(apiErrorResponseSchema.parse(response.body).error).toEqual({ code: "unauthenticated", message: "Sign in to continue." })
  })

  it("needs no CSRF header (safe method)", async () => {
    await browser.http().get(HIRING_SEARCH_INPUTS_PATH).set("cookie", owner.cookie).expect(200)
  })

  it("is served without a verification and during both pauses (AC 3.9)", async () => {
    await database.db.updateTable("control_state").set({ global_paused: true, cost_paused: true }).execute()
    expect((await owner.get(HIRING_SEARCH_INPUTS_PATH).expect(200)).body).toEqual({ hintTerms: ["remote", "relocation", "visa sponsorship"] })
  })

  it("two loads answer the same and write nothing; no AI call, no spend (AC 3.9, 10.2)", async () => {
    const before = await snapshot()
    const first = (await owner.get(HIRING_SEARCH_INPUTS_PATH).expect(200)).body
    const second = (await owner.get(HIRING_SEARCH_INPUTS_PATH).expect(200)).body
    expect(second).toEqual(first)
    expect(await snapshot()).toBe(before)
  })
})

describe("cross-Candidate (EPIC-0002 registry; HV @permission @ac-1.1; threat model P1-6)", () => {
  it("reflects only the caller's own preferences: A has hints, B has none -> B gets []", async () => {
    expect(await asOther(() => app.get(StackPostsService).hiringSearchInputs())).toEqual({ hintTerms: [] })
    expect((await owner.get(HIRING_SEARCH_INPUTS_PATH).expect(200)).body.hintTerms).toHaveLength(3)
  })

  it("B's own preferences answer for B and leave A's unchanged", async () => {
    await setPreferences(otherId, { remoteAccepted: true, relocationAccepted: false, sponsorshipNeededForRelocation: false })
    await setPreferences(database.operatorId, { ...OWNER_VALUES, remoteAccepted: false })
    expect(await asOther(() => app.get(StackPostsService).hiringSearchInputs())).toEqual({ hintTerms: ["remote"] })
    expect((await owner.get(HIRING_SEARCH_INPUTS_PATH).expect(200)).body).toEqual({ hintTerms: ["relocation", "visa sponsorship"] })
  })

  it("RLS hides A's row from B's transaction even without the candidate_id filter", async () => {
    const tenant = new TenantDatabase(runtime)
    const visible = await CandidateScope.run(otherId, () => tenant.run((trx) => trx.selectFrom("job_preferences").select("candidate_id").execute()))
    expect(visible).toEqual([])
  })
})

describe("daily summary hiring links part (daily-summary-hiring.feature @phase1)", () => {
  it("names the first target family and builds its groups with the caller's hints, without a verification", async () => {
    await setCriteria(database.operatorId, { targets: ["backend", "fullstack", "senior_frontend"], frameworks: ["React"], technologies: ["TypeScript"] })
    const summary = await summaryFor(database.operatorId)
    expect(summary.verified).toBe(false)
    expect(summary.hiring).toEqual({
      family: "senior_frontend",
      hasOtherFamilies: true,
      groups: buildHiringSearchGroups({ family: "senior_frontend", frameworks: ["React"], technologies: ["TypeScript"], hintTerms: ["remote", "relocation", "visa sponsorship"] }),
    })
    expect(summary.hiring.family !== null && summary.hiring.groups[0]!.linkedinExpression).toBe(
      `${HIRING} AND ${FRONTEND} AND ("React" OR "TypeScript") AND ("remote" OR "relocation" OR "visa sponsorship")`
    )
  })

  it("is the same with the verification recorded", async () => {
    await database.db.insertInto("alert_feed_candidate_verification").values({ candidate_id: database.operatorId, verified_on: "2026-10-20", verification_basis: "Reviewed terms.", updated_at: clock.now() }).execute()
    const summary = await summaryFor(database.operatorId)
    expect(summary.verified).toBe(true)
    expect(summary.hiring).toMatchObject({ family: "senior_frontend", hasOtherFamilies: false })
  })

  it("40 terms give 10 groups of 4, equal to the Hiring view's", async () => {
    const frameworks = Array.from({ length: 20 }, (_, i) => `F${i}`)
    const technologies = Array.from({ length: 20 }, (_, i) => `T${i}`)
    await setCriteria(database.operatorId, { targets: ["senior_frontend"], frameworks, technologies })
    const { hiring } = await summaryFor(database.operatorId)
    expect(hiring.family).toBe("senior_frontend")
    if (hiring.family === null) return
    expect(hiring.groups).toHaveLength(10)
    expect(hiring.groups.every((group) => group.terms.length === 4)).toBe(true)
    expect(hiring.groups).toEqual(buildHiringSearchGroups({ family: "senior_frontend", frameworks, technologies, hintTerms: ["remote", "relocation", "visa sponsorship"] }))
  })

  it("empty technology lists give one any-technology group", async () => {
    await setCriteria(database.operatorId, { targets: ["senior_frontend"] })
    const { hiring } = await summaryFor(database.operatorId)
    expect(hiring.family !== null && hiring.groups.map((group) => group.terms)).toEqual([[]])
  })

  it("only Other targeted gives the no-family part", async () => {
    await setCriteria(database.operatorId, { targets: ["other"], frameworks: ["React"] })
    expect((await summaryFor(database.operatorId)).hiring).toEqual({ family: null })
  })

  it("no job_criteria row uses the default targets (Frontend first) and no terms", async () => {
    await database.db.deleteFrom("job_criteria").where("candidate_id", "=", database.operatorId).execute()
    try {
      const { hiring } = await summaryFor(database.operatorId)
      expect(hiring).toMatchObject({ family: "senior_frontend", hasOtherFamilies: true })
    } finally {
      await setCriteria(database.operatorId, { targets: ["senior_frontend"], frameworks: ["React"], technologies: ["TypeScript"] })
    }
  })

  it("the next summary after a settings save uses the new values (AC 3.8)", async () => {
    expect((await summaryFor(database.operatorId)).hiring).toMatchObject({ family: "senior_frontend" })
    await setCriteria(database.operatorId, { targets: ["backend"], frameworks: ["Go"] })
    const { hiring } = await summaryFor(database.operatorId)
    expect(hiring.family).toBe("backend")
    if (hiring.family === null) return
    expect(hiring.groups.map((group) => group.label)).toEqual(["Go"])
    expect(hiring.groups[0]!.linkedinExpression).toContain(BACKEND)
  })

  it("each Candidate's summary uses only her own settings (AC 4.2)", async () => {
    const theirs = await summaryFor(otherId)
    const text = renderDailySummary(
      { watDay: "2026-10-21", automaticToday: 0, submitted: [], blockedCount: 0, uncertainCount: 0, uncertain: [], failures: [], skipped: [], globalPaused: false, costPaused: false, costResumedToday: false, spend: null, stackPosts: theirs },
      BASE
    ).text
    const hiringText = text.slice(text.indexOf("Hiring search links"))
    expect(theirs.hiring).toMatchObject({ family: "backend", hasOtherFamilies: false })
    expect(hiringText).toContain("Past-week search hints for Backend roles.")
    expect(decodeURIComponent(hiringText)).toContain('"Django"')
    expect(decodeURIComponent(hiringText)).not.toContain("React")
    expect(decodeURIComponent(hiringText)).not.toContain("frontend engineer")
    // B has no Job Preferences, so no hint clause.
    expect(decodeURIComponent(hiringText)).not.toContain('"remote"')
  })

  it("rendering the part writes nothing, calls no AI provider and records no spend (AC 4.1, 10.2)", async () => {
    const before = await snapshot()
    await summaryFor(database.operatorId)
    await summaryFor(otherId)
    expect(await snapshot()).toBe(before)
    expect((await sql<{ n: number }>`select count(*)::int as n from ai_call`.execute(database.db)).rows[0]!.n).toBe(0)
  })

  it("no new email kind and no new schedule (AC 4.1)", async () => {
    const kinds = await sql<{ def: string }>`select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'notification_outbox'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%kind%'`.execute(database.db)
    expect(kinds.rows.map((row) => row.def).join(" ")).not.toMatch(/hiring/i)
  })

  it("an owner whose preferences row is unreadable still gets links, without hints", async () => {
    await setPreferences(database.operatorId, { remoteAccepted: 1 })
    const { hiring } = await summaryFor(database.operatorId)
    expect(hiring.family !== null && hiring.groups[0]!.linkedinExpression).toBe(`${HIRING} AND ${FRONTEND} AND ("React" OR "TypeScript")`)
  })

  it("a stored target key outside the catalog cannot exist (0020 check), so the reader only sees catalog keys", async () => {
    await expect(sql`update job_criteria set target_role_families = array['retired_key','backend']::text[] where candidate_id = ${database.operatorId}`.execute(database.db)).rejects.toThrow()
    expect((await asOwner(() => summaries.summary(randomUUID(), clock.now()))).hiring).toMatchObject({ family: "senior_frontend" })
  })
})
