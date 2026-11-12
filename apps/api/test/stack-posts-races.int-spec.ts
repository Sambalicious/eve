import { randomUUID } from "node:crypto"

import { type INestApplication, Logger, type LoggerService } from "@nestjs/common"
import { ALERT_FEEDS_PATH, ALERT_FEED_VERIFICATION_PATH, STACK_POSTS_PATH, apiErrorResponseSchema, stackPostsResponseSchema } from "@eve/contracts"
import { type Kysely, sql } from "kysely"
import { HttpResponse, http } from "msw"
import pg from "pg"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import type { Database } from "../src/db/schema.js"
import { DiscoveryPipeline } from "../src/discovery/discovery-pipeline.js"
import { type AlertFeedGetOptions, type AlertFeedHttp, createAlertFeedHttp } from "../src/stack-posts/alert-feed-http.js"
import { StackPostsSummaryReader } from "../src/stack-posts/stack-posts-summary.js"
import { StackPostsReader } from "../src/stack-posts/stack-posts-reader.js"
import { FEED_REGISTRATION_LOCK_CLASS, SUMMARY_WINDOW_LOCK_KEY, StackPostsRepository } from "../src/stack-posts/stack-posts.repository.js"
import { FEED_A, FEED_B, atomFeed, googleRedirect } from "./support/alert-feed-fixtures.js"
import { Browser } from "./support/browser.js"
import { OutboundRecorder } from "./support/fake-anthropic.js"
import { FakeFeedServer } from "./support/fake-feed-server.js"
import { FakeGoogle } from "./support/fake-google.js"
import { postingsOf } from "./support/candidate-posting.js"
import { asOperatorWith } from "./support/operator-scope.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"
import { FIXTURE_POSTED_ISO } from "./support/posted-date-fixture.js"

/**
 * QA (run epic-0005-f, D-E5-16): the nine EPIC-0005 `@manual` race scenarios
 * scripted with controlled timing, against the real api, real Postgres
 * (runtime role) and a local feed server. No sleeps decide an ordering:
 * - a gate on the injected Alert feed client holds a fetch until the test
 *   releases it, and reports how many callers are waiting;
 * - a temporary trigger takes a shared advisory lock that the test holds
 *   exclusively on its own connection, so a write parks at an exact point
 *   (before or after its row insert) until the test releases it; the test
 *   waits until Postgres reports the lock wait in `pg_locks`;
 * - a transaction the test holds open on the owner connection.
 * The observer connection is the admin role, which can see every session in
 * `pg_locks` and `pg_stat_activity`.
 * Holds stay well under the api's 5 s statement timeout.
 */
const LOCK_KEY = 72_005_016
const clock = new TestClock("2026-10-21T09:00:00.000Z")
const logs: string[] = []
const line = (message: unknown, ...rest: unknown[]) => void logs.push([message, ...rest].map(String).join(" "))
const capture: LoggerService = { log: line, warn: line, error: line, debug: line, verbose: line }

let database: TestDatabase
let runtime: Kysely<Database>
let tenant: TenantDatabase
let google: FakeGoogle
let outbound: OutboundRecorder
let feeds: FakeFeedServer
let app: INestApplication
let candidate: SignedInCandidate
let reader: StackPostsReader
let holder: pg.Client

/** A deferred promise. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

/** Waits until `predicate` holds, polling every 10 ms; fails after `ms`. Used only to observe a state, never to order work. */
async function until(predicate: () => boolean | Promise<boolean>, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("condition not reached")
    await new Promise((r) => setTimeout(r, 10))
  }
}

/**
 * The production client behind a gate. `hold(url)` makes every later fetch of
 * that URL wait at the gate; `waiting(url)` counts callers parked there;
 * `release(url)` lets them all through. `seen` records, per fetch, whether a
 * verification row existed when the fetch was made.
 */
class GatedFeedHttp implements AlertFeedHttp {
  inner!: AlertFeedHttp
  private readonly gates = new Map<string, { waiting: number; open: ReturnType<typeof deferred> }>()
  readonly seen: { url: string; verified: boolean }[] = []
  onSleep: () => Promise<void> = async () => undefined

  hold(url: string): void {
    this.gates.set(url, { waiting: 0, open: deferred() })
  }

  waiting(url: string): number {
    return this.gates.get(url)?.waiting ?? 0
  }

  release(url: string): void {
    this.gates.get(url)?.open.resolve()
    this.gates.delete(url)
  }

  reset(): void {
    for (const url of [...this.gates.keys()]) this.release(url)
    this.seen.length = 0
    this.onSleep = async () => undefined
  }

  async get(url: string, options: AlertFeedGetOptions): Promise<string | null> {
    // EPIC-0008: the Operator's own Stack posts record (the signed-in candidate is the Operator).
    const verified = (await database.db.selectFrom("alert_feed_candidate_verification").select("candidate_id").where("candidate_id", "=", database.operatorId).executeTakeFirst()) !== undefined
    this.seen.push({ url, verified })
    const gate = this.gates.get(url)
    if (gate) {
      gate.waiting += 1
      await gate.open.promise
    }
    return this.inner.get(url, options)
  }
}
const gated = new GatedFeedHttp()

