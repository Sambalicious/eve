import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { type INestApplicationContext, Logger, type LoggerService } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { sql } from "kysely"
import pg from "pg"
import { PgBoss } from "pg-boss"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { anthropicConfig } from "../src/config/env.js"
import { JOB_QUEUE_SCHEMA } from "../src/db/job-queue-schema.js"
import { CLOCK } from "../src/shared/clock.js"
import { ALERT_FEED_HTTP } from "../src/stack-posts/alert-feed-http.provider.js"
import { type AlertFeedGetOptions, type AlertFeedHttp, createAlertFeedHttp } from "../src/stack-posts/alert-feed-http.js"
import { STACK_POSTS_READ_QUEUE, StackPostsJobs } from "../src/worker/stack-posts-jobs.js"
import { WorkerHeartbeat } from "../src/worker/worker-heartbeat.js"
import { WorkerModule } from "../src/worker/worker.module.js"
import { atomFeed, googleRedirect } from "./support/alert-feed-fixtures.js"
import { OutboundRecorder } from "./support/fake-anthropic.js"
import { FakeFeedServer } from "./support/fake-feed-server.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import {
  HFEED_A,
  HFEED_B,
  SFEED_A,
  SFEED_A_DIGITS,
  SFEED_B,
  SFEED_B_DIGITS,
  SFEED_C,
  clearEpic8,
  countRows,
  failInsertsFor,
  insertHiringFeed,
  insertInvitee,
  insertStackFeed,
  insertStackPosts,
  revokeRuntime,
  setHiringRecord,
  setLegacy,
  setOwnStack,
  stackRuns,
  until,
} from "./support/qa-stack-feed.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, migratedStorageRoot } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * QA-authored (EPIC-0008, run epic-0008, test authoring).
 * stack-feed-scheduled-reads.feature r1 (AC 3.1 to 3.5, 6.1, 6.4, 8.1) and the
 * worker rows of stack-feed-migration.feature: one Stack posts read per active
 * Candidate per scheduled time, each in her own scope, gated by her own row in
 * `alert_feed_candidate_verification`, each in its own try/catch (contract
 * "Scheduled Stack posts read, per Candidate", AR-6, AR-10).
 *
 * The real worker module runs (`StackPostsJobs`, repositories, runtime role)
 * with the production Alert feed client pointed at a local feed server through
 * its `testOrigin` seam and a recorded no-op sleep. Most rows drive one run with
 * `runScheduled()`, the pg-boss handler's body. The duplicate-fire row (AR-11)
 * goes through the scheduling path instead: two cron-path jobs for the same
 * occurrence are inserted into the real `stack-posts.read` queue the way the
 * pg-boss timekeeper files them, and the worker's own `boss.work` handler runs.
 * Faults are injected with a fixture-only trigger on the read's first insert.
 */
const TIMEOUT_MS = 300
let database: TestDatabase
let google: FakeGoogle
let outbound: OutboundRecorder
let feeds: FakeFeedServer
let worker: INestApplicationContext
let adaId: string
let bolaId: string
let chidiId: string
const sleeps: number[] = []
const clock = new TestClock("2026-10-24T07:00:00.000Z") // 08:00 WAT
const logs: string[] = []
const line = (message: unknown, ...rest: unknown[]) => void logs.push([message, ...rest].map(String).join(" "))
const capture: LoggerService = { log: line, warn: line, error: line, debug: line, verbose: line }
const undo: (() => Promise<void>)[] = []

/** Counts in-flight feed GETs and holds them on request (sequential-loop and mid-run rows). */
class InFlightHttp implements AlertFeedHttp {
  inner!: AlertFeedHttp
  inFlight = 0
  maxInFlight = 0
  readonly started: { url: string; at: number }[] = []
  private readonly gates = new Map<string, { open: Promise<void>; release: () => void }>()
  delayMs = 0

  hold(url: string): void {
    let release!: () => void
    const open = new Promise<void>((r) => (release = r))
    this.gates.set(url, { open, release })
  }

  release(url: string): void {
    this.gates.get(url)?.release()
    this.gates.delete(url)
  }

  reset(): void {
    for (const url of [...this.gates.keys()]) this.release(url)
    this.inFlight = 0
    this.maxInFlight = 0
    this.started.length = 0
    this.delayMs = 0
  }

  async get(url: string, options: AlertFeedGetOptions): Promise<string | null> {
    this.inFlight += 1
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    this.started.push({ url, at: Date.now() })
    try {
      await this.gates.get(url)?.open
      if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs))
      return await this.inner.get(url, options)
    } finally {
      this.inFlight -= 1
    }
  }
}
const http = new InFlightHttp()

const POST = (tag: string, n: number) => `https://www.linkedin.com/posts/${tag}-${n}-activity-7250000000000000${String(n).padStart(3, "0")}-x`
const feedOf = (tag: string, ...ns: number[]) => atomFeed(ns.map((n) => ({ title: `${tag} ${n}`, link: googleRedirect(POST(tag, n)), published: "2026-10-24T06:00:00Z", content: "React" })))

