import { randomUUID } from "node:crypto"

import type { INestApplication } from "@nestjs/common"
import { jobPostingsResponseSchema } from "@eve/contracts"
import { type Kysely, sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { SESSION_COOKIE } from "../src/auth/cookies.js"
import { CandidateScope } from "../src/db/candidate-scope.js"
import { DATABASE } from "../src/db/database.module.js"
import type { Database } from "../src/db/schema.js"
import { DiscoveryRepository } from "../src/discovery/discovery.repository.js"
import { Browser } from "./support/browser.js"
import { insertPostingFor } from "./support/candidate-posting.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * job-postings-per-candidate.feature:273 (@concurrent, AC 5.16, SEC-803; owner
 * decision D33 automated it): Kofi's ranked query takes 6 s, and Wanjiru pages
 * her Ranked tab at the same moment. Real api app, real runtime pool with the
 * 5 s statement timeout, real Postgres.
 *
 * "Her normal response time" is measured, not guessed: Wanjiru's solo p95 over
 * SOLO_SAMPLES requests after a warm-up, on this machine, in this run. Her
 * concurrent requests must each finish within NORMAL_FACTOR x that p95, with a
 * floor of NORMAL_FLOOR_MS so a fast machine's 10 ms p95 does not make the bound
 * flaky, and always far below the 5 s that a held page would take.
 */
const SOLO_SAMPLES = 20
const NORMAL_FACTOR = 3
const NORMAL_FLOOR_MS = 300
const CONCURRENT_PAGES = 5
const KOFI_SUB = "200000000000000000271"
const clock = new TestClock("2026-10-21T09:00:00.000Z")

let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let wanjiru: SignedInCandidate
let kofi: SignedInCandidate
let kofiId: string

async function rankedPostings(candidateId: string, company: string, count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    const id = randomUUID()
    const url = `https://boards.greenhouse.io/${company.toLowerCase()}/jobs/${id}`
    await insertPostingFor(database.db, candidateId, { id, application_url: url, requisition_id: id, apply_url: url, application_system: "Greenhouse", apply_mode: "automatic", origin: "employer_board", employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null, title: "Senior Frontend Engineer", title_folded: "senior frontend engineer", company, posting_text: "Remote.", status: "ranked", skip_reason: null, skip_detail: null, evaluation_failure: null, role_family: "senior_frontend", discovered_at: new Date(Date.UTC(2026, 9, 1, 8, index)), evaluated_at: null })
  }
}

async function timed<T>(work: () => PromiseLike<T>): Promise<{ value: T; ms: number; endedAt: number }> {
  const started = performance.now()
  const value = await work()
  const endedAt = performance.now()
  return { value, ms: endedAt - started, endedAt }
}

const p95 = (samples: number[]): number => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1]!

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  // Wanjiru is the signed-in Operator here; Kofi is an invitee seeded directly (no invite flow before slice C).
  wanjiru = await signInCandidate(new Browser(app, google))
  kofiId = (await database.db.insertInto("candidate").values({ email: "kofi.timeout@example.test", google_sub: KOFI_SUB, role: "candidate" } as never).returning("id").executeTakeFirstOrThrow()).id
  await database.db.insertInto("job_criteria").values({ candidate_id: kofiId, min_core_match_percent: 70 }).onConflict((oc) => oc.column("candidate_id").doNothing()).execute()
  const browser = new Browser(app, google)
  const { sessionCookie } = await browser.signIn({ sub: KOFI_SUB, email: "kofi.timeout@example.test", email_verified: true })
  const csrf = (await browser.getSession(sessionCookie).expect(200)).body.csrfToken as string
  kofi = new SignedInCandidate(browser, `${SESSION_COOKIE}=${sessionCookie}`, csrf, "kofi.timeout@example.test")
  await rankedPostings(database.operatorId, "Wanjiru", 30)
  await rankedPostings(kofiId, "Kofi", 30)
})

afterAll(async () => {
  vi.restoreAllMocks()
  await app?.close()
  google?.close()
  await database?.stop()
})

describe("one Candidate's slow page does not hold another's (job-postings-per-candidate.feature:273)", () => {
  it("Kofi's 6 s query ends with the generic error after about 5 s while Wanjiru's pages return within her normal response time", async () => {
    const page = () => wanjiru.get("/v1/job-postings?tab=ranked")
    for (let index = 0; index < 3; index++) await page().expect(200)
    const solo: number[] = []
    let soloBody: unknown
    for (let index = 0; index < SOLO_SAMPLES; index++) {
      const { value, ms } = await timed(() => page().expect(200))
      solo.push(ms)
      soloBody = value.body
    }
    const normalMs = Math.max(NORMAL_FACTOR * p95(solo), NORMAL_FLOOR_MS)
    expect(normalMs, "the bound must stay far below a held page").toBeLessThan(2_500)
    expect(jobPostingsResponseSchema.parse(soloBody).postings.every((posting) => posting.company === "Wanjiru")).toBe(true)

    // Only Kofi's page is slow: the sleep runs on the api pool inside his request's scope.
    const repository = app.get(DiscoveryRepository)
    const original = repository.listPage.bind(repository)
    const apiDb = app.get<Kysely<Database>>(DATABASE)
    let kofiSlept = false
    const slow = vi.spyOn(repository, "listPage").mockImplementation(async (...args: Parameters<typeof repository.listPage>) => {
      if (CandidateScope.current() === kofiId) {
        kofiSlept = true
        await sql`select pg_sleep(6)`.execute(apiDb)
      }
      return original(...args)
    })
    try {
      const kofiRequest = timed(() => kofi.get("/v1/job-postings?tab=ranked"))
      // Same moment: Wanjiru's first page starts with Kofi's, then she keeps paging while his query is held.
      const wanjiruPages: { status: number; ms: number; endedAt: number; body: unknown }[] = []
      for (let index = 0; index < CONCURRENT_PAGES; index++) {
        const { value, ms, endedAt } = await timed(() => page())
        wanjiruPages.push({ status: value.status, ms, endedAt, body: value.body })
      }
      const kofiResult = await kofiRequest

      expect(kofiSlept).toBe(true)
      expect(kofiResult.value.status).toBe(500)
      expect(kofiResult.value.body).toEqual({ error: { code: "internal_error", message: "Something went wrong." } })
      expect(kofiResult.ms).toBeGreaterThanOrEqual(4_900)
      expect(kofiResult.ms).toBeLessThan(6_000)

      for (const result of wanjiruPages) {
        expect(result.status).toBe(200)
        expect(result.body).toEqual(soloBody)
        expect(result.ms, `solo p95 ${p95(solo).toFixed(0)} ms, bound ${normalMs.toFixed(0)} ms`).toBeLessThan(normalMs)
        expect(result.endedAt).toBeLessThan(kofiResult.endedAt)
      }
    } finally {
      slow.mockRestore()
    }
  })
})