/** Parks matching writes on `table` at the trigger point (`event`, default insert) until `releaseLock()`. */
async function parkWrites(table: "stack_post", when: "before" | "after", condition: string, event: "insert" | "update" = "insert"): Promise<void> {
  await holder.query("select pg_advisory_lock($1)", [LOCK_KEY])
  await sql
    .raw(
      `create or replace function qa_park() returns trigger language plpgsql as $$
       begin
         if ${condition} then
           perform pg_advisory_lock_shared(${LOCK_KEY});
           perform pg_advisory_unlock_shared(${LOCK_KEY});
         end if;
         return new;
       end $$;
       create trigger qa_park ${when} ${event} on ${table} for each row execute function qa_park();`
    )
    .execute(database.db)
}

async function parkedCount(): Promise<number> {
  const { rows } = await holder.query<{ n: number }>("select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = $1 and not granted and database = (select oid from pg_database where datname = current_database())", [LOCK_KEY])
  return rows[0]!.n
}

/** Sessions waiting for the summary-window advisory lock (`SUMMARY_WINDOW_LOCK_KEY`, taken by the summary exclusively). */
async function windowLockWaiters(): Promise<number> {
  const { rows } = await holder.query<{ n: number }>("select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = $1 and not granted and database = (select oid from pg_database where datname = current_database())", [SUMMARY_WINDOW_LOCK_KEY])
  return rows[0]!.n
}

async function releaseLock(): Promise<void> {
  await holder.query("select pg_advisory_unlock_all()")
}

async function dropPark(): Promise<void> {
  await releaseLock()
  await sql.raw("drop trigger if exists qa_park on stack_post; drop function if exists qa_park();").execute(database.db)
}

beforeAll(async () => {
  Logger.overrideLogger(capture)
  database = await startMigratedDatabase()
  runtime = createDatabase(database.url)
  holder = new pg.Client({ connectionString: database.adminUrl })
  await holder.connect()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  outbound = new OutboundRecorder(google.server)
  feeds = await FakeFeedServer.start()
  gated.inner = createAlertFeedHttp({
    testOrigin: feeds.origin,
    timeoutMs: 2_000,
    sleep: async () => {
      await gated.onSleep()
    },
  })
  app = await createTestApp({ databaseUrl: database.url, clock, alertFeedHttp: gated })
  Logger.overrideLogger(capture)
  candidate = await signInCandidate(new Browser(app, google))
  tenant = new TenantDatabase(runtime)
  reader = asOperatorWith(tenant, new StackPostsReader(new StackPostsRepository(tenant), gated, clock))
})

beforeEach(async () => {
  clock.set("2026-10-21T09:00:00.000Z")
  feeds.reset()
  gated.reset()
  outbound.reset()
  google.server.resetHandlers()
  logs.length = 0
  Logger.overrideLogger(capture)
  await dropPark()
  for (const table of ["stack_post", "stack_post_run", "alert_feed", "alert_feed_candidate_verification", "notification_outbox", "candidate_posting", "job_posting"] as const) {
    await database.db.deleteFrom(table).execute()
  }
  await database.db.updateTable("control_state").set({ global_paused: false, cost_paused: false }).execute()
  await database.db.updateTable("job_criteria").set({ frameworks: ["React"], technologies: ["TypeScript"] }).execute()
})

afterEach(async () => {
  gated.reset()
  await dropPark()
  // AC 6.4, 6.7: nothing left 127.0.0.1.
  expect(outbound.urls).toEqual([])
})

afterAll(async () => {
  await app?.close()
  await feeds?.close()
  google?.close()
  await holder?.end()
  await runtime?.destroy()
  await database?.stop()
  Logger.overrideLogger(false)
})

const FEED_URL = (n: number) => `https://www.google.com/alerts/feeds/${String(n).padStart(20, "0")}/${300000 + n}`
const verify = () => candidate.put(ALERT_FEED_VERIFICATION_PATH).send({ verifiedOn: "2026-10-20", verificationBasis: "Reviewed Google Alerts terms." })
const register = (url: string, label: string | null = null) => candidate.post(ALERT_FEEDS_PATH).send({ url, label })
/** Supertest sends only when awaited; `start` sends now so the request can reach a gate while the test goes on. */
const start = (url: string, label: string | null = null) => Promise.resolve(register(url, label))
const feedRows = () => database.db.selectFrom("alert_feed").selectAll().orderBy("created_at").execute()
const fieldErrors = (body: unknown) => apiErrorResponseSchema.parse(body).error.fieldErrors
const SHARED_POST = "https://www.linkedin.com/posts/ada-obi_x-1"
const sharedFeed = (title: string) => atomFeed([{ title, link: googleRedirect(SHARED_POST), content: "React and TypeScript" }])

const sharedFirstSeen = async () => (await database.db.selectFrom("stack_post").select("first_seen_at").where("canonical_url", "=", SHARED_POST).execute()).map((row) => row.first_seen_at)

async function registeredQuietly(url: string, body = atomFeed([])): Promise<string> {
  feeds.on(url, { kind: "body", body })
  const response = await register(url).expect(201)
  return (response.body.feed as { id: string }).id
}

