import { type INestApplicationContext, Logger, type LoggerService } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { type Kysely, sql } from "kysely"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { anthropicConfig } from "../src/config/env.js"
import { CandidateScope } from "../src/db/candidate-scope.js"
import { createDatabase } from "../src/db/create-database.js"
import type { Database } from "../src/db/schema.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { CLOCK } from "../src/shared/clock.js"
import { ALERT_FEED_HTTP } from "../src/stack-posts/alert-feed-http.provider.js"
import { type AlertFeedGetOptions, type AlertFeedHttp, createAlertFeedHttp } from "../src/stack-posts/alert-feed-http.js"
import { HiringPostsReader } from "../src/stack-posts/hiring-posts-reader.js"
import { StackPostsReader } from "../src/stack-posts/stack-posts-reader.js"
import { StackPostsRepository } from "../src/stack-posts/stack-posts.repository.js"
import { STACK_POSTS_READ_QUEUE, StackPostsJobs } from "../src/worker/stack-posts-jobs.js"
import { WorkerHeartbeat } from "../src/worker/worker-heartbeat.js"
import { WorkerModule } from "../src/worker/worker.module.js"
import { atomFeed, googleRedirect } from "./support/alert-feed-fixtures.js"
import { FakeFeedServer } from "./support/fake-feed-server.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { failInsertsFor } from "./support/qa-hiring-feeds.js"
import {
  HFEED_A,
  HFEED_B,
  SFEED_A,
  SFEED_B,
  SFEED_C,
  clearFeeds,
  insertCandidate,
  insertStackFeed,
  insertStackPosts,
  recordHiring,
  recordStack,
  revokeRuntime,
  setLegacy,
  stackPostCount,
  stackRuns,
} from "./support/stack-feed-fixtures.js"
import { migratedStorageRoot } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0008 scheduled Stack posts reads per Candidate (api-contract.md v1.22.0 "Scheduled
 * Stack posts read, per Candidate"; architecture AR-6, AR-10, AR-11;
 * stack-feed-scheduled-reads.feature; stack-feed-isolation.feature:123, :134;
 * stack-feed-migration.feature:53, :104, :122, :183, :233, :319 (API half)). The real worker
 * module (`StackPostsJobs.runScheduled`) against real Postgres through the runtime role, with
 * a local feed server standing in for Google. Three Candidates: ada (the Operator), bola and
 * chidi (invited). The feed client is wrapped so tests can see the scope of each request,
 * count requests in flight, and make one Candidate's read fail.
 */
let database: TestDatabase
let runtime: Kysely<Database>
let feeds: FakeFeedServer
let worker: INestApplicationContext
let jobs: StackPostsJobs
let bolaId: string
let chidiId: string
const clock = new TestClock("2026-10-28T07:00:00.000Z")
const logs: string[] = []
const line = (message: unknown, ...rest: unknown[]) => void logs.push([message, ...rest].map(String).join(" "))
const capture: LoggerService = { log: line, warn: line, error: line, debug: line, verbose: line }

/** Each request with the Candidate scope it ran in, and a hook that can delay or fail it. */
const requests: { url: string; scope: string | undefined }[] = []
let inFlight = 0
let maxInFlight = 0
let beforeGet: (url: string, scope: string | undefined) => Promise<void> = async () => undefined
let realHttp: AlertFeedHttp
const http: AlertFeedHttp = {
  async get(url: string, options: AlertFeedGetOptions) {
    const scope = CandidateScope.current()
    requests.push({ url, scope })
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    try {
      await beforeGet(url, scope)
      return await realHttp.get(url, options)
    } finally {
      inFlight -= 1
    }
  },
}

const post = (n: string) => `https://www.linkedin.com/posts/e8-read-${n}`
const feedOf = (...targets: string[]) => atomFeed(targets.map((target) => ({ title: "React in production", link: googleRedirect(target), content: "React and TypeScript" })))
const requestsTo = (url: string) => requests.filter((request) => request.url === url)

beforeAll(async () => {
  Logger.overrideLogger(capture)
  database = await startMigratedDatabase()
  runtime = createDatabase(database.url)
  feeds = await FakeFeedServer.start()
  realHttp = createAlertFeedHttp({ testOrigin: feeds.origin, timeoutMs: 300, sleep: async () => undefined })
  bolaId = await insertCandidate(database.db, "bola@example.com")
  chidiId = await insertCandidate(database.db, "chidi@example.com")
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
  jobs = worker.get(StackPostsJobs)
})

beforeEach(async () => {
  clock.set("2026-10-28T07:00:00.000Z")
  feeds.reset()
  requests.length = 0
  inFlight = 0
  maxInFlight = 0
  beforeGet = async () => undefined
  logs.length = 0
  Logger.overrideLogger(capture)
  await clearFeeds(database.db)
  await database.db.updateTable("candidate").set({ state: "active" }).where("id", "in", [bolaId, chidiId]).execute()
  await database.db.updateTable("job_criteria").set({ frameworks: ["React"], technologies: ["TypeScript"] }).execute()
})