beforeAll(async () => {
  Logger.overrideLogger(capture)
  database = await startMigratedDatabase()
  adaId = database.operatorId
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  outbound = new OutboundRecorder(google.server)
  feeds = await FakeFeedServer.start()
  bolaId = await insertInvitee(database.db, "bola@example.com")
  chidiId = await insertInvitee(database.db, "chidi@example.com")
  http.inner = createAlertFeedHttp({ testOrigin: feeds.origin, timeoutMs: TIMEOUT_MS, sleep: async (ms) => void sleeps.push(ms) })
  worker = await Test.createTestingModule({
    imports: [WorkerModule.forRoot({ databaseUrl: database.url, anthropic: anthropicConfig(undefined, "claude-haiku-5-5"), candidateStorageDir: migratedStorageRoot() })],
  })
    .overrideProvider(WorkerHeartbeat)
    .useValue({ onApplicationBootstrap: () => undefined, onApplicationShutdown: () => undefined })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .overrideProvider(ALERT_FEED_HTTP)
    .useValue(http)
    .compile()
  Logger.overrideLogger(capture)
  await worker.init()
})

beforeEach(async () => {
  clock.set("2026-10-24T07:00:00.000Z")
  feeds.reset()
  http.reset()
  outbound.reset()
  sleeps.length = 0
  logs.length = 0
  await clearEpic8(database.db)
  await database.db.updateTable("candidate").set({ state: "active" } as never).where("id", "in", [bolaId, chidiId]).execute()
  await database.db.updateTable("job_criteria").set({ frameworks: ["React"], technologies: ["TypeScript"] }).execute()
  Logger.overrideLogger(capture)
})

afterEach(async () => {
  while (undo.length > 0) await undo.pop()!()
  const all = logs.join("\n")
  expect(all).not.toContain(SFEED_A_DIGITS)
  expect(all).not.toContain(SFEED_B_DIGITS)
  expect(outbound.urls).toEqual([])
})

afterAll(async () => {
  http.reset()
  await worker?.close()
  await feeds?.close()
  google?.close()
  await database?.stop()
  Logger.overrideLogger(false)
})

type StackEntry = { candidateId: string; result: { outcome: string; feedsRead: number } | "not_active" | "failed" }

/** One scheduled run through the job handler's body; a whole-loop Stack posts error is rethrown after the Hiring reads. */
async function scheduledRun(): Promise<{ stack: readonly StackEntry[] } | null> {
  try {
    return (await worker.get(StackPostsJobs).runScheduled()) as unknown as { stack: readonly StackEntry[] }
  } catch {
    return null
  }
}

const stackPosts = (candidateId: string) => countRows(database.db, "stack_post", candidateId)
const feedState = async (candidateId: string, url: string) =>
  (await sql<{ last_read_at: Date | null; last_failure_reason: string | null }>`select last_read_at, last_failure_reason from alert_feed where candidate_id = ${candidateId}::uuid and url = ${url}`.execute(database.db)).rows[0]

describe("every active Candidate, her own scope (scheduled:26, :36, :44, :51)", () => {
  it("scheduled:26 Ada's and Bola's verified feeds are read in one run, each into her own posts; one completed run each", async () => {
    await setOwnStack(database.db, adaId)
    await setOwnStack(database.db, bolaId)
    await insertStackFeed(database.db, adaId, SFEED_A)
    await insertStackFeed(database.db, bolaId, SFEED_B)
    feeds.on(SFEED_A, { kind: "body", body: feedOf("a", 1, 2) })
    feeds.on(SFEED_B, { kind: "body", body: feedOf("b", 1, 2, 3) })
    const result = await scheduledRun()
    expect([feeds.requestsTo(SFEED_A), feeds.requestsTo(SFEED_B)]).toEqual([1, 1])
    expect([await stackPosts(adaId), await stackPosts(bolaId)]).toEqual([2, 3])
    expect(await stackRuns(database.db, adaId)).toEqual(["completed"])
    expect(await stackRuns(database.db, bolaId)).toEqual(["completed"])
    // Contract: runScheduled returns one StackRunEntry per Candidate (AR-6).
    expect(result?.stack.map((e) => e.candidateId).sort()).toEqual([adaId, bolaId, chidiId].sort())
  })

  it("scheduled:36 four runs (02:00, 08:00, 14:00, 20:00 WAT): one GET per feed per run, for every verified Candidate", async () => {
    await setOwnStack(database.db, adaId)
    await setOwnStack(database.db, bolaId)
    await insertStackFeed(database.db, adaId, SFEED_A)
    await insertStackFeed(database.db, bolaId, SFEED_B)
    await insertStackFeed(database.db, bolaId, SFEED_C)
    for (const url of [SFEED_A, SFEED_B, SFEED_C]) feeds.on(url, { kind: "body", body: feedOf("x", 1) })
    for (const at of ["2026-10-24T01:00:00Z", "2026-10-24T07:00:00Z", "2026-10-24T13:00:00Z", "2026-10-24T19:00:00Z"]) {
      clock.set(at)
      await scheduledRun()
    }
    expect([SFEED_A, SFEED_B, SFEED_C].map((u) => feeds.requestsTo(u))).toEqual([4, 4, 4])
  })

  it("scheduled:44 three Candidates' reads run one after another: never two feed requests in flight", async () => {
    const urls = [SFEED_A, SFEED_B, SFEED_C]
    for (const [i, id] of [adaId, bolaId, chidiId].entries()) {
      await setOwnStack(database.db, id)
      await insertStackFeed(database.db, id, urls[i]!)
      feeds.on(urls[i]!, { kind: "body", body: feedOf(`c${i}`, 1) })
    }
    http.delayMs = 150
    await scheduledRun()
    expect(http.started.map((s) => s.url).sort()).toEqual([...urls].sort())
    expect(http.maxInFlight).toBe(1)
  })

  it("scheduled:51 her run row is started before her first request; both feeds read once; retention keeps her newest 2,000; completed with 2 feeds read", async () => {
    await setOwnStack(database.db, bolaId)
    await insertStackFeed(database.db, bolaId, SFEED_B)
    await insertStackFeed(database.db, bolaId, SFEED_C)
    await insertStackPosts(database.db, bolaId, 2_005, { prefix: "old", firstSeen: (i) => new Date(Date.UTC(2026, 9, 20) + i * 1_000) })
    feeds.on(SFEED_B, { kind: "body", body: atomFeed([]) })
    feeds.on(SFEED_C, { kind: "body", body: atomFeed([]) })
    http.hold(SFEED_B)
    const run = scheduledRun()
    await until(() => http.started.length > 0)
    const runRowBeforeFetch = (await countRows(database.db, "stack_post_run", bolaId)) === 1
    http.release(SFEED_B)
    await run
    expect(runRowBeforeFetch).toBe(true)
    expect([feeds.requestsTo(SFEED_B), feeds.requestsTo(SFEED_C)]).toEqual([1, 1])
    expect(await stackPosts(bolaId)).toBe(2_000)
    const row = (await sql<{ outcome: string; feeds_read: number }>`select outcome, feeds_read from stack_post_run where candidate_id = ${bolaId}::uuid`.execute(database.db)).rows
    expect(row).toEqual([{ outcome: "completed", feeds_read: 2 }])
  })
})

