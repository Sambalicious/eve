import { randomUUID } from "node:crypto"

import type { INestApplication } from "@nestjs/common"
import { ALERT_FEEDS_PATH, HIRING_ALERT_FEEDS_PATH, HIRING_FEED_VERIFICATION_PATH, apiErrorResponseSchema } from "@eve/contracts"
import { type Kysely, sql } from "kysely"
import { Migrator } from "kysely/migration"
import pg from "pg"
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import { HIRING_TABLES } from "../src/db/migrations/0021-hiring-posts.js"
import { migrationsFor } from "../src/db/migrations/index.js"
import type { Database } from "../src/db/schema.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { createAlertFeedHttp } from "../src/stack-posts/alert-feed-http.js"
import { FEED_REGISTRATION_LOCK_CLASS, SUMMARY_WINDOW_LOCK_KEY } from "../src/stack-posts/stack-posts.repository.js"
import { atomFeed } from "./support/alert-feed-fixtures.js"
import { Browser } from "./support/browser.js"
import { FakeFeedServer } from "./support/fake-feed-server.js"
import { FakeGoogle } from "./support/fake-google.js"
import { HFEED_A, HFEED_B, HIRING_AND_STACK_TABLES, hiringFeedUrl, insertHiringFeed, insertHiringPosts, recordOwn, recordOwnStack, signInBola } from "./support/hiring-fixtures.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0007 Phase 3 threat model r1 required checks 1, 4 (migration half), 8 and 9:
 * forced RLS and the copied stack_post policy on the four tables (P3-3, P3-16), no
 * backfill (D16), cascade on Candidate deletion, the per-Candidate transaction advisory
 * lock and the cross-list race (P3-4), the first-save race (HAF:730), and the 503 on a
 * lock wait (HAF:191). Real Postgres, runtime role; a local feed server; no live network.
 */
let database: TestDatabase
let runtime: Kysely<Database>
let google: FakeGoogle
let feeds: FakeFeedServer
let app: INestApplication
let ada: SignedInCandidate
let bola: SignedInCandidate
let bolaId: string
const clock = new TestClock("2026-10-24T09:00:00.000Z")

beforeAll(async () => {
  database = await startMigratedDatabase()
  runtime = createDatabase(database.url)
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  feeds = await FakeFeedServer.start()
  app = await createTestApp({ databaseUrl: database.url, clock, alertFeedHttp: createAlertFeedHttp({ testOrigin: feeds.origin, timeoutMs: 1_000, sleep: async () => undefined }) })
  const browser = new Browser(app, google)
  ada = await signInCandidate(browser)
  ;({ id: bolaId, session: bola } = await signInBola(database.db, browser))
})

beforeEach(async () => {
  feeds.reset()
  for (const table of HIRING_AND_STACK_TABLES) await database.db.deleteFrom(table).execute()
})

afterAll(async () => {
  await app?.close()
  await feeds?.close()
  google?.close()
  await runtime?.destroy()
  await database?.stop()
})

const ADA = () => database.operatorId
const tenant = () => new TenantDatabase(runtime)