describe("alert-feed-verification.feature @concurrent @ac-3.3 (first verification vs a registration)", () => {
  it("verification still uncommitted when the registration checks: refused 409, no feed stored, no fetch", async () => {
    feeds.on(FEED_A, { kind: "body", body: atomFeed([]) })
    const tx = new pg.Client({ connectionString: database.ownerUrl })
    await tx.connect()
    try {
      await tx.query("begin")
      // EPIC-0008: her own row under forced RLS, so the owner connection sets her scope for this transaction
      // (the setting AND, under EPIC-0002 A2's 0022-candidate-binding, the transaction's binding).
      await tx.query("select set_config('eve.candidate_id', $1, true), public.bind_candidate($1::uuid)", [database.operatorId])
      await tx.query("insert into alert_feed_candidate_verification (candidate_id, verified_on, verification_basis, updated_at) values ($1, '2026-10-20', 'In flight', now())", [database.operatorId])
      const response = await register(FEED_A)
      expect(response.status).toBe(409)
      expect(apiErrorResponseSchema.parse(response.body).error.code).toBe("alert_feeds_not_verified")
      await tx.query("commit")
    } finally {
      await tx.end()
    }
    expect(await feedRows()).toEqual([])
    expect(feeds.requestsTo(FEED_A)).toBe(0)
    expect(gated.seen).toEqual([])
  })

  it("verification committed before the registration's check: the fetch is made only after it is stored", async () => {
    feeds.on(FEED_A, { kind: "body", body: atomFeed([]) })
    await verify().expect(200)
    await register(FEED_A).expect(201)
    expect(gated.seen).toEqual([{ url: FEED_A, verified: true }])
  })

  it("20 simultaneous pairs: each is refused with nothing stored, or accepted with the verification stored before the fetch; never half-stored", async () => {
    const outcomes = new Set<string>()
    for (let round = 0; round < 20; round += 1) {
      await database.db.deleteFrom("alert_feed").execute()
      await database.db.deleteFrom("alert_feed_candidate_verification").execute()
      gated.seen.length = 0
      feeds.on(FEED_A, { kind: "body", body: atomFeed([]) })
      const [saved, registration] = await Promise.all([verify(), register(FEED_A)])
      expect(saved.status).toBe(200)
      const rows = await feedRows()
      if (registration.status === 409) {
        outcomes.add("refused")
        expect(apiErrorResponseSchema.parse(registration.body).error.code).toBe("alert_feeds_not_verified")
        expect(rows).toEqual([])
        expect(gated.seen).toEqual([])
      } else {
        outcomes.add("accepted")
        expect(registration.status).toBe(201)
        expect(rows).toHaveLength(1)
        expect(gated.seen).toEqual([{ url: FEED_A, verified: true }])
      }
      expect(await database.db.selectFrom("alert_feed_candidate_verification").selectAll().execute()).toHaveLength(1)
    }
    expect(outcomes.size).toBeGreaterThan(0)
  })
})

describe("alert-feeds.feature @concurrent @ac-4.3 (two registrations of the same URL)", () => {
  it("both pass the pre-checks and are parked at their one fetch; released together, one feed is stored and the other is refused as duplicate", async () => {
    await verify().expect(200)
    feeds.on(FEED_A, { kind: "body", body: sharedFeed("Shared") })
    gated.hold(FEED_A)
    const pending = [start(FEED_A, "One"), start(FEED_A, "Two")]
    // Both requests are past validation, verification, limit and duplicate checks, parked at their one fetch.
    await until(() => gated.waiting(FEED_A) === 2)
    gated.release(FEED_A)
    const responses = await Promise.all(pending)
    expect(responses.map((response) => response.status).sort()).toEqual([201, 400])
    expect(fieldErrors(responses.find((response) => response.status === 400)!.body)).toEqual([{ field: "url", position: null, problem: "duplicate" }])
    expect((await feedRows()).filter((row) => row.url === FEED_A)).toHaveLength(1)
    expect(await database.db.selectFrom("stack_post").select("canonical_url").execute()).toEqual([{ canonical_url: SHARED_POST }])
    expect(feeds.requestsTo(FEED_A)).toBe(2)
  })
})