describe("gated by her own record only (scheduled:63, :72, :88, :96, :105, :112, :119; migration:51, :121, :182)", () => {
  it("scheduled:63 Bola without her own record is skipped_unverified with no request; Ada is read", async () => {
    await setOwnStack(database.db, adaId)
    await insertStackFeed(database.db, adaId, SFEED_A)
    await insertStackFeed(database.db, bolaId, SFEED_B)
    feeds.on(SFEED_A, { kind: "body", body: feedOf("a", 1) })
    feeds.on(SFEED_B, { kind: "body", body: feedOf("b", 1) })
    await scheduledRun()
    expect(feeds.requestsTo(SFEED_B)).toBe(0)
    expect(feeds.requestsTo(SFEED_A)).toBe(1)
    expect(await stackRuns(database.db, bolaId)).toEqual(["skipped_unverified"])
  })

  it.each([
    ["ada (Operator) has her own record", async () => setOwnStack(database.db, adaId)],
    ["chidi has his own record", async () => setOwnStack(database.db, chidiId)],
    ["bola has her own Hiring record", async () => setHiringRecord(database.db, bolaId)],
    ["the legacy shared record exists", async () => setLegacy(database.db, true)],
  ] as const)("scheduled:72 Bola, no record of her own (%s): no request to SFEED_B, skipped_unverified, no posts", async (_name, given) => {
    await given()
    await insertStackFeed(database.db, bolaId, SFEED_B)
    feeds.on(SFEED_B, { kind: "body", body: feedOf("b", 1) })
    await scheduledRun()
    expect(feeds.requestsTo(SFEED_B)).toBe(0)
    expect(await stackRuns(database.db, bolaId)).toEqual(["skipped_unverified"])
    expect(await stackPosts(bolaId)).toBe(0)
  })

  it("scheduled:88 the Operator is not read on the legacy shared record alone", async () => {
    await setLegacy(database.db, true)
    await insertStackFeed(database.db, adaId, SFEED_A)
    feeds.on(SFEED_A, { kind: "body", body: feedOf("a", 1) })
    await scheduledRun()
    expect(feeds.requestsTo(SFEED_A)).toBe(0)
    expect(await stackRuns(database.db, adaId)).toEqual(["skipped_unverified"])
  })

  it("scheduled:96, migration:182 she is read from the first run after she records; no request in between", async () => {
    await insertStackFeed(database.db, bolaId, SFEED_B)
    feeds.on(SFEED_B, { kind: "body", body: feedOf("b", 1, 2) })
    await scheduledRun()
    expect(feeds.requestsTo(SFEED_B)).toBe(0)
    clock.set("2026-10-24T08:00:00.000Z")
    await setOwnStack(database.db, bolaId)
    expect(feeds.requestsTo(SFEED_B)).toBe(0)
    clock.set("2026-10-24T13:00:00.000Z")
    await scheduledRun()
    expect(feeds.requestsTo(SFEED_B)).toBe(1)
    expect(await stackPosts(bolaId)).toBe(2)
  })

  it("scheduled:105 updating her record keeps her read on schedule", async () => {
    await setOwnStack(database.db, bolaId, "2026-10-15")
    await insertStackFeed(database.db, bolaId, SFEED_B)
    feeds.on(SFEED_B, { kind: "body", body: feedOf("b", 1) })
    await setOwnStack(database.db, bolaId, "2026-10-24", "Updated", new Date("2026-10-24T08:00:00Z"))
    clock.set("2026-10-24T13:00:00.000Z")
    await scheduledRun()
    expect(feeds.requestsTo(SFEED_B)).toBe(1)
  })

  it("scheduled:112 her own record and no feeds: completed with 0 feeds read, no request", async () => {
    await setOwnStack(database.db, bolaId)
    await scheduledRun()
    expect(http.started).toEqual([])
    const row = (await sql<{ outcome: string; feeds_read: number }>`select outcome, feeds_read from stack_post_run where candidate_id = ${bolaId}::uuid`.execute(database.db)).rows
    expect(row).toEqual([{ outcome: "completed", feeds_read: 0 }])
  })

  it("scheduled:119 nobody has her own record: no Stack posts request; every active Candidate skipped_unverified", async () => {
    await insertStackFeed(database.db, adaId, SFEED_A)
    await insertStackFeed(database.db, bolaId, SFEED_B)
    await scheduledRun()
    expect(http.started).toEqual([])
    for (const id of [adaId, bolaId, chidiId]) expect(await stackRuns(database.db, id)).toEqual(["skipped_unverified"])
  })

  it("migration:51 the Operator with her copied record is read with no action from her (completed, not skipped)", async () => {
    await setOwnStack(database.db, adaId, "2026-09-30", "Reviewed Google Alerts terms on 30 Sep.", new Date("2026-09-30T10:15:00Z"))
    await insertStackFeed(database.db, adaId, SFEED_A)
    await insertStackFeed(database.db, adaId, SFEED_B)
    feeds.on(SFEED_A, { kind: "body", body: feedOf("a", 1) })
    feeds.on(SFEED_B, { kind: "body", body: feedOf("b", 1) })
    clock.set("2026-10-24T13:00:00.000Z")
    await scheduledRun()
    expect([feeds.requestsTo(SFEED_A), feeds.requestsTo(SFEED_B)]).toEqual([1, 1])
    expect(await stackRuns(database.db, adaId)).toEqual(["completed"])
  })

  it("migration:121 an invitee's legacy feeds are kept and not read while she has no record", async () => {
    await setLegacy(database.db, true)
    await setOwnStack(database.db, adaId)
    await insertStackFeed(database.db, bolaId, SFEED_B)
    await insertStackFeed(database.db, bolaId, SFEED_C)
    await scheduledRun()
    expect(await countRows(database.db, "alert_feed", bolaId)).toBe(2)
    expect(feeds.requestsTo(SFEED_B) + feeds.requestsTo(SFEED_C)).toBe(0)
    expect(await stackRuns(database.db, bolaId)).toEqual(["skipped_unverified"])
  })

  it("migration:233 deleting the legacy row does not change the Operator's read", async () => {
    await setLegacy(database.db, true)
    await setOwnStack(database.db, adaId)
    await insertStackFeed(database.db, adaId, SFEED_A)
    feeds.on(SFEED_A, { kind: "body", body: feedOf("a", 1) })
    await setLegacy(database.db, false)
    await scheduledRun()
    expect(feeds.requestsTo(SFEED_A)).toBe(1)
  })

  it("migration:217 the scheduled read names no legacy table (runtime grant revoked: still read)", async () => {
    await setLegacy(database.db, true)
    await setOwnStack(database.db, bolaId)
    await insertStackFeed(database.db, bolaId, SFEED_B)
    feeds.on(SFEED_B, { kind: "body", body: feedOf("b", 1) })
    undo.push(await revokeRuntime(database.db, database.roles.runtime.name, "alert_feed_verification"))
    await scheduledRun()
    expect(feeds.requestsTo(SFEED_B)).toBe(1)
    expect(await stackRuns(database.db, bolaId)).toEqual(["completed"])
  })
})