describe("check 1: forced RLS and the copied stack_post policy on all four tables (P3-3a/c, P3-16b)", () => {
  it("each table enables and forces RLS and has exactly one <table>_candidate policy whose text equals stack_post_candidate", async () => {
    const { rows } = await sql<{ table: string; enabled: boolean; forced: boolean; policies: string[]; using: string[]; check: string[] }>`
      select c.relname as table, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
        array_agg(p.polname::text order by p.polname) as policies,
        array_agg(pg_get_expr(p.polqual, p.polrelid) order by p.polname) as using,
        array_agg(pg_get_expr(p.polwithcheck, p.polrelid) order by p.polname) as check
      from pg_class c join pg_policy p on p.polrelid = c.oid
      where c.relname in (${sql.join([...HIRING_TABLES, "stack_post"])})
      group by c.relname, c.relrowsecurity, c.relforcerowsecurity order by c.relname`.execute(database.db)
    const reference = rows.find((row) => row.table === "stack_post")!
    for (const table of HIRING_TABLES) {
      const row = rows.find((candidate) => candidate.table === table)
      expect(row, table).toBeDefined()
      expect({ enabled: row!.enabled, forced: row!.forced, policies: row!.policies }).toEqual({ enabled: true, forced: true, policies: [`${table}_candidate`] })
      expect(row!.using).toEqual(reference.using)
      expect(row!.check).toEqual(reference.check)
    }
  })

  it("HAF:670, HAF:1015, HP:341 the runtime role with no Candidate setting reads zero rows; a scoped session reads only its own", async () => {
    await recordOwn(database.db, ADA())
    await recordOwn(database.db, bolaId)
    for (const id of [ADA(), bolaId]) {
      await insertHiringFeed(database.db, id, HFEED_A)
      await insertHiringFeed(database.db, id, HFEED_B)
      await insertHiringPosts(database.db, id, [{}, {}])
      await database.db.insertInto("hiring_post_run").values({ candidate_id: id, id: randomUUID(), started_at: new Date(), finished_at: null, outcome: "running" }).execute()
    }
    for (const table of HIRING_TABLES) {
      const { rows } = await sql<{ n: number }>`select count(*)::int as n from ${sql.table(table)}`.execute(runtime)
      expect(rows[0]!.n, `${table} unscoped`).toBe(0)
    }
    const counts = await tenant().forCandidate(bolaId, async (trx) =>
      Object.fromEntries(await Promise.all(HIRING_TABLES.map(async (table) => [table, (await sql<{ n: number; mine: number }>`select count(*)::int as n, count(*) filter (where candidate_id = ${bolaId})::int as mine from ${sql.table(table)}`.execute(trx)).rows[0]]))) as Record<string, { n: number; mine: number }>
    )
    expect(counts).toEqual({
      hiring_alert_feed: { n: 2, mine: 2 },
      hiring_post: { n: 2, mine: 2 },
      hiring_post_run: { n: 1, mine: 1 },
      hiring_feed_verification: { n: 1, mine: 1 },
    })
  })

  it("HAF:670, P3-3c an insert into hiring_feed_verification without the setting, or naming another Candidate, is refused by the policy", async () => {
    await expect(sql`insert into hiring_feed_verification (candidate_id, verified_on, verification_basis, updated_at) values (${bolaId}, '2026-10-21', 'x', now())`.execute(runtime)).rejects.toThrow(/row-level security/)
    await expect(
      tenant().forCandidate(bolaId, (trx) => trx.insertInto("hiring_feed_verification").values({ candidate_id: ADA(), verified_on: "2026-10-21", verification_basis: "forged", updated_at: new Date() }).execute())
    ).rejects.toThrow(/row-level security/)
    expect(await database.db.selectFrom("hiring_feed_verification").selectAll().execute()).toEqual([])
  })

  it("an update in one Candidate's scope cannot touch another Candidate's verification row", async () => {
    await recordOwn(database.db, ADA(), "Ada's basis")
    const result = await tenant().forCandidate(bolaId, (trx) => trx.updateTable("hiring_feed_verification").set({ verification_basis: "forged" }).where("candidate_id", "=", ADA()).executeTakeFirst())
    expect(Number(result.numUpdatedRows)).toBe(0)
    expect((await database.db.selectFrom("hiring_feed_verification").select("verification_basis").executeTakeFirstOrThrow()).verification_basis).toBe("Ada's basis")
  })

  it("the composite FK refuses a Hiring post pointing at another Candidate's feed", async () => {
    const feedId = await insertHiringFeed(database.db, ADA(), HFEED_A)
    await expect(insertHiringPosts(database.db, bolaId, [{ feedId }])).rejects.toThrow(/hiring_post_source_feed_fk/)
  })

  it("the url and canonical_url checks repeat the patterns (P3-1e, P3-2c)", async () => {
    await expect(insertHiringFeed(database.db, ADA(), "https://www.google.com/search?q=hiring")).rejects.toThrow(/hiring_alert_feed_url_check/)
    await expect(insertHiringPosts(database.db, ADA(), [{ canonicalUrl: "https://evil.example/posts/x" }])).rejects.toThrow(/hiring_post_canonical_url_check/)
  })
})