afterEach(() => {
  // Logs carry feed ids and masks, never a full feed URL.
  expect(logs.join("\n")).not.toMatch(/alerts\/feeds\/01234567890123456789\//)
})

afterAll(async () => {
  await worker?.close()
  await feeds?.close()
  await runtime?.destroy()
  await database?.stop()
  Logger.overrideLogger(false)
})

const ADA = () => database.operatorId
const run = () => jobs.runScheduled()
const stackOf = (result: Awaited<ReturnType<StackPostsJobs["runScheduled"]>>, id: string) => result.stack.find((entry) => entry.candidateId === id)?.result

describe("every active Candidate is read on her own record (SFS:26, :36, :44, :51)", () => {
  it("SFS:26, ISO:134 ada's and bola's feeds are read in one run, each into her own posts and her own completed run", async () => {
    await recordStack(database.db, ADA())
    await recordStack(database.db, bolaId)
    await insertStackFeed(database.db, ADA(), SFEED_A)
    await insertStackFeed(database.db, bolaId, SFEED_B)
    feeds.on(SFEED_A, { kind: "body", body: feedOf(post("a1"), post("a2")) })
    feeds.on(SFEED_B, { kind: "body", body: feedOf(post("b1"), post("b2"), post("b3")) })
    const result = await run()
    expect([requestsTo(SFEED_A).length, requestsTo(SFEED_B).length]).toEqual([1, 1])
    expect(requestsTo(SFEED_A).map((request) => request.scope)).toEqual([ADA()])
    expect(requestsTo(SFEED_B).map((request) => request.scope)).toEqual([bolaId])
    expect([await stackPostCount(database.db, ADA()), await stackPostCount(database.db, bolaId)]).toEqual([2, 3])
    expect(await stackRuns(database.db, ADA())).toEqual(["completed"])
    expect(await stackRuns(database.db, bolaId)).toEqual(["completed"])
    expect(stackOf(result, bolaId)).toMatchObject({ outcome: "completed", feedsRead: 1, postsStored: 3 })
  })

  it("SFS:36 four runs (02:00, 08:00, 14:00, 20:00 WAT) give one GET per feed per run", async () => {
    await recordStack(database.db, ADA())
    await recordStack(database.db, bolaId)
    await insertStackFeed(database.db, ADA(), SFEED_A)
    await insertStackFeed(database.db, bolaId, SFEED_B)
    await insertStackFeed(database.db, bolaId, SFEED_C)
    for (const url of [SFEED_A, SFEED_B, SFEED_C]) feeds.on(url, { kind: "body", body: feedOf() })
    for (const at of ["2026-10-28T01:00:00Z", "2026-10-28T07:00:00Z", "2026-10-28T13:00:00Z", "2026-10-28T19:00:00Z"]) {
      clock.set(at)
      await run()
    }
    expect([SFEED_A, SFEED_B, SFEED_C].map((url) => requestsTo(url).length)).toEqual([4, 4, 4])
  })

  it("SFS:44 Candidates' reads run one after another: never two feed requests in flight", async () => {
    for (const [id, url] of [
      [ADA(), SFEED_A],
      [bolaId, SFEED_B],
      [chidiId, SFEED_C],
    ] as const) {
      await recordStack(database.db, id)
      await insertStackFeed(database.db, id, url)
      feeds.on(url, { kind: "body", body: feedOf() })
    }
    beforeGet = () => new Promise((resolve) => setTimeout(resolve, 150))
    await run()
    expect(requests).toHaveLength(3)
    expect(maxInFlight).toBe(1)
  })

  it("SFS:51 her run starts before her first request, reads each feed once, applies retention to 2,000 and finishes completed", async () => {
    await recordStack(database.db, bolaId)
    await insertStackFeed(database.db, bolaId, SFEED_B)
    await insertStackFeed(database.db, bolaId, SFEED_C)
    feeds.on(SFEED_B, { kind: "body", body: feedOf() })
    feeds.on(SFEED_C, { kind: "body", body: feedOf() })
    await insertStackPosts(database.db, bolaId, 2005, { firstSeen: new Date("2026-10-27T07:00:00Z") })
    let runRowAtFirstRequest: string[] | null = null
    beforeGet = async (_url, scope) => {
      if (scope === bolaId && runRowAtFirstRequest === null) runRowAtFirstRequest = await stackRuns(database.db, bolaId)
    }
    const result = await run()
    expect(runRowAtFirstRequest).toEqual(["running"])
    expect([requestsTo(SFEED_B).length, requestsTo(SFEED_C).length]).toEqual([1, 1])
    expect(await stackPostCount(database.db, bolaId)).toBe(2000)
    expect(stackOf(result, bolaId)).toMatchObject({ outcome: "completed", feedsRead: 2, postsDeleted: 5 })
  })
})

describe("only her own record lets Eve read her feeds (SFS:63, :72, :88, :112, :119; ISO:123)", () => {
  it("SFS:63 bola without her own record is skipped_unverified with no request; ada is read", async () => {
    await insertStackFeed(database.db, bolaId, SFEED_B)
    await recordStack(database.db, ADA())
    await insertStackFeed(database.db, ADA(), SFEED_A)
    feeds.on(SFEED_A, { kind: "body", body: feedOf() })
    await run()
    expect(requestsTo(SFEED_B)).toEqual([])
    expect(await stackRuns(database.db, bolaId)).toEqual(["skipped_unverified"])
    expect(requestsTo(SFEED_A)).toHaveLength(1)
  })

  it.each([
    ["ada (the Operator) has her own record", async () => recordStack(database.db, ADA())],
    ["chidi has his own record", async () => recordStack(database.db, chidiId)],
    ["bola has her own Hiring record", async () => recordHiring(database.db, bolaId)],
    ["the legacy shared record exists", async () => setLegacy(database.db as never, true)],
  ])("SFS:72 %s: bola's feed is not read and her run is skipped_unverified", async (_name, arrange) => {
    await insertStackFeed(database.db, bolaId, SFEED_B)
    feeds.on(SFEED_B, { kind: "body", body: feedOf(post("x")) })
    await arrange()
    await run()
    expect(requestsTo(SFEED_B)).toEqual([])
    expect(await stackRuns(database.db, bolaId)).toEqual(["skipped_unverified"])
    expect(await stackPostCount(database.db, bolaId)).toBe(0)
  })

  it("SFS:88 the Operator's feeds are not read on the legacy shared record alone", async () => {
    await setLegacy(database.db as never, true)
    await insertStackFeed(database.db, ADA(), SFEED_A)
    await run()
    expect(requestsTo(SFEED_A)).toEqual([])
    expect(await stackRuns(database.db, ADA())).toEqual(["skipped_unverified"])
  })

  it("SFS:112 her own record and no feeds: a completed run with 0 feeds and no request", async () => {
    await recordStack(database.db, bolaId)
    const result = await run()
    expect(stackOf(result, bolaId)).toMatchObject({ outcome: "completed", feedsRead: 0 })
    expect(requests.filter((request) => request.scope === bolaId)).toEqual([])
  })

  it("SFS:119 no Candidate has her own record: no request, every active Candidate's run is skipped_unverified", async () => {
    await insertStackFeed(database.db, ADA(), SFEED_A)
    await insertStackFeed(database.db, bolaId, SFEED_B)
    await run()
    expect(requests).toEqual([])
    for (const id of [ADA(), bolaId, chidiId]) expect(await stackRuns(database.db, id)).toEqual(["skipped_unverified"])
  })

  it("ISO:123 ada records and bola is still not read on ada's record", async () => {
    await recordStack(database.db, ADA())
    await insertStackFeed(database.db, bolaId, SFEED_B)
    await run()
    expect(requestsTo(SFEED_B)).toEqual([])
    expect(await stackRuns(database.db, bolaId)).toEqual(["skipped_unverified"])
  })
})

describe("retention runs when her read is skipped (CR-E8-02, owner decision 2026-10-29; C-SP-POSTS-UNVERIFIED-NOTE)", () => {
  const AGED = new Date("2026-07-25T07:00:00Z") // 95 days before the 2026-10-28 08:00 WAT run
  const RECENT = new Date("2026-10-27T07:00:00Z")
  const runRow = async (candidateId: string, startedAt: Date) =>
    sql`insert into stack_post_run (candidate_id, id, started_at, finished_at, outcome) values (${candidateId}::uuid, gen_random_uuid(), ${startedAt}, ${startedAt}, 'completed')`.execute(database.db)
  const postsDeleted = async (candidateId: string, outcome: "skipped_unverified" | "skipped_global_pause") =>
    (await database.db.selectFrom("stack_post_run").select("posts_deleted").where("candidate_id", "=", candidateId).where("outcome", "=", outcome).execute()).map((row) => row.posts_deleted)
  const oldest = async (candidateId: string) =>
    (await database.db.selectFrom("stack_post").select((eb) => eb.fn.min("first_seen_at").as("first")).where("candidate_id", "=", candidateId).executeTakeFirstOrThrow()).first

  it("an invitee without a record: posts older than 90 days and beyond the newest 2,000 are pruned, with no request", async () => {
    await insertStackFeed(database.db, bolaId, SFEED_B)
    feeds.on(SFEED_B, { kind: "body", body: feedOf(post("never")) })
    await insertStackPosts(database.db, bolaId, 3, { firstSeen: AGED })
    await insertStackPosts(database.db, bolaId, 2004, { firstSeen: RECENT })
    await runRow(bolaId, AGED)
    const result = await run()
    expect(requestsTo(SFEED_B)).toEqual([])
    expect(stackOf(result, bolaId)).toMatchObject({ outcome: "skipped_unverified", feedsRead: 0, postsStored: 0, postsDeleted: 7 })
    expect(await stackPostCount(database.db, bolaId)).toBe(2000)
    expect(await oldest(bolaId)).toEqual(RECENT)
    expect(await stackRuns(database.db, bolaId)).toEqual(["skipped_unverified"])
    expect(await postsDeleted(bolaId, "skipped_unverified")).toEqual([7])
  })

  it("an invitee without a record and only recent posts keeps all of them", async () => {
    await insertStackPosts(database.db, bolaId, 12, { firstSeen: RECENT })
    const result = await run()
    expect(stackOf(result, bolaId)).toMatchObject({ outcome: "skipped_unverified", postsDeleted: 0 })
    expect(await stackPostCount(database.db, bolaId)).toBe(12)
  })

  it("retention stays per Candidate: bola's skipped run prunes only her own posts", async () => {
    await database.db.updateTable("candidate").set({ state: "revoked" }).where("id", "=", chidiId).execute()
    await insertStackPosts(database.db, chidiId, 2, { firstSeen: AGED })
    await insertStackPosts(database.db, bolaId, 2, { firstSeen: AGED })
    await run()
    expect(await stackPostCount(database.db, bolaId)).toBe(0)
    expect(await stackPostCount(database.db, chidiId)).toBe(2)
  })

  it("during the global pause retention still runs for every active Candidate (housekeeping, no request)", async () => {
    await database.db.updateTable("control_state").set({ global_paused: true }).execute()
    await recordStack(database.db, ADA())
    await insertStackFeed(database.db, ADA(), SFEED_A)
    await insertStackPosts(database.db, ADA(), 2, { firstSeen: AGED })
    await insertStackPosts(database.db, ADA(), 1, { firstSeen: RECENT })
    await insertStackPosts(database.db, bolaId, 4, { firstSeen: AGED })
    await runRow(bolaId, AGED)
    const result = await run()
    expect(requests).toEqual([])
    expect(stackOf(result, ADA())).toMatchObject({ outcome: "skipped_global_pause", postsDeleted: 2 })
    expect(stackOf(result, bolaId)).toMatchObject({ outcome: "skipped_global_pause", postsDeleted: 4 })
    expect([await stackPostCount(database.db, ADA()), await stackPostCount(database.db, bolaId)]).toEqual([1, 0])
    expect(await stackRuns(database.db, bolaId)).toEqual(["skipped_global_pause"])
    expect(await postsDeleted(ADA(), "skipped_global_pause")).toEqual([2])
  })

  it("a Candidate who is not active keeps her posts and gets no run row (SFS:129 unchanged)", async () => {
    await database.db.updateTable("candidate").set({ state: "revoked" }).where("id", "=", bolaId).execute()
    await insertStackPosts(database.db, bolaId, 2, { firstSeen: AGED })
    expect(stackOf(await run(), bolaId)).toBe("not_active")
    expect(await stackPostCount(database.db, bolaId)).toBe(2)
    expect(await stackRuns(database.db, bolaId)).toEqual([])
  })
})

describe("records saved or updated between runs (SFS:96, :105, :288; MIG:104, :183)", () => {
  it("SFS:96, MIG:183 her feed is read from the first run after she records, not before", async () => {
    await insertStackFeed(database.db, bolaId, SFEED_B)
    feeds.on(SFEED_B, { kind: "body", body: feedOf(post("b1")) })
    await run()
    expect(requestsTo(SFEED_B)).toEqual([])
    clock.set("2026-10-28T08:00:00Z")
    await recordStack(database.db, bolaId)
    expect(requestsTo(SFEED_B)).toEqual([])
    clock.set("2026-10-28T13:00:00Z")
    await run()
    expect(requestsTo(SFEED_B)).toHaveLength(1)
    expect(await stackPostCount(database.db, bolaId)).toBe(1)
  })

  it("MIG:104 an Operator with no copied record is skipped until she records her own check", async () => {
    await insertStackFeed(database.db, ADA(), SFEED_A)
    feeds.on(SFEED_A, { kind: "body", body: feedOf() })
    await run()
    expect(requestsTo(SFEED_A)).toEqual([])
    expect(await stackRuns(database.db, ADA())).toEqual(["skipped_unverified"])
    await recordStack(database.db, ADA())
    await run()
    expect(requestsTo(SFEED_A)).toHaveLength(1)
  })

  it("SFS:105 updating her record keeps her feed read on schedule", async () => {
    await recordStack(database.db, bolaId, { verifiedOn: "2026-10-15" })
    await insertStackFeed(database.db, bolaId, SFEED_B)
    feeds.on(SFEED_B, { kind: "body", body: feedOf() })
    await recordStack(database.db, bolaId, { verifiedOn: "2026-10-27" })
    await run()
    expect(requestsTo(SFEED_B)).toHaveLength(1)
  })

  it("SFS:288 a record saved while the run reads another Candidate takes effect in this run or the next, never half", async () => {
    await recordStack(database.db, ADA())
    await insertStackFeed(database.db, ADA(), SFEED_A)
    await insertStackFeed(database.db, bolaId, SFEED_B)
    feeds.on(SFEED_A, { kind: "body", body: feedOf() })
    feeds.on(SFEED_B, { kind: "body", body: feedOf() })
    beforeGet = async (url) => {
      if (url === SFEED_A) await recordStack(database.db, bolaId)
    }
    const first = await run()
    const outcome = (stackOf(first, bolaId) as { outcome: string }).outcome
    expect(["skipped_unverified", "completed"]).toContain(outcome)
    expect(requestsTo(SFEED_B)).toHaveLength(outcome === "completed" ? 1 : 0)
    const before = requestsTo(SFEED_B).length
    beforeGet = async () => undefined
    await run()
    expect(requestsTo(SFEED_B).length - before).toBe(1)
  })
})

describe("state and pauses (SFS:129, :144, :154, :163)", () => {
  it.each(["revoked", "deleting"] as const)("SFS:129 a %s Candidate is not_active: no run row, no request; ada is read", async (state) => {
    await recordStack(database.db, bolaId)
    await insertStackFeed(database.db, bolaId, SFEED_B)
    await recordStack(database.db, ADA())
    await insertStackFeed(database.db, ADA(), SFEED_A)
    feeds.on(SFEED_A, { kind: "body", body: feedOf() })
    await database.db.updateTable("candidate").set({ state }).where("id", "=", bolaId).execute()
    const result = await run()
    expect(stackOf(result, bolaId)).toBe("not_active")
    expect(requestsTo(SFEED_B)).toEqual([])
    expect(await stackRuns(database.db, bolaId)).toEqual([])
    expect(requestsTo(SFEED_A)).toHaveLength(1)
  })

  it("SFS:144 a Candidate restored to active is read again at the next run", async () => {
    await recordStack(database.db, bolaId)
    await insertStackFeed(database.db, bolaId, SFEED_B)
    feeds.on(SFEED_B, { kind: "body", body: feedOf() })
    await database.db.updateTable("candidate").set({ state: "revoked" }).where("id", "=", bolaId).execute()
    await run()
    expect(requestsTo(SFEED_B)).toEqual([])
    await database.db.updateTable("candidate").set({ state: "active" }).where("id", "=", bolaId).execute()
    clock.set("2026-10-28T13:00:00Z")
    await run()
    expect(requestsTo(SFEED_B)).toHaveLength(1)
  })

  it("SFS:154 during the global pause each active Candidate's run is skipped_global_pause before her record is checked", async () => {
    await database.db.updateTable("control_state").set({ global_paused: true }).execute()
    await recordStack(database.db, ADA())
    await insertStackFeed(database.db, ADA(), SFEED_A)
    await insertStackFeed(database.db, bolaId, SFEED_B)
    await run()
    expect(requests).toEqual([])
    expect(await stackRuns(database.db, ADA())).toEqual(["skipped_global_pause"])
    expect(await stackRuns(database.db, bolaId)).toEqual(["skipped_global_pause"])
  })

  it("SFS:163 a cost-ceiling pause does not stop her read; no AI call, no spend", async () => {
    await database.db.updateTable("control_state").set({ cost_paused: true }).execute()
    await recordStack(database.db, bolaId)
    await insertStackFeed(database.db, bolaId, SFEED_B)
    feeds.on(SFEED_B, { kind: "body", body: feedOf(post("c")) })
    await run()
    expect(requestsTo(SFEED_B)).toHaveLength(1)
    expect(await database.db.selectFrom("ai_call").select("id").execute()).toEqual([])
    expect(await database.db.selectFrom("spend_entry").select("id").execute()).toEqual([])
  })
})

describe("failure isolation (SFS:173, :188, :203, :211, :221, :230; AR-10)", () => {
  async function threeCandidates(): Promise<void> {
    for (const [id, url] of [
      [ADA(), SFEED_A],
      [bolaId, SFEED_B],
      [chidiId, SFEED_C],
    ] as const) {
      await recordStack(database.db, id)
      await insertStackFeed(database.db, id, url)
      feeds.on(url, { kind: "body", body: feedOf(post(url.slice(-6))) })
    }
  }

  it.each([
    ["ada", () => ADA(), [SFEED_B, SFEED_C]],
    ["bola", () => bolaId, [SFEED_A, SFEED_C]],
    ["chidi", () => chidiId, [SFEED_A, SFEED_B]],
  ])("SFS:173 %s's read fails before its first request; the other two are read and completed; the run resolves", async (_who, failing, read) => {
    await threeCandidates()
    const undo = await failInsertsFor(database.db, "stack_post_run", failing())
    let result
    try {
      result = await run()
    } finally {
      await undo()
    }
    expect(stackOf(result, failing())).toBe("failed")
    for (const url of read) expect(requestsTo(url)).toHaveLength(1)
    const others = [ADA(), bolaId, chidiId].filter((id) => id !== failing())
    for (const id of others) {
      expect(await stackRuns(database.db, id)).toEqual(["completed"])
      expect(await stackPostCount(database.db, id)).toBe(1)
    }
  })

  async function bothLists(): Promise<void> {
    for (const [id, stack, hiring] of [
      [ADA(), SFEED_A, HFEED_A],
      [bolaId, SFEED_B, HFEED_B],
    ] as const) {
      await recordStack(database.db, id)
      await recordHiring(database.db, id)
      await insertStackFeed(database.db, id, stack)
      await database.db.insertInto("hiring_alert_feed").values({ candidate_id: id, id: crypto.randomUUID(), url: hiring, label: null, created_at: clock.now(), last_read_at: null, last_failure_reason: null, last_failed_at: null }).execute()
      for (const url of [stack, hiring]) feeds.on(url, { kind: "body", body: feedOf() })
    }
  }

  it.each([
    ["ada's Stack posts read", async () => [await failInsertsFor(database.db, "stack_post_run", ADA())], [SFEED_B, HFEED_A, HFEED_B]],
    ["every Candidate's Stack posts read", async () => [await failInsertsFor(database.db, "stack_post_run", ADA()), await failInsertsFor(database.db, "stack_post_run", bolaId)], [HFEED_A, HFEED_B]],
    ["ada's Hiring read", async () => [await failInsertsFor(database.db, "hiring_post_run", ADA())], [SFEED_A, SFEED_B, HFEED_B]],
    ["every Candidate's Hiring read", async () => [await failInsertsFor(database.db, "hiring_post_run", ADA()), await failInsertsFor(database.db, "hiring_post_run", bolaId)], [SFEED_A, SFEED_B]],
  ])("SFS:188 %s fails; the other reads each make exactly 1 request and the run resolves", async (_name, arrange, read) => {
    await bothLists()
    const undo = await arrange()
    try {
      await run()
    } finally {
      for (const restore of undo) await restore()
    }
    for (const url of read) expect(requestsTo(url), url).toHaveLength(1)
  })

  it("SFS:203 listing Candidates for the Stack posts loop fails: the Hiring reads still run, the failure is logged, the job fails", async () => {
    await recordHiring(database.db, ADA())
    await database.db.insertInto("hiring_alert_feed").values({ candidate_id: ADA(), id: crypto.randomUUID(), url: HFEED_A, label: null, created_at: clock.now(), last_read_at: null, last_failure_reason: null, last_failed_at: null }).execute()
    feeds.on(HFEED_A, { kind: "body", body: feedOf() })
    const tenant = worker.get(TenantDatabase)
    const original = tenant.eachCandidate.bind(tenant)
    let calls = 0
    tenant.eachCandidate = (async (work: (id: string) => Promise<unknown>) => {
      if (calls++ === 0) throw new Error("candidate list query failed")
      return original(work)
    }) as typeof tenant.eachCandidate
    try {
      await expect(run()).rejects.toThrow("candidate list query failed")
    } finally {
      tenant.eachCandidate = original
    }
    expect(requestsTo(HFEED_A)).toHaveLength(1)
    expect(logs.join("\n")).toMatch(/Stack posts reads failed: Error at /)
  })

  it("SFS:211 a failed read is logged with her Candidate id and a safe summary, never the feed URL or her basis", async () => {
    await recordStack(database.db, bolaId, { basis: "Basis-marker-4f2e" })
    await insertStackFeed(database.db, bolaId, SFEED_B)
    feeds.on(SFEED_B, { kind: "body", body: feedOf(post("b")) })
    const reader = worker.get(StackPostsReader)
    const repository = (reader as unknown as { repository: StackPostsRepository }).repository
    const original = repository.applyRetention.bind(repository)
    repository.applyRetention = async () => {
      throw new Error(`retention failed for ${SFEED_B} Basis-marker-4f2e`)
    }
    try {
      const result = await run()
      expect(stackOf(result, bolaId)).toBe("failed")
    } finally {
      repository.applyRetention = original
    }
    expect(requestsTo(SFEED_B)).toHaveLength(1)
    const all = logs.join("\n")
    expect(all).toContain(`Stack posts read for Candidate ${bolaId} failed: Error at `)
    // SEC-E8-05: the job resolves, so the run also logs the counted alert event (no Candidate id in that line).
    const event = logs.find((entry) => entry.includes("event=scheduled_read_candidate_failures"))
    expect(event).toMatch(/^Scheduled feed read finished with failed Candidates: event=scheduled_read_candidate_failures stack_failed=[1-9]\d* hiring_failed=0 candidates=\d+/)
    expect(event).not.toContain(bolaId)
    expect(all).not.toContain("1111111111111222333")
    expect(all).not.toContain("Basis-marker-4f2e")
  })

  it("SFS:221 a feed failing for ada is marked failing for her only; bola's copy of the same URL and her other feed are read", async () => {
    await recordStack(database.db, ADA())
    await recordStack(database.db, bolaId)
    const adaFeed = await insertStackFeed(database.db, ADA(), SFEED_A)
    const bolaFeed = await insertStackFeed(database.db, bolaId, SFEED_A)
    await insertStackFeed(database.db, bolaId, SFEED_B)
    feeds.on(SFEED_A, { kind: "body", body: feedOf(post("shared")) })
    feeds.on(SFEED_B, { kind: "body", body: feedOf(post("b-only")) })
    beforeGet = async (url, scope) => {
      if (url === SFEED_A && scope === ADA()) feeds.on(SFEED_A, { kind: "status", status: 500 })
      if (url === SFEED_A && scope === bolaId) feeds.on(SFEED_A, { kind: "body", body: feedOf(post("shared")) })
    }
    await run()
    const state = async (id: string) => (await database.db.selectFrom("alert_feed").select(["last_failure_reason"]).where("id", "=", id).executeTakeFirstOrThrow()).last_failure_reason
    expect(await state(adaFeed)).toBe("unexpected_response")
    expect(await state(bolaFeed)).toBeNull()
    expect(await stackPostCount(database.db, bolaId)).toBe(2)
    expect(await stackPostCount(database.db, ADA())).toBe(0)
  })

  it("SFS:230 a Candidate whose read failed is read again at the next run", async () => {
    await recordStack(database.db, bolaId)
    await insertStackFeed(database.db, bolaId, SFEED_B)
    feeds.on(SFEED_B, { kind: "body", body: feedOf() })
    const undo = await failInsertsFor(database.db, "stack_post_run", bolaId)
    try {
      expect(stackOf(await run(), bolaId)).toBe("failed")
    } finally {
      await undo()
    }
    clock.set("2026-10-28T13:00:00Z")
    expect(stackOf(await run(), bolaId)).toMatchObject({ outcome: "completed" })
    expect(requestsTo(SFEED_B)).toHaveLength(1)
  })
})

describe("per-Candidate scope (SFS:239, :249, :258)", () => {
  it("SFS:239 the same URL registered by two Candidates is read once for each, into separate posts and last-read times", async () => {
    await recordStack(database.db, ADA())
    await recordStack(database.db, bolaId)
    const a = await insertStackFeed(database.db, ADA(), SFEED_A)
    const b = await insertStackFeed(database.db, bolaId, SFEED_A)
    feeds.on(SFEED_A, { kind: "body", body: feedOf(post("s1"), post("s2")) })
    clock.set("2026-10-28T07:00:00Z")
    // Candidates run in id order; each read is stamped with a time of its own.
    beforeGet = async (_url, scope) => {
      clock.set(scope === bolaId ? "2026-10-28T07:00:05Z" : "2026-10-28T07:00:01Z")
    }
    await run()
    expect(requestsTo(SFEED_A).map((request) => request.scope).sort()).toEqual([ADA(), bolaId].sort())
    expect([await stackPostCount(database.db, ADA()), await stackPostCount(database.db, bolaId)]).toEqual([2, 2])
    const lastRead = async (id: string) => (await database.db.selectFrom("alert_feed").select("last_read_at").where("id", "=", id).executeTakeFirstOrThrow()).last_read_at
    expect([await lastRead(a), await lastRead(b)]).toEqual([new Date("2026-10-28T07:00:01Z"), new Date("2026-10-28T07:00:05Z")])
  })

  it("SFS:249 every row written in bola's run carries her id; a session scoped to her counts only her runs", async () => {
    await recordStack(database.db, ADA())
    await recordStack(database.db, bolaId)
    for (const [id, urls] of [
      [ADA(), [SFEED_A]],
      [bolaId, [SFEED_B, SFEED_C]],
    ] as const) {
      for (const url of urls) {
        await insertStackFeed(database.db, id, url)
        feeds.on(url, { kind: "body", body: feedOf(post(`${id.slice(0, 4)}-${url.slice(-6)}`)) })
      }
    }
    await run()
    expect(await stackPostCount(database.db, bolaId)).toBe(2)
    const theirs = await new TenantDatabase(runtime).forCandidate(bolaId, async (trx) => ({
      runs: await sql<{ candidate_id: string }>`select candidate_id::text from stack_post_run`.execute(trx),
      posts: await sql<{ candidate_id: string }>`select candidate_id::text from stack_post`.execute(trx),
    }))
    expect(theirs.runs.rows.map((row) => row.candidate_id)).toEqual([bolaId])
    expect(new Set(theirs.posts.rows.map((row) => row.candidate_id))).toEqual(new Set([bolaId]))
  })

  it("SFS:258 reads request only the two feed URLs on www.google.com; no LinkedIn or results-page request", async () => {
    await recordStack(database.db, ADA())
    await recordStack(database.db, bolaId)
    await insertStackFeed(database.db, ADA(), SFEED_A)
    await insertStackFeed(database.db, bolaId, SFEED_B)
    feeds.on(SFEED_A, { kind: "body", body: feedOf() })
    feeds.on(SFEED_B, { kind: "body", body: atomFeed([{ title: "x", link: "https://www.google.com/url?q=https://www.linkedin.com/posts/x", content: "React" }]) })
    await run()
    expect(requests.map((request) => request.url).sort()).toEqual([SFEED_A, SFEED_B].sort())
    expect(feeds.requests.map((request) => request.path).sort()).toEqual([new URL(SFEED_A).pathname, new URL(SFEED_B).pathname].sort())
  })
})

describe("removal mid-run, comments, duplicate firing, legacy row (SFS:296, :270, :279; MIG:53, :122, :233, :319)", () => {
  it("SFS:296 a feed removed during her run is not read after its removal", async () => {
    await recordStack(database.db, bolaId)
    await insertStackFeed(database.db, bolaId, SFEED_B, { createdAt: new Date("2026-10-20T08:00:00Z") })
    const c = await insertStackFeed(database.db, bolaId, SFEED_C, { createdAt: new Date("2026-10-20T09:00:00Z") })
    feeds.on(SFEED_B, { kind: "body", body: feedOf(post("b")) })
    feeds.on(SFEED_C, { kind: "body", body: feedOf(post("c")) })
    beforeGet = async (url) => {
      if (url === SFEED_B) await database.db.deleteFrom("alert_feed").where("id", "=", c).execute()
    }
    await run()
    expect(requestsTo(SFEED_C)).toEqual([])
    const posts = await database.db.selectFrom("stack_post").select(["canonical_url", "source_feed_id"]).where("candidate_id", "=", bolaId).execute()
    expect(posts.map((row) => row.canonical_url)).toEqual([post("b")])
    expect(posts.every((row) => row.source_feed_id !== c)).toBe(true)
  })

  it("SFS:279 two firings of one 08:00 occurrence through the cron path file one job, so her feed gets one request", async () => {
    await recordStack(database.db, bolaId)
    await insertStackFeed(database.db, bolaId, SFEED_B)
    feeds.on(SFEED_B, { kind: "body", body: feedOf() })
    // The pg-boss cron pass files each occurrence with the same singletonKey and a slot from the occurrence time
    // (job_i4: name, singleton_on, singleton_key). Two passes over the same 08:00 occurrence: the second insert is dropped.
    const slot = "2026-10-28 07:00:00"
    const key = `${STACK_POSTS_READ_QUEUE}__`
    for (let pass = 0; pass < 2; pass++) {
      await sql`insert into pgboss.job (id, name, data, singleton_key, singleton_on, policy) values (gen_random_uuid(), ${STACK_POSTS_READ_QUEUE}, '{}'::jsonb, ${key}, ${slot}::timestamp, 'singleton')
        on conflict do nothing`.execute(database.db)
    }
    const filed = await sql<{ n: number }>`select count(*)::int as n from pgboss.job where name = ${STACK_POSTS_READ_QUEUE} and singleton_on = ${slot}::timestamp`.execute(database.db)
    expect(filed.rows[0]!.n).toBe(1)
    // That one job runs the handler once.
    await run()
    expect(requestsTo(SFEED_B)).toHaveLength(1)
    await sql`delete from pgboss.job where name = ${STACK_POSTS_READ_QUEUE}`.execute(database.db)
  })

  it("SFS:279 (AR-11) no application code sends a job to the scheduled read queue", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs")
    const { join } = await import("node:path")
    const root = new URL("../src", import.meta.url).pathname
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((entry) => (statSync(join(dir, entry)).isDirectory() ? walk(join(dir, entry)) : entry.endsWith(".ts") ? [join(dir, entry)] : []))
    const senders = walk(root).filter((path) => /\.(send|sendAfter|insert)\(\s*STACK_POSTS_READ_QUEUE/.test(readFileSync(path, "utf8")))
    expect(senders).toEqual([])
  })

  it("SFS:270 the scheduled job's comment says the read runs for each active Candidate, not only the Operator", async () => {
    const { readFileSync } = await import("node:fs")
    for (const file of ["../src/worker/stack-posts-jobs.ts", "../src/stack-posts/stack-posts-reader.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8")
      expect(source).not.toMatch(/Operator's scope|until invitees can register feeds|asOperator/)
    }
    expect(readFileSync(new URL("../src/worker/stack-posts-jobs.ts", import.meta.url), "utf8")).toMatch(/once\s+\*?\s*for each active Candidate/)
  })

  it("MIG:53, MIG:319 (API half) with the copied record the Operator's live feeds are read at the next run, exactly once", async () => {
    await setLegacy(database.db as never, true)
    await recordStack(database.db, ADA(), { verifiedOn: "2026-09-30" })
    await insertStackFeed(database.db, ADA(), SFEED_A)
    await insertStackFeed(database.db, ADA(), SFEED_B)
    feeds.on(SFEED_A, { kind: "body", body: feedOf() })
    feeds.on(SFEED_B, { kind: "body", body: feedOf() })
    clock.set("2026-10-28T13:00:00Z")
    await run()
    expect([requestsTo(SFEED_A).length, requestsTo(SFEED_B).length]).toEqual([1, 1])
    expect(await stackRuns(database.db, ADA())).toEqual(["completed"])
  })

  it("MIG:122 an invitee's feeds registered before EPIC-0008 are kept and not read", async () => {
    await setLegacy(database.db as never, true)
    await recordStack(database.db, ADA())
    await insertStackFeed(database.db, bolaId, SFEED_B)
    await insertStackFeed(database.db, bolaId, SFEED_C)
    await run()
    expect(await database.db.selectFrom("alert_feed").select("url").where("candidate_id", "=", bolaId).orderBy("url").execute()).toHaveLength(2)
    expect([requestsTo(SFEED_B).length, requestsTo(SFEED_C).length]).toEqual([0, 0])
    expect(await stackRuns(database.db, bolaId)).toEqual(["skipped_unverified"])
  })

  it("MIG:233, MIG:217 (worker half) deleting the legacy row, or locking the runtime role out of it, changes no read", async () => {
    await setLegacy(database.db as never, true)
    await recordStack(database.db, ADA())
    await insertStackFeed(database.db, ADA(), SFEED_A)
    feeds.on(SFEED_A, { kind: "body", body: feedOf() })
    await sql`delete from alert_feed_verification`.execute(database.db)
    const restore = await revokeRuntime(database, "alert_feed_verification")
    try {
      await run()
    } finally {
      await restore()
    }
    expect(requestsTo(SFEED_A)).toHaveLength(1)
  })

  it("COPY:156 Hiring reads still follow only her own Hiring record: her Stack posts record does not read her Hiring feed", async () => {
    await recordStack(database.db, bolaId)
    await database.db.insertInto("hiring_alert_feed").values({ candidate_id: bolaId, id: crypto.randomUUID(), url: HFEED_B, label: null, created_at: clock.now(), last_read_at: null, last_failure_reason: null, last_failed_at: null }).execute()
    feeds.on(HFEED_B, { kind: "body", body: feedOf() })
    await run()
    expect(requestsTo(HFEED_B)).toEqual([])
    expect((await database.db.selectFrom("hiring_post_run").select("outcome").where("candidate_id", "=", bolaId).execute()).map((row) => row.outcome)).toEqual(["skipped_unverified"])
    expect(worker.get(HiringPostsReader)).toBeDefined()
  })
})