describe("alert-feeds.feature @concurrent @ac-4.3 (two registrations for the 10th slot)", () => {
  it.each([
    ["FEED_A released first", 0],
    ["FEED_B released first", 1],
  ] as const)("both parked at the fetch with 9 feeds stored, %s: 10 feeds, the other refused as limit_reached", async (_name, firstIndex) => {
    await verify().expect(200)
    for (let n = 1; n <= 9; n += 1) await registeredQuietly(FEED_URL(n))
    const urls = [FEED_A, FEED_B]
    for (const url of urls) {
      feeds.on(url, { kind: "body", body: atomFeed([]) })
      gated.hold(url)
    }
    const pending = urls.map((url) => start(url))
    await until(() => gated.waiting(FEED_A) === 1 && gated.waiting(FEED_B) === 1)
    const first = urls[firstIndex]!
    const second = urls[1 - firstIndex]!
    gated.release(first)
    const firstResponse = await pending[firstIndex]!
    gated.release(second)
    const secondResponse = await pending[1 - firstIndex]!
    expect(firstResponse.status).toBe(201)
    expect(secondResponse.status).toBe(400)
    expect(fieldErrors(secondResponse.body)).toEqual([{ field: "url", position: null, problem: "limit_reached" }])
    const rows = await feedRows()
    expect(rows).toHaveLength(10)
    expect(rows.map((row) => row.url)).toContain(first)
    expect(rows.map((row) => row.url)).not.toContain(second)
  })

  it("both released together: exactly 10 feeds and one limit_reached", async () => {
    await verify().expect(200)
    for (let n = 1; n <= 9; n += 1) await registeredQuietly(FEED_URL(n))
    for (const url of [FEED_A, FEED_B]) {
      feeds.on(url, { kind: "body", body: atomFeed([]) })
      gated.hold(url)
    }
    const pending = [start(FEED_A), start(FEED_B)]
    await until(() => gated.waiting(FEED_A) === 1 && gated.waiting(FEED_B) === 1)
    gated.release(FEED_A)
    gated.release(FEED_B)
    const responses = await Promise.all(pending)
    expect(responses.map((response) => response.status).sort()).toEqual([201, 400])
    expect(fieldErrors(responses.find((response) => response.status === 400)!.body)).toEqual([{ field: "url", position: null, problem: "limit_reached" }])
    expect(await feedRows()).toHaveLength(10)
  })
})

describe("alert-feeds.feature @concurrent @ac-4.8 (removal while a scheduled run is between retries)", () => {
  it("the feed is removed during the retry wait: no further request, not listed, no failure recorded", async () => {
    await verify().expect(200)
    const id = await registeredQuietly(FEED_A)
    feeds.reset()
    feeds.on(FEED_A, { kind: "status", status: 503 })
    const inWait = deferred()
    const resume = deferred()
    gated.onSleep = async () => {
      inWait.resolve()
      await resume.promise
    }
    const run = reader.runRead()
    await inWait.promise
    // The run is parked between attempt 1 and attempt 2.
    expect(feeds.requestsTo(FEED_A)).toBe(1)
    await candidate.delete(`${ALERT_FEEDS_PATH}/${id}`).expect(204)
    const listed = (await candidate.get(ALERT_FEEDS_PATH).expect(200)).body as { feeds: { label: string | null }[] }
    expect(listed.feeds).toEqual([])
    resume.resolve()
    expect(await run).toMatchObject({ outcome: "completed", feedsRead: 0, feedsFailed: 0 })
    expect(feeds.requestsTo(FEED_A)).toBe(1)
    expect(await database.db.selectFrom("stack_post_run").select(["feeds_read", "feeds_failed"]).execute()).toEqual([{ feeds_read: 0, feeds_failed: 0 }])
  })

  it("the feed is removed after the run picked it and before its fetch returns: the read is discarded, nothing stored", async () => {
    await verify().expect(200)
    const id = await registeredQuietly(FEED_A)
    feeds.reset()
    feeds.on(FEED_A, { kind: "body", body: sharedFeed("Late") })
    gated.hold(FEED_A)
    const run = reader.runRead()
    await until(() => gated.waiting(FEED_A) === 1)
    await candidate.delete(`${ALERT_FEEDS_PATH}/${id}`).expect(204)
    gated.release(FEED_A)
    expect(await run).toMatchObject({ outcome: "completed", feedsRead: 0, feedsFailed: 0, postsStored: 0 })
    expect(await database.db.selectFrom("stack_post").selectAll().execute()).toEqual([])
    expect(await feedRows()).toEqual([])
  })
})

describe("alert-feeds.feature @concurrent @ac-4.5 (a scheduled run and a registration of another feed)", () => {
  it("the run is parked on FEED_A's fetch: FEED_B registers meanwhile; then the run reads FEED_A", async () => {
    await verify().expect(200)
    await registeredQuietly(FEED_A)
    feeds.on(FEED_A, { kind: "body", body: atomFeed([{ title: "React read", link: googleRedirect("https://www.linkedin.com/posts/run-a-1") }]) })
    feeds.on(FEED_B, { kind: "body", body: atomFeed([]) })
    gated.hold(FEED_A)
    const run = reader.runRead()
    await until(() => gated.waiting(FEED_A) === 1)
    const registration = await register(FEED_B, "TS posts")
    expect(registration.status).toBe(201)
    expect((await feedRows()).map((row) => row.label)).toContain("TS posts")
    gated.release(FEED_A)
    expect(await run).toMatchObject({ outcome: "completed", feedsRead: 1, postsStored: 1 })
  })

  it("the run is parked inside its storing transaction for FEED_A: FEED_B registers meanwhile; then the run commits", async () => {
    await verify().expect(200)
    const feedA = await registeredQuietly(FEED_A)
    feeds.on(FEED_A, { kind: "body", body: atomFeed([{ title: "React read", link: googleRedirect("https://www.linkedin.com/posts/run-a-2") }]) })
    feeds.on(FEED_B, { kind: "body", body: atomFeed([]) })
    await parkWrites("stack_post", "before", `new.source_feed_id = '${feedA}'::uuid`)
    const run = reader.runRead()
    await until(async () => (await parkedCount()) === 1)
    const registration = await register(FEED_B, "TS posts")
    expect(registration.status).toBe(201)
    await releaseLock()
    expect(await run).toMatchObject({ outcome: "completed", feedsRead: 1, postsStored: 1 })
    const labels = (await feedRows()).map((row) => row.label)
    expect(labels).toHaveLength(2)
    expect(labels).toEqual(expect.arrayContaining([null, "TS posts"]))
  })
})