describe("active Candidates only; pauses (scheduled:129, :144, :154, :163)", () => {
  it.each(["revoked", "deleting"] as const)("scheduled:129 Bola %s: no run row, no request; Ada is read", async (state) => {
    await setOwnStack(database.db, adaId)
    await setOwnStack(database.db, bolaId)
    await insertStackFeed(database.db, adaId, SFEED_A)
    await insertStackFeed(database.db, bolaId, SFEED_B)
    feeds.on(SFEED_A, { kind: "body", body: feedOf("a", 1) })
    feeds.on(SFEED_B, { kind: "body", body: feedOf("b", 1) })
    await database.db.updateTable("candidate").set({ state } as never).where("id", "=", bolaId).execute()
    const result = await scheduledRun()
    expect(feeds.requestsTo(SFEED_B)).toBe(0)
    expect(await stackRuns(database.db, bolaId)).toEqual([])
    expect(feeds.requestsTo(SFEED_A)).toBe(1)
    expect(result?.stack.find((e) => e.candidateId === bolaId)?.result).toBe("not_active")
  })

  it("scheduled:144 restored to active, she is read at the next run", async () => {
    await setOwnStack(database.db, bolaId)
    await insertStackFeed(database.db, bolaId, SFEED_B)
    feeds.on(SFEED_B, { kind: "body", body: feedOf("b", 1) })
    await database.db.updateTable("candidate").set({ state: "revoked" } as never).where("id", "=", bolaId).execute()
    await scheduledRun()
    expect(feeds.requestsTo(SFEED_B)).toBe(0)
    await database.db.updateTable("candidate").set({ state: "active" } as never).where("id", "=", bolaId).execute()
    clock.set("2026-10-24T13:00:00.000Z")
    await scheduledRun()
    expect(feeds.requestsTo(SFEED_B)).toBe(1)
  })

  it("scheduled:154 global pause: every active Candidate's run is skipped_global_pause before her record is checked; no request", async () => {
    await setOwnStack(database.db, adaId)
    await insertStackFeed(database.db, adaId, SFEED_A)
    await insertStackFeed(database.db, bolaId, SFEED_B)
    await database.db.updateTable("control_state").set({ global_paused: true }).execute()
    clock.set("2026-10-24T13:00:00.000Z")
    await scheduledRun()
    expect(http.started).toEqual([])
    expect(await stackRuns(database.db, adaId)).toEqual(["skipped_global_pause"])
    expect(await stackRuns(database.db, bolaId)).toEqual(["skipped_global_pause"])
  })

  it("scheduled:163 the cost-ceiling pause does not stop her read; no AI call, no spend", async () => {
    await setOwnStack(database.db, bolaId)
    await insertStackFeed(database.db, bolaId, SFEED_B)
    feeds.on(SFEED_B, { kind: "body", body: feedOf("b", 1) })
    await database.db.updateTable("control_state").set({ cost_paused: true }).execute()
    await scheduledRun()
    expect(feeds.requestsTo(SFEED_B)).toBe(1)
    expect(await countRows(database.db, "ai_call")).toBe(0)
    expect(await countRows(database.db, "spend_entry")).toBe(0)
  })
})

