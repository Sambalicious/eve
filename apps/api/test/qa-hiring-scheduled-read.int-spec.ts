import { type INestApplicationContext, Logger, type LoggerService } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { sql } from "kysely"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { anthropicConfig } from "../src/config/env.js"
import { CLOCK } from "../src/shared/clock.js"
import { ALERT_FEED_HTTP } from "../src/stack-posts/alert-feed-http.provider.js"
import { createAlertFeedHttp } from "../src/stack-posts/alert-feed-http.js"
import { StackPostsJobs } from "../src/worker/stack-posts-jobs.js"
import { WorkerHeartbeat } from "../src/worker/worker-heartbeat.js"
import { WorkerModule } from "../src/worker/worker.module.js"
import { atomFeed, googleRedirect } from "./support/alert-feed-fixtures.js"
import { OutboundRecorder } from "./support/fake-anthropic.js"
import { FakeFeedServer } from "./support/fake-feed-server.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import {
  HFEED_A,
  HFEED_A_DIGITS,
  HFEED_B,
  SFEED_A,
  clearPhase3,
  countRows,
  failInsertsFor,
  hiringRuns,
  insertHiringFeed,
  insertStackFeed,
  setHiringVerification,
  setLegacySharedVerification,
  setOwnStackVerification,
} from "./support/qa-hiring-feeds.js"
import { insertSecondCandidate } from "./support/second-candidate.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, migratedStorageRoot } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * QA-authored (EPIC-0007 Phase 3, run epic-0007-p3, test authoring).
 * The scheduled read per Candidate (api-contract.r1 "Scheduled read"): inside
 * the existing `stack-posts.read` job, after the Stack posts read, every
 * active Candidate's Hiring Alert feeds are read in that Candidate's own scope,
 * gated by that Candidate's own record, each in its own try/catch.
 * hiring-alert-feeds.feature r4 HAF:746 to :797, :875 to :962, :1022, :1038;
 * hiring-posts.feature r4 HP:33, :99 to :130, :170 to :212;
 * outbound-and-separation.feature r4 OUT:49, :73, :80.
 *
 * Runs the real worker module (`StackPostsJobs.runScheduled`, job handler, repositories, runtime role) with
 * the production Alert feed client pointed at a local feed server and a
 * recorded no-op sleep. Faults are injected with a fixture-only trigger that
 * makes one Candidate's run-row insert raise (the read's first step).
 */
const TIMEOUT_MS = 300
let database: TestDatabase
let google: FakeGoogle
let outbound: OutboundRecorder
let feeds: FakeFeedServer
let worker: INestApplicationContext
let bolaId: string
const sleeps: number[] = []
const clock = new TestClock("2026-10-24T07:00:00.000Z") // 08:00 WAT
const logs: string[] = []
const line = (message: unknown, ...rest: unknown[]) => void logs.push([message, ...rest].map(String).join(" "))
const capture: LoggerService = { log: line, warn: line, error: line, debug: line, verbose: line }
const undo: (() => Promise<void>)[] = []

const POST = (n: number) => `https://www.linkedin.com/posts/hiring-${n}-activity-72500000000000000${String(n).padStart(2, "0")}-x`
const feedOf = (...ns: number[]) => atomFeed(ns.map((n) => ({ title: `Hiring ${n}`, link: googleRedirect(POST(n)), published: "2026-10-24T06:00:00Z" })))

beforeAll(async () => {
  Logger.overrideLogger(capture)
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  outbound = new OutboundRecorder(google.server)
  feeds = await FakeFeedServer.start()
  bolaId = await insertSecondCandidate(database.db, "bola.read@example.test")
  await database.db.insertInto("job_criteria").values({ candidate_id: bolaId, min_core_match_percent: 70 }).onConflict((oc) => oc.column("candidate_id").doNothing()).execute()
  worker = await Test.createTestingModule({
    imports: [WorkerModule.forRoot({ databaseUrl: database.url, anthropic: anthropicConfig(undefined, "claude-haiku-5-5"), candidateStorageDir: migratedStorageRoot() })],
  })
    .overrideProvider(WorkerHeartbeat)
    .useValue({ onApplicationBootstrap: () => undefined, onApplicationShutdown: () => undefined })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .overrideProvider(ALERT_FEED_HTTP)
    .useValue(createAlertFeedHttp({ testOrigin: feeds.origin, timeoutMs: TIMEOUT_MS, sleep: async (ms) => void sleeps.push(ms) }))
    .compile()
  Logger.overrideLogger(capture)
  await worker.init()
})