describe("stack-post-ingestion.feature @concurrent @ac-5.3 (registration fetch and scheduled read store the same post)", () => {
  async function setup(): Promise<string> {
    await verify().expect(200)
    const feedA = await registeredQuietly(FEED_A)
    feeds.on(FEED_A, { kind: "body", body: sharedFeed("From A") })
    feeds.on(FEED_B, { kind: "body", body: sharedFeed("From B") })
    return feedA
  }
  const sharedRows = () => database.db.selectFrom("stack_post").select(["canonical_url", "title", "source_feed_id"]).where("canonical_url", "=", SHARED_POST).execute()

  it("the read is parked before its insert; the registration's write completes first: one row, source FEED_B", async () => {
    const feedA = await setup()
    await parkWrites("stack_post", "before", `new.source_feed_id = '${feedA}'::uuid`)
    const run = reader.runRead()
    await until(async () => (await parkedCount()) === 1)
    const registration = await register(FEED_B, "TS posts").expect(201)
    expect(registration.body.storedPosts).toBe(1)
    await releaseLock()
    expect(await run).toMatchObject({ feedsRead: 1, postsStored: 0 })
    const feedB = (registration.body.feed as { id: string }).id
    expect(await sharedRows()).toEqual([{ canonical_url: SHARED_POST, title: "From B", source_feed_id: feedB }])
  })

  it("the registration is parked before its insert; the read's write completes first: one row, source FEED_A", async () => {
    const feedA = await setup()
    await parkWrites("stack_post", "before", `new.source_feed_id <> '${feedA}'::uuid`)
    const registration = start(FEED_B, "TS posts")
    await until(async () => (await parkedCount()) === 1)
    expect(await reader.runRead()).toMatchObject({ feedsRead: 1, postsStored: 1 })
    await releaseLock()
    const response = await registration
    expect(response.status).toBe(201)
    expect(response.body.storedPosts).toBe(0)
    expect(await sharedRows()).toEqual([{ canonical_url: SHARED_POST, title: "From A", source_feed_id: feedA }])
  })

  it("the registration has inserted the row but not committed; the read waits on it, then stores nothing: one row, source FEED_B", async () => {
    const feedA = await setup()
    await parkWrites("stack_post", "after", `new.source_feed_id <> '${feedA}'::uuid`)
    const registration = start(FEED_B, "TS posts")
    await until(async () => (await parkedCount()) === 1)
    const run = reader.runRead()
    // The read's insert now waits on the registration's uncommitted row (a transactionid lock wait).
    await until(async () => {
      const { rows } = await holder.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event = 'transactionid'")
      return rows[0]!.n >= 1
    })
    await releaseLock()
    const response = await registration
    expect(response.status).toBe(201)
    expect(response.body.storedPosts).toBe(1)
    expect(await run).toMatchObject({ feedsRead: 1, postsStored: 0 })
    const feedB = (response.body.feed as { id: string }).id
    expect(await sharedRows()).toEqual([{ canonical_url: SHARED_POST, title: "From B", source_feed_id: feedB }])
  })
})

