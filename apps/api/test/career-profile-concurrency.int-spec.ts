import type { INestApplication } from "@nestjs/common"
import { type Kysely, sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import type { StoredSection } from "../src/db/schema.js"
import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/** create-database.ts pool size is 10; the burst must exceed it to reach CR2-01. */
const CONCURRENT_SAVES = 25
/** Each save takes milliseconds; the whole burst gets a generous but finite bound. */
const BURST_DEADLINE_MS = 15_000
const MAX_HEALTH_LATENCY_MS = 5_000

const SECTION: StoredSection = {
  id: "s1",
  kind: "experience",
  title: "Senior Frontend Engineer",
  organization: "Brightwave Ltd",
  period: "2021-2024",
  sourceQuote: "Brightwave Ltd, Senior Frontend Engineer, 2021-2024",
  facts: [{ id: "f1", text: "Led a team of 4 frontend engineers at Brightwave Ltd, 2021-2024", sourceQuote: "Led a team of 4 frontend engineers" }],
}

let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let browser: Browser
let candidate: SignedInCandidate
let admin: Kysely<unknown>

beforeAll(async () => {
  database = await startMigratedDatabase()
  admin = createDatabase(database.adminUrl) as unknown as Kysely<unknown>
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock: new TestClock(new Date()) })
  browser = new Browser(app, google)
  candidate = await signInCandidate(browser)
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await admin?.destroy()
  await database?.stop()
})

/**
 * Used only if the burst misses its deadline. In the pool deadlock every pool
 * connection is taken: one holds the version lock "idle in transaction" while its
 * request waits for a free connection, the others wait on the lock, and further
 * requests queue in the pool. Ending one session just hands the freed slot to the
 * next queued request, which blocks on the lock again. So every api session is
 * ended, repeatedly, until all requests have failed and returned. This exists only
 * so the red run ends and the suite can shut down; it never runs when saves complete.
 */