describe("failure isolation (scheduled:173, :188, :203, :211, :221, :230; AR-10)", () => {
  const three = async () => {
    const owners = [adaId, bolaId, chidiId] as const
    const urls = [SFEED_A, SFEED_B, SFEED_C] as const
    for (const [i, id] of owners.entries()) {
      await setOwnStack(database.db, id)
      await insertStackFeed(database.db, id, urls[i]!)
      feeds.on(urls[i]!, { kind: "body", body: feedOf(`f${i}`, 1, 2) })
    }
    return { owners, urls }
  }

  it.each([0, 1, 2])("scheduled:173 Candidate #%i fails before her first request; the other two are read and completed; the job does not throw", async (failing) => {
    const { owners, urls } = await three()
    undo.push(await failInsertsFor(database.db, "stack_post_run", owners[failing]!))
    const result = await worker.get(StackPostsJobs).runScheduled()
    for (const [i, id] of owners.entries()) {
      if (i === failing) {
        expect(feeds.requestsTo(urls[i]!)).toBe(0)
        expect((result as unknown as { stack: StackEntry[] }).stack.find((e) => e.candidateId === id)?.result).toBe("failed")
      } else {
        expect(feeds.requestsTo(urls[i]!), id).toBe(1)
        expect(await stackPosts(id)).toBe(2)
        expect(await stackRuns(database.db, id)).toEqual(["completed"])
      }
    }
  })

  const both = async () => {
    for (const id of [adaId, bolaId]) {
      await setOwnStack(database.db, id)
      await setHiringRecord(database.db, id)
    }
    await insertStackFeed(database.db, adaId, SFEED_A)
    await insertStackFeed(database.db, bolaId, SFEED_B)
    await insertHiringFeed(database.db, adaId, HFEED_A)
    await insertHiringFeed(database.db, bolaId, HFEED_B)
    for (const url of [SFEED_A, SFEED_B, HFEED_A, HFEED_B]) feeds.on(url, { kind: "body", body: feedOf("m", 1) })
  }

  it.each([
    ["ada's Stack posts read", "stack_post_run", "ada", [SFEED_B, HFEED_A, HFEED_B], [SFEED_A]],
    ["every Candidate's Stack posts read", "stack_post_run", null, [HFEED_A, HFEED_B], [SFEED_A, SFEED_B]],
    ["ada's Hiring read", "hiring_post_run", "ada", [SFEED_A, SFEED_B, HFEED_B], [HFEED_A]],
    ["every Candidate's Hiring read", "hiring_post_run", null, [SFEED_A, SFEED_B], [HFEED_A, HFEED_B]],
  ] as const)("scheduled:188 %s fails before its first request: the others are each read once", async (_name, table, who, read, unread) => {
    await both()
    undo.push(await failInsertsFor(database.db, table, who === "ada" ? adaId : null))
    await scheduledRun()
    for (const url of read) expect(feeds.requestsTo(url), url).toBe(1)
    for (const url of unread) expect(feeds.requestsTo(url), url).toBe(0)
  })

  it("scheduled:203 listing Candidates for the Stack posts loop fails: the Hiring read still runs; the log names the Stack posts failure; the job rethrows", async () => {
    await setHiringRecord(database.db, adaId)
    await insertHiringFeed(database.db, adaId, HFEED_A)
    feeds.on(HFEED_A, { kind: "body", body: feedOf("h", 1) })
    const jobs = worker.get(StackPostsJobs) as unknown as Record<string, unknown>
    // The tenant's Candidate list is shared by both loops; fail only its first call (the Stack posts loop runs first, OD-6).
    const tenant = jobs.tenant as { candidateIds: () => Promise<string[]> }
    const original = tenant.candidateIds.bind(tenant)
    let calls = 0
    tenant.candidateIds = async () => {
      calls += 1
      if (calls === 1) throw new Error("qa injected list failure")
      return original()
    }
    try {
      await expect(worker.get(StackPostsJobs).runScheduled()).rejects.toThrow()
    } finally {
      tenant.candidateIds = original
    }
    expect(feeds.requestsTo(HFEED_A)).toBe(1)
    expect(logs.some((l) => /Stack posts read/i.test(l) && /failed/i.test(l))).toBe(true)
  })

  it("scheduled:211 a failure after the request to SFEED_B is logged with her Candidate id; no full URL, no basis; the feed only by id and '222333'", async () => {
    await setOwnStack(database.db, bolaId, "2026-10-21", "Basis-marker-4f2e")
    const feedId = await insertStackFeed(database.db, bolaId, SFEED_B)
    feeds.on(SFEED_B, { kind: "body", body: feedOf("b", 1) })
    // The post insert (after the GET) raises for her only.
    undo.push(await failInsertsFor(database.db, "stack_post", bolaId))
    await scheduledRun()
    expect(feeds.requestsTo(SFEED_B)).toBe(1)
    const all = logs.join("\n")
    expect(all).not.toContain("Basis-marker-4f2e")
    expect(all).not.toContain(SFEED_B)
    const lines = logs.filter((l) => l.includes(feedId) || l.includes(bolaId))
    expect(lines.length).toBeGreaterThan(0)
    for (const l of logs.filter((l) => l.includes("222333"))) expect(l).toContain(feedId)
  })

  it("scheduled:211 a Candidate-level failure is logged as 'Stack posts read for Candidate <id> failed: …' (contract text)", async () => {
    await setOwnStack(database.db, bolaId)
    undo.push(await failInsertsFor(database.db, "stack_post_run", bolaId))
    await scheduledRun()
    expect(logs.some((l) => l.includes(`Stack posts read for Candidate ${bolaId} failed: `))).toBe(true)
  })

  it("scheduled:221 the same URL fails for Ada (HTTP 500 every attempt) and is valid for Bola: only Ada's feed is marked failing", async () => {
    await setOwnStack(database.db, adaId)
    await setOwnStack(database.db, bolaId)
    await insertStackFeed(database.db, adaId, SFEED_A)
    await insertStackFeed(database.db, bolaId, SFEED_A)
    await insertStackFeed(database.db, bolaId, SFEED_B)
    // Candidates run in id order; Ada's attempts are the first three to SFEED_A (first try + two retries).
    const adaFirst = adaId < bolaId
    feeds.on(SFEED_A, (attempt) => ((adaFirst ? attempt <= 3 : attempt > 1) ? { kind: "status", status: 500 } : { kind: "body", body: feedOf("a", 1) }))
    feeds.on(SFEED_B, { kind: "body", body: feedOf("b", 2) })
    await scheduledRun()
    expect(await feedState(adaId, SFEED_A)).toMatchObject({ last_failure_reason: "unexpected_response" })
    expect(await feedState(bolaId, SFEED_A)).toMatchObject({ last_failure_reason: null })
    expect(await feedState(bolaId, SFEED_B)).toMatchObject({ last_failure_reason: null })
    expect(await stackPosts(bolaId)).toBe(2)
  })

  it("scheduled:230 a Candidate whose read failed is read again at the next run", async () => {
    await setOwnStack(database.db, bolaId)
    await insertStackFeed(database.db, bolaId, SFEED_B)
    feeds.on(SFEED_B, { kind: "body", body: feedOf("b", 1) })
    const restore = await failInsertsFor(database.db, "stack_post_run", bolaId)
    await scheduledRun()
    await restore()
    expect(feeds.requestsTo(SFEED_B)).toBe(0)
    clock.set("2026-10-24T13:00:00.000Z")
    await scheduledRun()
    expect(feeds.requestsTo(SFEED_B)).toBe(1)
  })
})