describe("check 9 and P3-16: the migration (no backfill, cascade, down)", () => {
  it("HAF:722, P3-16c with an existing EPIC-0005 shared record, 0021 leaves hiring_feed_verification empty", async () => {
    const cluster = createDatabase(inject("postgresAdminUrl")) as unknown as Kysely<unknown>
    const name = `ja_hiring_${randomUUID().replaceAll("-", "").slice(0, 16)}`
    await sql`create database ${sql.id(name)}`.execute(cluster)
    const url = new URL(inject("postgresAdminUrl"))
    url.pathname = `/${name}`
    const db = createDatabase(url.toString()) as unknown as Kysely<unknown>
    try {
      // Run a2i (D19): EPIC-0002 A2's 0022 and 0023 follow 0021 now; this case tests 0021 and its `down`, so it stops at 0021 (EPIC-0008's 0024 copies the shared row; its own test covers that).
      const all = Object.fromEntries(Object.entries(migrationsFor({ operatorGoogleSub: undefined })).filter(([key]) => key <= "0021-hiring-posts"))
      const before = Object.fromEntries(Object.entries(all).filter(([key]) => key < "0021-hiring-posts"))
      expect((await new Migrator({ db, provider: { getMigrations: async () => before } }).migrateToLatest()).error).toBeUndefined()
      await sql`insert into alert_feed_verification (verified_on, verification_basis, updated_at) values ('2026-09-30', 'Shared before Phase 3', now())`.execute(db)
      const migrator = new Migrator({ db, provider: { getMigrations: async () => all } })
      const { error, results } = await migrator.migrateToLatest()
      expect(error).toBeUndefined()
      expect(results?.map((result) => result.migrationName)).toEqual(["0021-hiring-posts"])
      expect((await sql<{ n: number }>`select count(*)::int as n from hiring_feed_verification`.execute(db)).rows[0]!.n).toBe(0)
      expect((await sql<{ n: number }>`select count(*)::int as n from alert_feed_verification`.execute(db)).rows[0]!.n).toBe(1)
      expect((await sql<{ name: string }>`select name from migration_marker where name = '0021-hiring-posts'`.execute(db)).rows).toHaveLength(1)
      // down drops only the four hiring tables.
      const down = await migrator.migrateDown()
      expect(down.error).toBeUndefined()
      const { rows } = await sql<{ name: string }>`select tablename as name from pg_tables where schemaname = 'public' and tablename like '%hiring%' or tablename in ('alert_feed', 'stack_post', 'stack_post_run', 'alert_feed_verification') order by 1`.execute(db)
      expect(rows.map((row) => row.name)).toEqual(["alert_feed", "alert_feed_verification", "stack_post", "stack_post_run"])
    } finally {
      await db.destroy()
      await sql`drop database if exists ${sql.id(name)} with (force)`.execute(cluster)
      await cluster.destroy()
    }
  })

  it("P3-16d deleting a Candidate removes their rows in all four tables", async () => {
    const id = (await database.db.insertInto("candidate").values({ email: "gone@example.test", google_sub: "sub-gone", role: "candidate" } as never).returning("id").executeTakeFirstOrThrow()).id
    await recordOwn(database.db, id)
    const feedId = await insertHiringFeed(database.db, id, HFEED_A)
    await insertHiringPosts(database.db, id, [{ feedId }])
    await database.db.insertInto("hiring_post_run").values({ candidate_id: id, id: randomUUID(), started_at: new Date(), finished_at: null, outcome: "running" }).execute()
    await database.db.deleteFrom("candidate").where("id", "=", id).execute()
    for (const table of HIRING_TABLES) expect(await database.db.selectFrom(table).select("candidate_id").where("candidate_id", "=", id).execute(), table).toEqual([])
  })
})