beforeEach(async () => {
  clock.set("2026-10-24T07:00:00.000Z")
  feeds.reset()
  outbound.reset()
  sleeps.length = 0
  logs.length = 0
  await clearPhase3(database.db)
  await database.db.updateTable("candidate").set({ state: "active" } as never).where("id", "=", bolaId).execute()
  await database.db.updateTable("job_criteria").set({ frameworks: ["React"], technologies: ["TypeScript"] }).execute()
  Logger.overrideLogger(capture)
})

afterEach(async () => {
  while (undo.length > 0) await undo.pop()!()
  expect(logs.join("\n")).not.toContain(HFEED_A_DIGITS)
  expect(outbound.urls).toEqual([])
})

afterAll(async () => {
  await worker?.close()
  await feeds?.close()
  google?.close()
  await database?.stop()
  Logger.overrideLogger(false)
})

/**
 * One scheduled run through the job handler's entry point (api-contract.r1 "Scheduled read":
 * the Stack posts read, then every active Candidate's Hiring read). Repair wave 1 (G-01):
 * `runRead()` is the Stack posts read alone; `runScheduled()` is what the pg-boss worker calls.
 * It rethrows a Stack posts error after the Hiring reads; the assertions check every list's effects.
 */
async function scheduledRun(): Promise<void> {
  try {
    await worker.get(StackPostsJobs).runScheduled()
  } catch {
    // EPIC-0008: only a whole Stack posts loop failure is rethrown for pg-boss, after the Hiring reads ran.
  }
}

const hiringPosts = (candidateId: string) => countRows(database.db, "hiring_post", candidateId)
const feedState = async (candidateId: string, url: string) =>
  (await sql<{ last_read_at: Date | null; last_failure_reason: string | null }>`select last_read_at, last_failure_reason from hiring_alert_feed where candidate_id = ${candidateId}::uuid and url = ${url}`.execute(database.db)).rows[0]