describe("tenancy (scheduled:239, :249)", () => {
  it("scheduled:239 the same URL for Ada and Bola: two requests, each Candidate her own 2 posts and her own last-read time", async () => {
    await setOwnStack(database.db, adaId)
    await setOwnStack(database.db, bolaId)
    await insertStackFeed(database.db, adaId, SFEED_A)
    await insertStackFeed(database.db, bolaId, SFEED_A)
    feeds.on(SFEED_A, { kind: "body", body: feedOf("s", 1, 2) })
    await scheduledRun()
    expect(feeds.requestsTo(SFEED_A)).toBe(2)
    expect([await stackPosts(adaId), await stackPosts(bolaId)]).toEqual([2, 2])
    expect((await feedState(adaId, SFEED_A))?.last_read_at).toEqual(clock.now())
    expect((await feedState(bolaId, SFEED_A))?.last_read_at).toEqual(clock.now())
  })

  it("scheduled:249 every row written in Bola's run carries her id; a session scoped to her counts only her runs", async () => {
    for (const id of [adaId, bolaId]) await setOwnStack(database.db, id)
    await insertStackFeed(database.db, adaId, SFEED_A)
    await insertStackFeed(database.db, adaId, SFEED_C)
    await insertStackFeed(database.db, bolaId, SFEED_B)
    await insertStackFeed(database.db, bolaId, "https://www.google.com/alerts/feeds/01234567890123456789/7777777777777000111")
    for (const url of [SFEED_A, SFEED_B, SFEED_C, "https://www.google.com/alerts/feeds/01234567890123456789/7777777777777000111"]) feeds.on(url, { kind: "body", body: feedOf(new URL(url).pathname.slice(-6), 1) })
    await scheduledRun()
    const bolaPosts = (await sql<{ canonical_url: string; candidate_id: string }>`select canonical_url, candidate_id::text from stack_post where canonical_url like ${"%222333%"} or canonical_url like ${"%000111%"}`.execute(database.db)).rows
    expect(bolaPosts.length).toBe(2)
    for (const p of bolaPosts) expect(p.candidate_id).toBe(bolaId)
    const runtime = new pg.Client({ connectionString: database.url })
    await runtime.connect()
    try {
      await runtime.query("begin")
      // EPIC-0002 A2 (0022-candidate-binding): a Candidate scope is the setting AND the transaction's binding.
      await runtime.query("select set_config('eve.candidate_id', $1, true), public.bind_candidate($1::uuid)", [bolaId])
      expect((await runtime.query("select count(*)::int as n, count(*) filter (where candidate_id <> $1)::int as other from stack_post_run", [bolaId])).rows[0]).toEqual({ n: 1, other: 0 })
      await runtime.query("rollback")
    } finally {
      await runtime.end()
    }
  })
})