describe("daily-summary.feature @concurrent @ac-8.2 (a post stored while the summary renders)", () => {
  const summaries = () => asOperatorWith(tenant, new StackPostsSummaryReader(tenant))

  async function outboxRow(at: Date, status: "sent" | "sending"): Promise<string> {
    const id = randomUUID()
    const day = new Date(at.getTime() + 3_600_000).toISOString().slice(0, 10)
    await database.db
      .insertInto("notification_outbox")
      .values({ candidate_id: database.operatorId, id, application_id: null, kind: "daily_summary", local_day: day, created_at: at, sent_at: status === "sent" ? at : null })
      .execute()
    await sql`update notification_outbox set status = ${status}, claimed_at = ${at} where id = ${id}`.execute(database.db)
    return id
  }

  /** Renders summary N at `claimedAt` and marks it sent, as the sender does on success. */
  async function render(claimedAt: Date): Promise<string[]> {
    const id = await outboxRow(claimedAt, "sending")
    const summary = await summaries().summary(id, claimedAt)
    await sql`update notification_outbox set status = 'sent', sent_at = ${claimedAt} where id = ${id}`.execute(database.db)
    return summary.newPosts.map((post) => post.canonicalUrl)
  }

  /** Returns the parked run wrapped, so the caller does not wait for it (an async function would adopt a returned promise). */
  async function storingRead(feedA: string, firstSeen: string): Promise<{ run: Promise<unknown> }> {
    feeds.on(FEED_A, { kind: "body", body: sharedFeed("Racing post") })
    await parkWrites("stack_post", "after", `new.source_feed_id = '${feedA}'::uuid`)
    clock.set(firstSeen)
    const run = reader.runRead()
    await until(async () => (await parkedCount()) === 1)
    return { run }
  }

  it("first seen after this summary's claim, committed while it renders: in the next summary only", async () => {
    await verify().expect(200)
    const feedA = await registeredQuietly(FEED_A)
    await outboxRow(new Date("2026-10-20T20:00:00Z"), "sent")
    const { run } = await storingRead(feedA, "2026-10-21T20:00:00.500Z")
    const thisOne = await render(new Date("2026-10-21T20:00:00.000Z"))
    await releaseLock()
    await run
    const next = await render(new Date("2026-10-22T20:00:00.000Z"))
    expect([thisOne.includes(SHARED_POST), next.includes(SHARED_POST)]).toEqual([false, true])
  })

  it("committed before this summary's claim: in this summary only", async () => {
    await verify().expect(200)
    await registeredQuietly(FEED_A)
    await outboxRow(new Date("2026-10-20T20:00:00Z"), "sent")
    feeds.on(FEED_A, { kind: "body", body: sharedFeed("Racing post") })
    clock.set("2026-10-21T19:59:59.000Z")
    await reader.runRead()
    const thisOne = await render(new Date("2026-10-21T20:00:00.000Z"))
    const next = await render(new Date("2026-10-22T20:00:00.000Z"))
    expect([thisOne.includes(SHARED_POST), next.includes(SHARED_POST)]).toEqual([true, false])
  })

  // F-QA-E5F-01 (fixed in repair wave 2, architecture.r1.md "Revision r2"): a post stamped before a claim but committed
  // after that summary rendered used to fall in neither window. The write now re-stamps first_seen_at past the latest
  // claim as its last statement, so this post belongs to the next summary.
  it("first seen before this summary's claim but committed after it rendered: listed in exactly one summary", async () => {
    await verify().expect(200)
    const feedA = await registeredQuietly(FEED_A)
    await outboxRow(new Date("2026-10-20T20:00:00Z"), "sent")
    // The read takes its time (19:59:59.900) before the sender claims (20:00:00.000) and commits after the render.
    const { run } = await storingRead(feedA, "2026-10-21T19:59:59.900Z")
    const thisOne = await render(new Date("2026-10-21T20:00:00.000Z"))
    await releaseLock()
    await run
    const next = await render(new Date("2026-10-22T20:00:00.000Z"))
    const appearances = [thisOne.includes(SHARED_POST), next.includes(SHARED_POST)].filter(Boolean).length
    expect(appearances, "the post must be listed in exactly one of the two summaries (never in neither)").toBe(1)
  })

  // CR-E5F-01/02, F-QA-E5F-04: the window-lock half of the F-QA-E5F-01 fix. The writer has run its re-stamp (no claim
  // was visible, so first_seen_at stays before the claim) and holds the shared window lock, but has not committed,
  // while a summary claims and reads. The summary's exclusive lock must make it wait for the commit and list the post.
  // Fails if either lock is removed: the summary then reads without the row, and the next window starts past its stamp.
  it("first seen before this summary's claim, re-stamped but not committed when it claims and reads: listed in exactly one summary", async () => {
    await verify().expect(200)
    const feedA = await registeredQuietly(FEED_A)
    await outboxRow(new Date("2026-10-20T20:00:00Z"), "sent")
    feeds.on(FEED_A, { kind: "body", body: sharedFeed("Racing post") })
    // The writer parks in an AFTER UPDATE trigger: the only update of stack_post in a write is settleFirstSeen's re-stamp.
    await parkWrites("stack_post", "after", `new.source_feed_id = '${feedA}'::uuid`, "update")
    clock.set("2026-10-21T19:59:59.900Z")
    const run = reader.runRead()
    await until(async () => (await parkedCount()) === 1)
    const [stamped] = await sharedFirstSeen()
    expect(stamped, "the re-stamp is uncommitted, so other sessions do not see the row yet").toBeUndefined()
    let rendered = false
    const thisOne = render(new Date("2026-10-21T20:00:00.000Z")).finally(() => (rendered = true))
    // Observed, not ordered: the summary either waits on the window lock (locks in place) or finishes without waiting.
    await until(async () => rendered || (await windowLockWaiters()) === 1)
    await releaseLock()
    await run
    // Summary N is marked sent before summary N+1 claims, as the sender does.
    const thisSummary = await thisOne
    const firstSeen = await sharedFirstSeen()
    expect(firstSeen, "the re-stamp saw no claim, so the post keeps its pre-claim time").toEqual([new Date("2026-10-21T19:59:59.900Z")])
    const next = await render(new Date("2026-10-22T20:00:00.000Z"))
    const appearances = [thisSummary.includes(SHARED_POST), next.includes(SHARED_POST)].filter(Boolean).length
    expect(appearances, "the post must be listed in exactly one of the two summaries (never in neither)").toBe(1)
  })
})