describe("per-Candidate gate (HAF:746, :756, :765, :797; D14, D15)", () => {
  it("HAF:746 nobody has her own record: no request even with the shared record; each run is skipped_unverified", async () => {
    await setLegacySharedVerification(database.db, true)
    await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    await insertHiringFeed(database.db, bolaId, HFEED_B)
    feeds.on(HFEED_A, { kind: "body", body: feedOf(1) })
    feeds.on(HFEED_B, { kind: "body", body: feedOf(2) })
    await scheduledRun()
    expect(feeds.requestsTo(HFEED_A)).toBe(0)
    expect(feeds.requestsTo(HFEED_B)).toBe(0)
    expect(await countRows(database.db, "hiring_post")).toBe(0)
    expect(await hiringRuns(database.db, database.operatorId)).toEqual(["skipped_unverified"])
    expect(await hiringRuns(database.db, bolaId)).toEqual(["skipped_unverified"])
  })

  it("HAF:756 only Candidates with their own record are read, each into her own posts", async () => {
    await setHiringVerification(database.db, database.operatorId)
    await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    await insertHiringFeed(database.db, bolaId, HFEED_B)
    feeds.on(HFEED_A, { kind: "body", body: feedOf(1, 2) })
    feeds.on(HFEED_B, { kind: "body", body: feedOf(3) })
    await scheduledRun()
    expect(feeds.requestsTo(HFEED_A)).toBe(1)
    expect(feeds.requestsTo(HFEED_B)).toBe(0)
    expect(await hiringPosts(database.operatorId)).toBe(2)
    expect(await hiringPosts(bolaId)).toBe(0)
    expect(await hiringRuns(database.db, database.operatorId)).toEqual(["completed"])
    expect(await hiringRuns(database.db, bolaId)).toEqual(["skipped_unverified"])
  })

  it("HAF:765 a Candidate is read from the first run after she records her check", async () => {
    await insertHiringFeed(database.db, bolaId, HFEED_B)
    feeds.on(HFEED_B, { kind: "body", body: feedOf(3) })
    await scheduledRun()
    expect(feeds.requestsTo(HFEED_B)).toBe(0)
    clock.set("2026-10-24T08:00:00.000Z")
    await setHiringVerification(database.db, bolaId)
    expect(feeds.requestsTo(HFEED_B)).toBe(0)
    clock.set("2026-10-24T13:00:00.000Z")
    await scheduledRun()
    expect(feeds.requestsTo(HFEED_B)).toBe(1)
  })

  it("HAF:797 a Candidate whose account is not active is not read, even with her own record", async () => {
    await setHiringVerification(database.db, bolaId)
    await insertHiringFeed(database.db, bolaId, HFEED_B)
    feeds.on(HFEED_B, { kind: "body", body: feedOf(3) })
    for (const state of ["revoked", "deleting"]) {
      await database.db.updateTable("candidate").set({ state } as never).where("id", "=", bolaId).execute()
      await scheduledRun()
      expect(feeds.requestsTo(HFEED_B), state).toBe(0)
    }
    expect(await hiringPosts(bolaId)).toBe(0)
  })

  it("the shared EPIC-0005 record does not stop the Hiring read when absent", async () => {
    await setLegacySharedVerification(database.db, false)
    await setHiringVerification(database.db, database.operatorId)
    await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    feeds.on(HFEED_A, { kind: "body", body: feedOf(1) })
    await scheduledRun()
    expect(feeds.requestsTo(HFEED_A)).toBe(1)
  })
})

describe("failure isolation (HAF:774, :783)", () => {
  it("HAF:774 Ada's Hiring read failing before its first request does not stop Bola's read", async () => {
    await setHiringVerification(database.db, database.operatorId)
    await setHiringVerification(database.db, bolaId)
    await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    await insertHiringFeed(database.db, bolaId, HFEED_B)
    feeds.on(HFEED_A, { kind: "body", body: feedOf(1) })
    feeds.on(HFEED_B, { kind: "body", body: feedOf(3, 4) })
    undo.push(await failInsertsFor(database.db, "hiring_post_run", database.operatorId))
    await scheduledRun()
    expect(feeds.requestsTo(HFEED_A)).toBe(0)
    expect(feeds.requestsTo(HFEED_B)).toBe(1)
    expect(await hiringPosts(bolaId)).toBe(2)
    expect(await hiringRuns(database.db, bolaId)).toEqual(["completed"])
  })

  it("HAF:783 row 1 (EPIC-0008 AR-10): Ada's Stack posts read failing does not stop either Hiring read, and the run resolves", async () => {
    await setOwnStackVerification(database.db, database.operatorId, true)
    await setHiringVerification(database.db, database.operatorId)
    await setHiringVerification(database.db, bolaId)
    await insertStackFeed(database.db, database.operatorId, SFEED_A)
    await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    await insertHiringFeed(database.db, bolaId, HFEED_B)
    for (const url of [SFEED_A, HFEED_A, HFEED_B]) feeds.on(url, { kind: "body", body: feedOf(1) })
    undo.push(await failInsertsFor(database.db, "stack_post_run", database.operatorId))
    const result = await worker.get(StackPostsJobs).runScheduled()
    expect(result.stack.find((entry) => entry.candidateId === database.operatorId)?.result).toBe("failed")
    expect(feeds.requestsTo(SFEED_A)).toBe(0)
    expect(feeds.requestsTo(HFEED_A)).toBe(1)
    expect(feeds.requestsTo(HFEED_B)).toBe(1)
  })

  it("HAF:783 row 2: Ada's Hiring read failing does not stop the Stack posts read or Bola's read", async () => {
    await setOwnStackVerification(database.db, database.operatorId, true)
    await setHiringVerification(database.db, database.operatorId)
    await setHiringVerification(database.db, bolaId)
    await insertStackFeed(database.db, database.operatorId, SFEED_A)
    await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    await insertHiringFeed(database.db, bolaId, HFEED_B)
    for (const url of [SFEED_A, HFEED_A, HFEED_B]) feeds.on(url, { kind: "body", body: feedOf(1) })
    undo.push(await failInsertsFor(database.db, "hiring_post_run", database.operatorId))
    await scheduledRun()
    expect(feeds.requestsTo(SFEED_A)).toBe(1)
    expect(feeds.requestsTo(HFEED_A)).toBe(0)
    expect(feeds.requestsTo(HFEED_B)).toBe(1)
  })
})