describe("outbound and AI unchanged (scheduled:258)", () => {
  it("scheduled:258 the only feed requests are the two feed paths; the google.com/url link is never followed; no AI, no spend", async () => {
    for (const id of [adaId, bolaId]) await setOwnStack(database.db, id)
    await insertStackFeed(database.db, adaId, SFEED_A)
    await insertStackFeed(database.db, bolaId, SFEED_B)
    feeds.on(SFEED_A, { kind: "body", body: feedOf("a", 1) })
    feeds.on(SFEED_B, { kind: "body", body: atomFeed([{ title: "x", link: googleRedirect("https://www.linkedin.com/posts/x"), content: "React" }]) })
    await scheduledRun()
    expect(feeds.requests.map((r) => r.path).sort()).toEqual([new URL(SFEED_A).pathname, new URL(SFEED_B).pathname].sort())
    expect(http.started.map((s) => new URL(s.url).hostname)).toEqual(["www.google.com", "www.google.com"])
    expect(await countRows(database.db, "ai_call")).toBe(0)
    expect(await countRows(database.db, "spend_entry")).toBe(0)
  })
})

describe("documentation (scheduled:268; AC 3.5)", () => {
  const source = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")

  it("no comment in the job or the reader says the Stack posts read is Operator-only or waits for invitees; the job says once per active Candidate", () => {
    for (const file of ["../src/worker/stack-posts-jobs.ts", "../src/stack-posts/stack-posts-reader.ts", "../src/stack-posts/stack-posts.repository.ts"]) {
      const text = source(file)
      expect(text, file).not.toMatch(/Stack posts read runs in the Operator'?s scope/i)
      expect(text, file).not.toMatch(/until invitees can register feeds/i)
      expect(text, file).not.toMatch(/Only the Operator writes it/i)
    }
    expect(source("../src/worker/stack-posts-jobs.ts")).toMatch(/once (for|per) each active Candidate|each active Candidate/i)
  })
})

describe("double fire through the scheduling path (scheduled:279; AR-11)", () => {
  it("two cron-path jobs for the 08:00 occurrence become one job; the worker's handler reads SFEED_B once and stores her entries once", async () => {
    await setOwnStack(database.db, bolaId)
    await insertStackFeed(database.db, bolaId, SFEED_B)
    feeds.on(SFEED_B, { kind: "body", body: feedOf("b", 1, 2) })
    // A separate pg-boss client (no supervision, no timekeeper) inserts what the timekeeper's send-it
    // handler sends for one occurrence: the schedule's singletonKey and the occurrence's 60 s slot.
    const boss = new PgBoss({ connectionString: database.url, migrate: false, schema: JOB_QUEUE_SCHEMA, supervise: false, schedule: false } as ConstructorParameters<typeof PgBoss>[0])
    await boss.start()
    try {
      const schedules = await boss.getSchedules(STACK_POSTS_READ_QUEUE)
      expect(schedules.map((s) => [s.cron, s.timezone])).toEqual([["0 2,8,14,20 * * *", "Africa/Lagos"]])
      const key = schedules[0]!.key
      const singletonKey = `${STACK_POSTS_READ_QUEUE.replaceAll("_", "\\_")}__${key}`
      const occurrence = { singletonKey, singletonSeconds: 60 }
      const first = await boss.send(STACK_POSTS_READ_QUEUE, null, occurrence)
      const second = await boss.send(STACK_POSTS_READ_QUEUE, null, occurrence)
      expect(first).not.toBeNull()
      expect(second).toBeNull()
      const jobs = await sql<{ n: number }>`select count(*)::int as n from ${sql.table(`${JOB_QUEUE_SCHEMA}.job`)} where name = ${STACK_POSTS_READ_QUEUE} and singleton_key = ${singletonKey}`.execute(database.db)
      expect(jobs.rows[0]!.n).toBe(1)
      // The worker's own boss.work handler picks the job up (polling interval 2 s by default).
      await until(async () => (await stackRuns(database.db, bolaId)).includes("completed"), 30_000)
      await until(async () => {
        const state = await sql<{ state: string }>`select state from ${sql.table(`${JOB_QUEUE_SCHEMA}.job`)} where id = ${first!}::uuid`.execute(database.db)
        return state.rows[0]?.state === "completed"
      }, 30_000)
    } finally {
      await boss.stop({ graceful: false })
    }
    expect(feeds.requestsTo(SFEED_B)).toBe(1)
    expect(await stackPosts(bolaId)).toBe(2)
    expect(await stackRuns(database.db, bolaId)).toEqual(["completed"])
  })

  it("the queue is still singleton with retries off (a second active job for the queue is refused)", async () => {
    const q = await sql<{ policy: string; retry_limit: number }>`select policy, retry_limit from ${sql.table(`${JOB_QUEUE_SCHEMA}.queue`)} where name = ${STACK_POSTS_READ_QUEUE}`.execute(database.db)
    expect(q.rows).toEqual([{ policy: "singleton", retry_limit: 0 }])
  })
})

describe("concurrency (scheduled:288, :297)", () => {
  it("scheduled:288 Bola records while the run is reading Ada's feed: her run is either skipped_unverified with no request or completed with one; the next run reads her once", async () => {
    await setOwnStack(database.db, adaId)
    await insertStackFeed(database.db, adaId, SFEED_A)
    await insertStackFeed(database.db, bolaId, SFEED_B)
    feeds.on(SFEED_A, { kind: "body", body: feedOf("a", 1) })
    feeds.on(SFEED_B, { kind: "body", body: feedOf("b", 1) })
    http.hold(SFEED_A)
    const run = scheduledRun()
    await until(() => http.started.some((s) => s.url === SFEED_A))
    await setOwnStack(database.db, bolaId)
    http.release(SFEED_A)
    await run
    const outcome = await stackRuns(database.db, bolaId)
    if (outcome[0] === "skipped_unverified") expect(feeds.requestsTo(SFEED_B)).toBe(0)
    else {
      expect(outcome).toEqual(["completed"])
      expect(feeds.requestsTo(SFEED_B)).toBe(1)
    }
    const before = feeds.requestsTo(SFEED_B)
    clock.set("2026-10-24T13:00:00.000Z")
    await scheduledRun()
    expect(feeds.requestsTo(SFEED_B) - before).toBe(1)
  })

  // FINDING (handoff F-1): Gherkin :297 says "no request to SFEED_C after its removal"; the contract keeps EPIC-0005
  // removal handling unchanged, which reads the feed list once and discards a removed feed's body (no retry, nothing
  // stored). This test asserts the contract's guarantee: at most the one first attempt, no retry, nothing stored.
  it("scheduled:297 a feed removed during her run is not retried and stores nothing (EPIC-0005 removal handling)", async () => {
    await setOwnStack(database.db, bolaId)
    await insertStackFeed(database.db, bolaId, SFEED_B, { createdAt: new Date("2026-10-20T08:00:00Z") })
    const c = await insertStackFeed(database.db, bolaId, SFEED_C, { createdAt: new Date("2026-10-20T09:00:00Z") })
    feeds.on(SFEED_B, { kind: "body", body: feedOf("b", 1) })
    feeds.on(SFEED_C, { kind: "body", body: feedOf("c", 1) })
    http.hold(SFEED_B)
    const run = scheduledRun()
    await until(() => http.started.some((s) => s.url === SFEED_B))
    await sql`delete from alert_feed where id = ${c}::uuid`.execute(database.db)
    http.release(SFEED_B)
    await run
    expect(feeds.requestsTo(SFEED_C)).toBeLessThanOrEqual(1)
    expect((await sql<{ n: number }>`select count(*)::int as n from stack_post where canonical_url like ${"%/c-1-%"}`.execute(database.db)).rows[0]!.n).toBe(0)
    expect((await sql<{ n: number }>`select count(*)::int as n from alert_feed where id = ${c}::uuid`.execute(database.db)).rows[0]!.n).toBe(0)
  })
})