async function breakDeadlock(settled: () => boolean): Promise<number> {
  let ended = 0
  const giveUpAt = Date.now() + 20_000
  while (!settled() && Date.now() < giveUpAt) {
    const { rows } = await sql<{ pid: number }>`select pg_terminate_backend(pid) as pid from pg_stat_activity
      where usename = ${database.roles.runtime.name} and datname = ${database.roles.database}`.execute(admin)
    ended += rows.length
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return ended
}

function editRequest(n: number) {
  return {
    sections: [
      {
        id: SECTION.id,
        kind: SECTION.kind,
        title: SECTION.title,
        organization: SECTION.organization,
        period: SECTION.period,
        facts: [{ id: "f1", text: `Led a team of ${n} frontend engineers at Brightwave Ltd, 2021-2024` }],
      },
    ],
  }
}

type BurstResult = { statuses: number[]; health: { status: number | string; ms: number }[] }

/**
 * Sends `count` requests at once, polls /v1/health while they run, and fails
 * (instead of hanging) if they are still pending at the deadline.
 */
async function burst(count: number, send: (n: number) => Promise<number>): Promise<BurstResult> {
  const started = Date.now()
  const all = Promise.all(Array.from({ length: count }, (_, n) => send(n)))
  let done = false
  void all.finally(() => (done = true)).catch(() => undefined)

  const health: BurstResult["health"] = []
  const polling = (async () => {
    while (!done && Date.now() - started < BURST_DEADLINE_MS) {
      const t = Date.now()
      const status = await Promise.race([
        browser.http().get("/v1/health").then((r) => r.status, (e: Error) => e.message),
        new Promise<string>((resolve) => setTimeout(() => resolve("no answer"), MAX_HEALTH_LATENCY_MS)),
      ])
      health.push({ status, ms: Date.now() - t })
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  })()

  const outcome = await Promise.race([
    all.then((statuses) => ({ kind: "done" as const, statuses })),
    new Promise<{ kind: "deadline" }>((resolve) => setTimeout(() => resolve({ kind: "deadline" }), BURST_DEADLINE_MS)),
  ])
  await polling
  let endedSessions = 0
  if (outcome.kind === "deadline") {
    endedSessions = await breakDeadlock(() => done)
    await all.catch(() => undefined)
  }
  expect(
    { outcome: outcome.kind, endedSessions },
    `requests still pending after ${BURST_DEADLINE_MS} ms: the lock holder sat idle in transaction while the other pool connections waited on its lock (pool deadlock)`
  ).toEqual({ outcome: "done", endedSessions: 0 })
  return { statuses: outcome.kind === "done" ? outcome.statuses : [], health }
}

async function resetToApprovedVersion1(): Promise<void> {
  await database.db.deleteFrom("career_profile_version").execute()
  await database.db
    .insertInto("career_profile_version")
    .values({ candidate_id: database.operatorId, version: 1, status: "approved", source: "edit", resume_upload_id: null, sections: JSON.stringify([SECTION]), created_at: new Date(), approved_at: new Date() })
    .execute()
}

async function versions() {
  return database.db.selectFrom("career_profile_version").select(["version", "status"]).orderBy("version").execute()
}

const BURST_TEST_TIMEOUT_MS = BURST_DEADLINE_MS + 30_000

// CR2-01: requests that take the version lock must queue on it, not exhaust the pool.
describe("concurrent version-lock requests beyond the pool size (CR2-01)", () => {
  beforeEach(resetToApprovedVersion1)

  it(`${CONCURRENT_SAVES} concurrent saves all complete, leave one draft, and /v1/health keeps answering`, { timeout: BURST_TEST_TIMEOUT_MS }, async () => {
    const result = await burst(CONCURRENT_SAVES, (n) => candidate.put("/v1/career-profile/draft").send(editRequest(n + 1)).then((r) => r.status))
    expect(result.statuses).toEqual(Array.from({ length: CONCURRENT_SAVES }, () => 200))
    expect(result.health.length).toBeGreaterThan(0)
    expect(result.health.filter((probe) => probe.status !== 200)).toEqual([])
    expect(await versions()).toEqual([
      { version: 1, status: "approved" },
      { version: 2, status: "draft" },
    ])
    await browser.http().get("/v1/health").expect(200)
  })

  it(`${CONCURRENT_SAVES} concurrent approvals of the draft: one wins, the rest get 404, nothing hangs`, { timeout: BURST_TEST_TIMEOUT_MS }, async () => {
    await candidate.put("/v1/career-profile/draft").send(editRequest(5)).expect(200)
    const result = await burst(CONCURRENT_SAVES, () => candidate.post("/v1/career-profile/draft/approve").send({ version: 2 }).then((r) => r.status))
    expect(result.statuses.filter((status) => status === 200)).toHaveLength(1)
    expect(result.statuses.filter((status) => status === 404)).toHaveLength(CONCURRENT_SAVES - 1)
    expect(result.health.filter((probe) => probe.status !== 200)).toEqual([])
    expect(await versions()).toEqual([
      { version: 1, status: "replaced" },
      { version: 2, status: "approved" },
    ])
  })

  it(`${CONCURRENT_SAVES} concurrent discards of the draft: one wins, the rest get 404, nothing hangs`, { timeout: BURST_TEST_TIMEOUT_MS }, async () => {
    await candidate.put("/v1/career-profile/draft").send(editRequest(5)).expect(200)
    const result = await burst(CONCURRENT_SAVES, () => candidate.delete("/v1/career-profile/draft?version=2").then((r) => r.status))
    expect(result.statuses.filter((status) => status === 204)).toHaveLength(1)
    expect(result.statuses.filter((status) => status === 404)).toHaveLength(CONCURRENT_SAVES - 1)
    expect(result.health.filter((probe) => probe.status !== 200)).toEqual([])
    expect(await versions()).toEqual([{ version: 1, status: "approved" }])
  })
})