describe("reading rules carried over from EPIC-0005 (HAF:875 to :962, :1022, :1038; OUT:49)", () => {
  beforeEach(async () => {
    await setHiringVerification(database.db, database.operatorId)
  })

  it("HAF:875 four runs: one GET per feed per run", async () => {
    await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    await insertHiringFeed(database.db, database.operatorId, HFEED_B)
    feeds.on(HFEED_A, { kind: "body", body: feedOf(1) })
    feeds.on(HFEED_B, { kind: "body", body: feedOf(2) })
    for (const at of ["2026-10-24T01:00:00Z", "2026-10-24T07:00:00Z", "2026-10-24T13:00:00Z", "2026-10-24T19:00:00Z"]) {
      clock.set(at)
      await scheduledRun()
    }
    expect([feeds.requestsTo(HFEED_A), feeds.requestsTo(HFEED_B)]).toEqual([4, 4])
  })

  it("HAF:882 one run reads the Stack posts feed and the Hiring feed once each; items land in their own lists only", async () => {
    await setOwnStackVerification(database.db, database.operatorId, true)
    await insertStackFeed(database.db, database.operatorId, SFEED_A)
    await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    feeds.on(SFEED_A, { kind: "body", body: feedOf(1) })
    feeds.on(HFEED_A, { kind: "body", body: feedOf(2) })
    await scheduledRun()
    expect([feeds.requestsTo(SFEED_A), feeds.requestsTo(HFEED_A)]).toEqual([1, 1])
    expect((await database.db.selectFrom("stack_post").select("canonical_url").execute()).map((r) => r.canonical_url)).toEqual([POST(1)])
    expect((await sql<{ canonical_url: string }>`select canonical_url from hiring_post`.execute(database.db)).rows.map((r) => r.canonical_url)).toEqual([POST(2)])
  })

  it("HAF:891/:901 a failing feed is marked with reason and time after bounded retries; the other feed is stored", async () => {
    await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    await insertHiringFeed(database.db, database.operatorId, HFEED_B)
    feeds.on(HFEED_A, { kind: "status", status: 500 })
    feeds.on(HFEED_B, { kind: "body", body: feedOf(2) })
    await scheduledRun()
    expect(feeds.requestsTo(HFEED_A)).toBe(3) // first attempt + the board readers' two retries
    expect(sleeps).toEqual([1_000, 4_000])
    expect(await feedState(database.operatorId, HFEED_A)).toMatchObject({ last_failure_reason: "unexpected_response" })
    expect(await hiringPosts(database.operatorId)).toBe(1)
  })

  it("HAF:901 a timeout then a valid feed: not marked failing", async () => {
    await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    feeds.on(HFEED_A, (attempt) => (attempt === 1 ? { kind: "status", status: 503 } : { kind: "body", body: feedOf(1) }))
    await scheduledRun()
    expect(feeds.requestsTo(HFEED_A)).toBeLessThanOrEqual(3)
    expect(await feedState(database.operatorId, HFEED_A)).toMatchObject({ last_failure_reason: null })
  })

  it("HAF:927 a redirect during a read is not followed and marks the feed redirected", async () => {
    await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    feeds.on(HFEED_A, { kind: "redirect", status: 302, location: "https://www.google.com/url?q=https://www.linkedin.com/posts/x" })
    await scheduledRun()
    expect(feeds.requestsTo(HFEED_A)).toBe(1)
    expect(await feedState(database.operatorId, HFEED_A)).toMatchObject({ last_failure_reason: "redirected" })
  })

  it("HAF:936 a stored Hiring feed URL outside the Google Alerts feed path cannot even be stored (table check)", async () => {
    await expect(insertHiringFeed(database.db, database.operatorId, "https://www.google.com/search?q=hiring")).rejects.toThrow(/check constraint/)
  })

  it("HAF:944 global pause: no request and the run is skipped_global_pause", async () => {
    await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    feeds.on(HFEED_A, { kind: "body", body: feedOf(1) })
    await database.db.updateTable("control_state").set({ global_paused: true }).execute()
    await scheduledRun()
    expect(feeds.requestsTo(HFEED_A)).toBe(0)
    expect(await hiringRuns(database.db, database.operatorId)).toEqual(["skipped_global_pause"])
  })

  it("HAF:962 / OUT:80 the cost-ceiling pause does not stop Hiring reads", async () => {
    await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    feeds.on(HFEED_A, { kind: "body", body: feedOf(1) })
    await database.db.updateTable("control_state").set({ cost_paused: true }).execute()
    await scheduledRun()
    expect(feeds.requestsTo(HFEED_A)).toBe(1)
    expect(await hiringPosts(database.operatorId)).toBe(1)
  })

  it("HAF:910 a removed feed is not read again; its posts stay with source null", async () => {
    const id = await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    feeds.on(HFEED_A, { kind: "body", body: feedOf(1, 2, 3) })
    await scheduledRun()
    await sql`delete from hiring_alert_feed where id = ${id}::uuid`.execute(database.db)
    clock.set("2026-10-24T13:00:00.000Z")
    await scheduledRun()
    expect(feeds.requestsTo(HFEED_A)).toBe(1)
    expect((await sql<{ s: string | null }>`select source_feed_id as s from hiring_post`.execute(database.db)).rows).toEqual([{ s: null }, { s: null }, { s: null }])
  })

  it("HAF:1022 the same URL for two Candidates is read for each, with separate state and separate posts", async () => {
    await setHiringVerification(database.db, bolaId)
    await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    await insertHiringFeed(database.db, bolaId, HFEED_A)
    feeds.on(HFEED_A, { kind: "body", body: feedOf(1, 2) })
    await scheduledRun()
    expect(feeds.requestsTo(HFEED_A)).toBe(2)
    expect([await hiringPosts(database.operatorId), await hiringPosts(bolaId)]).toEqual([2, 2])
  })

  it("OUT:49 / HP:33 20 entries behind Google redirect links: exactly one outbound request, to the feed", async () => {
    await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    feeds.on(HFEED_A, { kind: "body", body: feedOf(...Array.from({ length: 20 }, (_, i) => i + 1)) })
    await scheduledRun()
    expect(feeds.requests.map((r) => r.path)).toEqual([new URL(HFEED_A).pathname])
    expect(await hiringPosts(database.operatorId)).toBe(20)
  })

  it("HAF:1038 / OUT:73 reads make no AI call and record no spend", async () => {
    await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    feeds.on(HFEED_A, { kind: "body", body: feedOf(1) })
    await scheduledRun()
    expect(await database.db.selectFrom("ai_call").select("id").execute()).toEqual([])
    expect(await database.db.selectFrom("spend_entry").select("id").execute()).toEqual([])
  })
})