describe("outbound-and-separation.feature @concurrent @ac-9.1 (a feed read during a discovery run)", () => {
  const board = () =>
    http.get("https://boards-api.greenhouse.io/v1/boards/:token/jobs", ({ params }) =>
      HttpResponse.json(
        params.token === "canonical"
          ? {
              jobs: [
                { id: 1042, title: "Senior Frontend Engineer", absolute_url: "https://boards.greenhouse.io/canonical/jobs/1042", first_published: FIXTURE_POSTED_ISO, requisition_id: "R-1042", content: "Remote. React." },
                { id: 2, title: "Account Executive", absolute_url: "https://boards.greenhouse.io/canonical/jobs/2", first_published: FIXTURE_POSTED_ISO, requisition_id: "R-2", content: "Sales." },
              ],
            }
          : { jobs: [] }
      )
    )
  const others = [
    http.get("https://api.ashbyhq.com/posting-api/job-board/:token", () => HttpResponse.json({ jobs: [] })),
    http.get("https://api.lever.co/v0/postings/:token", () => HttpResponse.json([])),
  ]
  const postings = async () =>
    (await postingsOf(database.db, database.operatorId).select(["application_url", "requisition_id", "title", "company", "status", "skip_reason", "role_family"]).orderBy("application_url").execute())
  const posts = async () => (await database.db.selectFrom("stack_post").select(["canonical_url", "title", "snippet", "matched_technologies", "kind"]).orderBy("canonical_url").execute())

  async function resetBoth(): Promise<void> {
    await database.db.deleteFrom("candidate_posting").execute()
    await database.db.deleteFrom("job_posting").execute()
    await database.db.deleteFrom("stack_post").execute()
    await database.db.updateTable("employer_board").set({ last_read_at: null }).execute()
    await database.db.updateTable("employer_list_state").set({ approved_at: new Date("2026-10-01T00:00:00Z") }).execute()
  }

  it("discovery runs while the feed read is parked inside its storing transaction: both results equal their solo runs", async () => {
    await verify().expect(200)
    const feedA = await registeredQuietly(FEED_A)
    const feedBody = atomFeed([
      { title: "React at scale", link: googleRedirect("https://www.linkedin.com/posts/sep-1"), content: "React and TypeScript" },
      { title: "Hiring", link: googleRedirect("https://www.linkedin.com/jobs/view/9") },
    ])
    feeds.on(FEED_A, { kind: "body", body: feedBody })
    google.server.use(board(), ...others)
    // EPIC-0002 A1: the worker runs discovery in the Operator's scope.
    const pipeline = asOperatorWith(tenant, app.get(DiscoveryPipeline))

    await resetBoth()
    const soloDiscovery = await pipeline.runDaily()
    const soloPostings = await postings()
    await resetBoth()
    await reader.runRead()
    const soloPosts = await posts()
    expect(soloPostings.length).toBeGreaterThan(0)
    expect(soloPosts.length).toBeGreaterThan(0)

    await resetBoth()
    await parkWrites("stack_post", "after", `new.source_feed_id = '${feedA}'::uuid`)
    const run = reader.runRead()
    await until(async () => (await parkedCount()) === 1)
    const together = await pipeline.runDaily()
    await releaseLock()
    await run

    expect({ ...together, postingIdsToEvaluate: together.postingIdsToEvaluate.length }).toEqual({ ...soloDiscovery, postingIdsToEvaluate: soloDiscovery.postingIdsToEvaluate.length })
    expect(await postings()).toEqual(soloPostings)
    expect(await posts()).toEqual(soloPosts)
    // Only board API hosts were contacted by discovery (through MSW); clear them before the file's outbound check.
    expect(outbound.urls.every((url) => /^GET https:\/\/(boards-api\.greenhouse\.io|api\.ashbyhq\.com|api\.lever\.co)\//.test(url))).toBe(true)
    outbound.reset()
  })
})

describe("posts-list.feature @concurrent @ac-7.1 (paging while retention deletes)", () => {
  async function seed(count: number): Promise<void> {
    const rows = Array.from({ length: count }, (_, i) => ({
      candidate_id: database.operatorId,
      id: randomUUID(),
      canonical_url: `https://www.linkedin.com/posts/page-${i}-${randomUUID().slice(0, 8)}`,
      kind: "post" as const,
      title: `Seed ${i}`,
      snippet: "s",
      published_at: null,
      matched_technologies: [],
      source_feed_id: null,
      first_seen_at: new Date(Date.UTC(2026, 9, 1) + i * 60_000),
    }))
    for (let i = 0; i < rows.length; i += 500) await database.db.insertInto("stack_post").values(rows.slice(i, i + 500)).execute()
  }
  const page40 = async () => stackPostsResponseSchema.parse((await candidate.get(`${STACK_POSTS_PATH}?page=40`).expect(200)).body)

  it("retention's delete of the 10 oldest is uncommitted while page 40 is served, then committed: no duplicate either time", async () => {
    await verify().expect(200)
    await seed(2010)
    const tx = new pg.Client({ connectionString: database.ownerUrl })
    await tx.connect()
    try {
      await tx.query("begin")
      await tx.query("select set_config('eve.candidate_id', $1, true), public.bind_candidate($1::uuid)", [database.operatorId])
      const { rowCount } = await tx.query("delete from stack_post where candidate_id = $1 and id in (select id from stack_post where candidate_id = $1 order by first_seen_at asc, id asc limit 10)", [database.operatorId])
      expect(rowCount).toBe(10)
      const during = await page40()
      expect(during.totalCount).toBe(2010)
      expect(new Set(during.items.map((item) => item.id)).size).toBe(during.items.length)
      expect(during.items).toHaveLength(50)
      await tx.query("commit")
    } finally {
      await tx.end()
    }
    const after = await page40()
    expect(after.totalCount).toBe(2000)
    expect(after.items).toHaveLength(50)
    expect(new Set(after.items.map((item) => item.id)).size).toBe(50)
  })

  it("the real retention (2,010 to 2,000) runs concurrently with 20 page-40 requests: every page is duplicate-free and matches its own total", async () => {
    await verify().expect(200)
    await seed(2010)
    clock.set("2026-10-21T09:00:00.000Z")
    const pages = Array.from({ length: 20 }, () => page40())
    const retention = asOperatorWith(tenant, new StackPostsRepository(tenant)).applyRetention(clock.now())
    const [deleted, ...served] = await Promise.all([retention, ...pages])
    expect(deleted).toBe(10)
    for (const page of served) {
      expect(new Set(page.items.map((item) => item.id)).size).toBe(page.items.length)
      expect(page.items).toHaveLength(Math.min(50, page.totalCount - 1950))
      expect([2000, 2010]).toContain(page.totalCount)
    }
  })
})

describe("alert-feeds.feature @sad @ac-4.4 (a registration whose lock wait times out, SEC-E5F-04, architecture r4 item 3)", () => {
  const entryFeed = () => atomFeed([{ title: "React in production", link: googleRedirect("https://www.linkedin.com/posts/ada-obi_busy-1"), content: "React and TypeScript" }])

  /** Holds `hold` on its own admin connection while one registration runs; returns the response and how long it took. */
  async function registerWhile(hold: (client: pg.Client) => Promise<void>): Promise<{ status: number; body: unknown; retryAfter: string | undefined; ms: number }> {
    const client = new pg.Client({ connectionString: database.adminUrl })
    await client.connect()
    try {
      await hold(client)
      const started = Date.now()
      const response = await register(FEED_A, "React posts")
      return { status: response.status, body: response.body, retryAfter: response.headers["retry-after"] as string | undefined, ms: Date.now() - started }
    } finally {
      await client.end()
    }
  }

  const holdWindowLock = async (client: pg.Client): Promise<void> => void (await client.query("select pg_advisory_lock($1)", [SUMMARY_WINDOW_LOCK_KEY]))
  // EPIC-0008 (AR-4): the per-Candidate registration lock replaces the shared verification row lock.
  const holdRegistrationLock = async (client: pg.Client): Promise<void> => {
    await client.query("begin")
    await client.query("select pg_advisory_xact_lock($1::int, hashtext($2::text))", [FEED_REGISTRATION_LOCK_CLASS, database.operatorId])
  }
  const holdLegacyRow = async (client: pg.Client): Promise<void> => {
    await client.query("begin")
    await client.query("select singleton from alert_feed_verification for update")
  }

  it.each([
    ["another session holds the daily summary's window lock", holdWindowLock],
    ["another session holds her per-Candidate registration lock", holdRegistrationLock],
  ] as const)("%s: 503 service_unavailable with Retry-After 5 after the 3 s lock bound, nothing stored, one fetch", async (_name, hold) => {
    await verify().expect(200)
    feeds.on(FEED_A, { kind: "body", body: entryFeed() })
    const result = await registerWhile(hold)
    expect(result.status).toBe(503)
    expect(result.retryAfter).toBe("5")
    expect(apiErrorResponseSchema.parse(result.body)).toEqual({ error: { code: "service_unavailable", message: "The service is unavailable. Try again shortly." } })
    expect(JSON.stringify(result.body)).not.toMatch(/retry/i)
    // Only 55P03 (lock_timeout) maps to 503; a statement timeout (57014) would be a 500, so the status proves
    // which bound fired. Wall time includes the fetch and the pre-checks, so the upper bound is the local
    // 10 s statement bound rather than a load-sensitive 5 s.
    expect(result.ms).toBeGreaterThanOrEqual(2_900)
    expect(result.ms).toBeLessThan(10_000)
    expect(await feedRows()).toEqual([])
    expect(await database.db.selectFrom("stack_post").select("id").execute()).toEqual([])
    expect(feeds.requestsTo(FEED_A)).toBe(1)
  })

  it("SRG:193 another session holding the legacy shared row for update does not delay registration (EPIC-0008 AR-4)", async () => {
    await sql`insert into alert_feed_verification (verified_on, verification_basis, updated_at) values ('2026-09-30', 'Legacy.', now()) on conflict (singleton) do nothing`.execute(database.db)
    await verify().expect(200)
    feeds.on(FEED_A, { kind: "body", body: entryFeed() })
    const result = await registerWhile(holdLegacyRow)
    expect(result.status).toBe(201)
    expect(result.ms).toBeLessThan(2_900)
    expect((await feedRows()).map((row) => row.url)).toEqual([FEED_A])
    await sql`delete from alert_feed_verification`.execute(database.db)
  })

  it("retrying after the lock is free registers the feed once", async () => {
    await verify().expect(200)
    feeds.on(FEED_A, { kind: "body", body: entryFeed() })
    expect((await registerWhile(holdWindowLock)).status).toBe(503)
    await register(FEED_A, "React posts").expect(201)
    expect((await feedRows()).map((row) => row.url)).toEqual([FEED_A])
  })
})