describe("check 8: the per-Candidate transaction advisory lock (P3-4)", () => {
  it("FEED_REGISTRATION_LOCK_CLASS is an int4 distinct from every other advisory key in the repo", () => {
    expect(Number.isInteger(FEED_REGISTRATION_LOCK_CLASS)).toBe(true)
    expect(FEED_REGISTRATION_LOCK_CLASS).toBeLessThan(2 ** 31)
    expect(FEED_REGISTRATION_LOCK_CLASS).not.toBe(SUMMARY_WINDOW_LOCK_KEY)
    expect([72_000_002, 72_000_914, 72_005_001, 72_006]).not.toContain(FEED_REGISTRATION_LOCK_CLASS)
  })

  it("HAF:180, HAF:191, P3-4b one URL sent to both lists at once, 50 rounds: exactly one list each time, the other in_other_list, no 500", async () => {
    await recordOwn(database.db, ADA())
    await recordOwnStack(database.db, ADA())
    feeds.on(HFEED_A, { kind: "body", body: atomFeed([]) })
    for (let round = 0; round < 50; round++) {
      const [stack, hiring] = await Promise.all([ada.post(ALERT_FEEDS_PATH).send({ url: HFEED_A, label: null }), ada.post(HIRING_ALERT_FEEDS_PATH).send({ url: HFEED_A, label: null })])
      const statuses = [stack.status, hiring.status].sort()
      if (statuses.includes(503)) {
        for (const response of [stack, hiring].filter((item) => item.status === 503)) expect(response.headers["retry-after"]).toBe("5")
      } else {
        expect(statuses, `round ${round}`).toEqual([201, 400])
        const refused = stack.status === 400 ? stack : hiring
        expect(apiErrorResponseSchema.parse(refused.body).error.fieldErrors).toEqual([{ field: "url", position: null, problem: "in_other_list" }])
      }
      const inStack = await database.db.selectFrom("alert_feed").select("id").where("url", "=", HFEED_A).execute()
      const inHiring = await database.db.selectFrom("hiring_alert_feed").select("id").where("url", "=", HFEED_A).execute()
      expect(inStack.length + inHiring.length, `round ${round}`).toBeLessThanOrEqual(1)
      if (!statuses.includes(503)) expect(inStack.length + inHiring.length).toBe(1)
      await database.db.deleteFrom("alert_feed").execute()
      await database.db.deleteFrom("hiring_alert_feed").execute()
    }
  }, 120_000)

  it("P3-4b with a barrier: both requests pass the pre-checks while the lock is held, then exactly one wins", async () => {
    await recordOwn(database.db, ADA())
    await recordOwnStack(database.db, ADA())
    feeds.on(HFEED_A, { kind: "body", body: atomFeed([]) })
    const client = new pg.Client({ connectionString: database.adminUrl })
    await client.connect()
    try {
      await client.query("begin")
      await client.query("select pg_advisory_xact_lock($1::int, hashtext($2::text))", [FEED_REGISTRATION_LOCK_CLASS, ADA()])
      const pending = Promise.all([ada.post(ALERT_FEEDS_PATH).send({ url: HFEED_A, label: null }), ada.post(HIRING_ALERT_FEEDS_PATH).send({ url: HFEED_A, label: null })])
      await untilWaiters(2)
      await client.query("commit")
      const [stack, hiring] = await pending
      expect([stack.status, hiring.status].sort()).toEqual([201, 400])
      expect(feeds.requestsTo(HFEED_A)).toBe(2)
    } finally {
      await client.end()
    }
  })

  it("HAF:307 two registrations for the 10th slot leave exactly 10; the other is limit_reached", async () => {
    await recordOwn(database.db, ADA())
    for (let n = 0; n < 9; n++) await insertHiringFeed(database.db, ADA(), hiringFeedUrl(n))
    feeds.on(hiringFeedUrl(100), { kind: "body", body: atomFeed([]) })
    feeds.on(hiringFeedUrl(101), { kind: "body", body: atomFeed([]) })
    const responses = await Promise.all([ada.post(HIRING_ALERT_FEEDS_PATH).send({ url: hiringFeedUrl(100), label: null }), ada.post(HIRING_ALERT_FEEDS_PATH).send({ url: hiringFeedUrl(101), label: null })])
    expect(responses.map((response) => response.status).sort()).toEqual([201, 400])
    expect(apiErrorResponseSchema.parse(responses.find((response) => response.status === 400)!.body).error.fieldErrors).toEqual([{ field: "url", position: null, problem: "limit_reached" }])
    expect(await database.db.selectFrom("hiring_alert_feed").select("id").where("candidate_id", "=", ADA()).execute()).toHaveLength(10)
  })

  it("HAF:855 a double submit stores one feed; the other is duplicate", async () => {
    await recordOwn(database.db, ADA())
    feeds.on(HFEED_A, { kind: "body", body: atomFeed([]) })
    const responses = await Promise.all([ada.post(HIRING_ALERT_FEEDS_PATH).send({ url: HFEED_A, label: null }), ada.post(HIRING_ALERT_FEEDS_PATH).send({ url: HFEED_A, label: null })])
    expect(responses.map((response) => response.status).sort()).toEqual([201, 400])
    expect(await database.db.selectFrom("hiring_alert_feed").select("id").execute()).toHaveLength(1)
  })

  it("HAF:738, P3-4c registrations of different Candidates do not wait on each other's lock", async () => {
    await recordOwn(database.db, ADA())
    await recordOwn(database.db, bolaId)
    feeds.on(HFEED_A, { kind: "body", body: atomFeed([]) })
    feeds.on(HFEED_B, { kind: "body", body: atomFeed([]) })
    const client = new pg.Client({ connectionString: database.adminUrl })
    await client.connect()
    try {
      await client.query("begin")
      await client.query("select pg_advisory_xact_lock($1::int, hashtext($2::text))", [FEED_REGISTRATION_LOCK_CLASS, ADA()])
      // ada's lock is held: bola's registration of the same URL (a Stack-list URL of ada's would not matter either) completes at once.
      const started = Date.now()
      await bola.post(HIRING_ALERT_FEEDS_PATH).send({ url: HFEED_A, label: null }).expect(201)
      expect(Date.now() - started).toBeLessThan(2_500)
      await client.query("rollback")
    } finally {
      await client.end()
    }
  })

  it("HAF:191, P3-4 a lock wait past 3 s answers 503 service_unavailable with Retry-After 5 and stores nothing", async () => {
    await recordOwn(database.db, ADA())
    feeds.on(HFEED_A, { kind: "body", body: atomFeed([]) })
    const client = new pg.Client({ connectionString: database.adminUrl })
    await client.connect()
    try {
      await client.query("begin")
      await client.query("select pg_advisory_xact_lock($1::int, hashtext($2::text))", [FEED_REGISTRATION_LOCK_CLASS, ADA()])
      const response = await ada.post(HIRING_ALERT_FEEDS_PATH).send({ url: HFEED_A, label: null })
      expect(response.status).toBe(503)
      expect(response.headers["retry-after"]).toBe("5")
      expect(response.body).toEqual({ error: { code: "service_unavailable", message: "The service is unavailable. Try again shortly." } })
      await client.query("rollback")
    } finally {
      await client.end()
    }
    expect(await database.db.selectFrom("hiring_alert_feed").select("id").execute()).toEqual([])
  })

  it("P3-4d the lock is transaction-scoped: none is left held after a registration", async () => {
    await recordOwn(database.db, ADA())
    feeds.on(HFEED_A, { kind: "body", body: atomFeed([]) })
    await ada.post(HIRING_ALERT_FEEDS_PATH).send({ url: HFEED_A, label: null }).expect(201)
    // pg_locks is cluster-wide and other integration files share this Postgres server, holding this lock class in their own databases.
    // Scope to this file's database: every session connected to it (the app's pool and this file's clients) belongs to this file.
    const { rows } = await sql<{ n: number }>`select count(*)::int as n from pg_locks where locktype = 'advisory' and classid = ${FEED_REGISTRATION_LOCK_CLASS}::oid and database = (select oid from pg_database where datname = current_database())`.execute(database.db)
    expect(rows[0]!.n).toBe(0)
  })

  it("HAF:730 a registration racing the first permitted-use save never stores a feed without the record", async () => {
    feeds.on(HFEED_A, { kind: "body", body: atomFeed([]) })
    for (let round = 0; round < 10; round++) {
      const [saved, registered] = await Promise.all([
        bola.put(HIRING_FEED_VERIFICATION_PATH).send({ verifiedOn: "2026-10-21", verificationBasis: "Read terms." }),
        bola.post(HIRING_ALERT_FEEDS_PATH).send({ url: HFEED_A, label: null }),
      ])
      expect(saved.status).toBe(200)
      expect([201, 409]).toContain(registered.status)
      const feedsNow = await database.db.selectFrom("hiring_alert_feed").select("id").where("candidate_id", "=", bolaId).execute()
      const record = await database.db.selectFrom("hiring_feed_verification").select("candidate_id").where("candidate_id", "=", bolaId).execute()
      if (feedsNow.length > 0) expect(record).toHaveLength(1)
      await database.db.deleteFrom("hiring_alert_feed").execute()
      await database.db.deleteFrom("hiring_feed_verification").execute()
    }
  })

  /** Waits until `n` backends wait on an advisory lock of the registration class. */
  async function untilWaiters(n: number): Promise<void> {
    const deadline = Date.now() + 10_000
    for (;;) {
      const { rows } = await sql<{ n: number }>`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted and classid = ${FEED_REGISTRATION_LOCK_CLASS}::oid`.execute(database.db)
      if (rows[0]!.n >= n) return
      if (Date.now() > deadline) throw new Error(`fewer than ${n} registrations reached the lock`)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
})