describe("kept posts, de-duplication and retention per Candidate (HP:99 to :212)", () => {
  beforeEach(async () => {
    await setHiringVerification(database.db, database.operatorId)
    await setHiringVerification(database.db, bolaId)
  })

  it("HP:99/:123 the same post again, or twice in one response, stores one Hiring post", async () => {
    await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    feeds.on(HFEED_A, { kind: "body", body: feedOf(1, 1) })
    await scheduledRun()
    clock.set("2026-10-24T13:00:00.000Z")
    await scheduledRun()
    expect(await hiringPosts(database.operatorId)).toBe(1)
  })

  it("HP:107 the same post in two of her feeds keeps the first source", async () => {
    const a = await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    await insertHiringFeed(database.db, database.operatorId, HFEED_B)
    feeds.on(HFEED_A, { kind: "body", body: feedOf(1) })
    feeds.on(HFEED_B, { kind: "body", body: feedOf(1) })
    await scheduledRun()
    expect((await sql<{ s: string }>`select source_feed_id::text as s from hiring_post`.execute(database.db)).rows).toEqual([{ s: a }])
  })

  it("HP:115 the same LinkedIn URL may be a Stack post and a Hiring post", async () => {
    await setOwnStackVerification(database.db, database.operatorId, true)
    await insertStackFeed(database.db, database.operatorId, SFEED_A)
    await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    feeds.on(SFEED_A, { kind: "body", body: feedOf(1) })
    feeds.on(HFEED_A, { kind: "body", body: feedOf(1) })
    await scheduledRun()
    expect([await countRows(database.db, "stack_post", database.operatorId), await hiringPosts(database.operatorId)]).toEqual([1, 1])
  })

  it("HP:130 de-duplication is per Candidate", async () => {
    await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    await insertHiringFeed(database.db, bolaId, HFEED_B)
    feeds.on(HFEED_A, { kind: "body", body: feedOf(1) })
    feeds.on(HFEED_B, { kind: "body", body: feedOf(1) })
    await scheduledRun()
    expect([await hiringPosts(database.operatorId), await hiringPosts(bolaId)]).toEqual([1, 1])
  })

  it("HP:170/:191/:198/:205/:212 retention deletes her posts over 90 days after the run, even if every feed failed; never Stack posts or Bola's", async () => {
    await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    feeds.on(HFEED_A, { kind: "status", status: 404 })
    const old = new Date("2026-07-20T07:00:00Z") // 96 days before the run
    for (const id of [database.operatorId, bolaId]) {
      await sql`insert into hiring_post (candidate_id, id, canonical_url, kind, first_seen_at) values (${id}::uuid, gen_random_uuid(), 'https://www.linkedin.com/posts/old', 'post', ${old})`.execute(database.db)
    }
    await database.db
      .insertInto("stack_post")
      .values({ candidate_id: database.operatorId, id: crypto.randomUUID(), canonical_url: "https://www.linkedin.com/posts/old-stack", kind: "post", title: "", snippet: "", published_at: null, matched_technologies: [], source_feed_id: null, first_seen_at: old })
      .execute()
    // Bola is not active for this run, so she has no Hiring read and no retention. (Before OWN-4 she had no record;
    // since the owner decision 2026-10-29 17:29Z a skipped active Candidate prunes her own Hiring posts.)
    await database.db.updateTable("candidate").set({ state: "revoked" } as never).where("id", "=", bolaId).execute()
    // "Never Stack posts": the Hiring loop on its own (what runScheduled runs second) leaves Ada's old Stack post.
    await worker.get(StackPostsJobs).runHiringReads()
    expect(await hiringPosts(database.operatorId)).toBe(0)
    expect(await hiringPosts(bolaId)).toBe(1) // Bola had no run; Ada's retention never touches her posts
    expect(await countRows(database.db, "stack_post", database.operatorId)).toBe(1)
    // The full scheduled run: Hiring results unchanged. Ada has no Stack posts record, and since CR-E8-02 (owner
    // decision 2026-10-29) the Stack posts reader applies its own retention on her skipped_unverified run.
    await scheduledRun()
    expect(await hiringPosts(database.operatorId)).toBe(0)
    expect(await hiringPosts(bolaId)).toBe(1)
    expect(await countRows(database.db, "stack_post", database.operatorId)).toBe(0)
    expect((await sql<{ outcome: string; posts_deleted: number }>`select outcome, posts_deleted from stack_post_run where candidate_id = ${database.operatorId}::uuid`.execute(database.db)).rows).toEqual([{ outcome: "skipped_unverified", posts_deleted: 1 }])
  })
})
