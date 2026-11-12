import { randomUUID } from "node:crypto"

import type { INestApplication } from "@nestjs/common"
import { type Kysely, sql } from "kysely"
import { Migrator } from "kysely/migration"
import pg from "pg"
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest"

import { CandidateScope } from "../src/db/candidate-scope.js"
import { createDatabase } from "../src/db/create-database.js"
import { migrationsFor } from "../src/db/migrations/index.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { StackPostsSummaryReader } from "../src/stack-posts/stack-posts-summary.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import {
  HFEED_A,
  HFEED_A_DIGITS,
  HFEED_B,
  HIRING_FEEDS_PATH,
  HIRING_POSTS_PATH,
  type HiringFeedsBody,
  type HiringPostsBody,
  PHASE3_TABLES,
  clearPhase3,
  insertHiringFeed,
  insertHiringPosts,
  setHiringVerification,
  setOwnStackVerification,
  signInBoth,
} from "./support/qa-hiring-feeds.js"
import type { SignedInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * QA-authored (EPIC-0007 Phase 3, run epic-0007-p3, test authoring).
 * Cross-Candidate isolation of the four Phase 3 tables through the routes, the
 * daily summary reader and forced row-level security with no Candidate set;
 * the posts list (paging, totals, order); and the migration's no-backfill rule
 * (D16). hiring-alert-feeds.feature r4 HAF:619, :665, :990 to :1030;
 * hiring-posts.feature r4 HP:221 to :348; daily-summary-hiring.feature r4
 * DSH:222 to :289. Fixtures only; no feed is fetched.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let ada: SignedInCandidate
let bola: SignedInCandidate
let bolaId: string
let runtime: pg.Client
const clock = new TestClock("2026-10-24T19:00:00.000Z") // 20:00 WAT

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  ;({ ada, bola, bolaId } = await signInBoth(app, google, database.db))
  runtime = new pg.Client({ connectionString: database.url })
  await runtime.connect()
})

beforeEach(async () => {
  clock.set("2026-10-24T19:00:00.000Z")
  await clearPhase3(database.db)
})

afterAll(async () => {
  await runtime?.end()
  await app?.close()
  google?.close()
  await database?.stop()
})

/** Runs `work` on the runtime role in one transaction scoped to `candidateId` (null: no scope set). */
async function asRuntime<T>(candidateId: string | null, work: (client: pg.Client) => Promise<T>): Promise<T> {
  await runtime.query("begin")
  try {
    // EPIC-0002 A2 (migration 0022-candidate-binding): a Candidate scope is the setting AND the transaction's binding, as TenantDatabase sets both.
    if (candidateId) await runtime.query("select set_config('eve.candidate_id', $1, true), public.bind_candidate($1::uuid)", [candidateId])
    else if (candidateId !== null) await runtime.query("select set_config('eve.candidate_id', $1, true)", [candidateId])
    return await work(runtime)
  } finally {
    await runtime.query("rollback")
  }
}

const count = async (client: pg.Client, table: string) => Number((await client.query<{ n: string }>(`select count(*) as n from ${pg.escapeIdentifier(table)}`)).rows[0]?.n ?? 0)

describe("forced row-level security on the four Phase 3 tables (HAF:665, :1007; HP:341)", () => {
  it("every Phase 3 table has RLS enabled and forced, with exactly one Candidate policy", async () => {
    const { rows } = await sql<{ relname: string; enabled: boolean; forced: boolean; policies: number }>`
      select c.relname, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
             (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = any(${[...PHASE3_TABLES]})
       order by c.relname`.execute(database.db)
    expect(rows).toEqual([...PHASE3_TABLES].sort().map((relname) => ({ relname, enabled: true, forced: true, policies: 1 })))
  })

  it("scoped to Bola she reads only her rows; with no Candidate id set every table reads empty", async () => {
    await setHiringVerification(database.db, database.operatorId, "2026-10-01", "Ada's basis")
    await setHiringVerification(database.db, bolaId, "2026-10-21", "Bola's basis")
    const adaFeed = await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    await insertHiringFeed(database.db, database.operatorId, HFEED_B)
    await insertHiringFeed(database.db, bolaId, HFEED_A)
    await insertHiringFeed(database.db, bolaId, HFEED_B)
    await insertHiringPosts(database.db, database.operatorId, 3, { sourceFeedId: adaFeed })
    await insertHiringPosts(database.db, bolaId, 2)
    for (const id of [database.operatorId, bolaId]) {
      await sql`insert into hiring_post_run (candidate_id, id, started_at, finished_at, outcome) values (${id}::uuid, ${randomUUID()}::uuid, now(), now(), 'completed')`.execute(database.db)
    }

    await asRuntime(bolaId, async (client) => {
      expect(await count(client, "hiring_feed_verification")).toBe(1)
      expect((await client.query("select verification_basis from hiring_feed_verification")).rows).toEqual([{ verification_basis: "Bola's basis" }])
      expect(await count(client, "hiring_alert_feed")).toBe(2)
      expect(await count(client, "hiring_post")).toBe(2)
      expect(await count(client, "hiring_post_run")).toBe(1)
    })
    await asRuntime(null, async (client) => {
      for (const table of PHASE3_TABLES) expect(await count(client, table), table).toBe(0)
    })
    await asRuntime("", async (client) => {
      for (const table of PHASE3_TABLES) expect(await count(client, table), `${table} with an empty scope`).toBe(0)
    })
  })

  it("a write in Bola's scope that names Ada's Candidate id is refused, for every table", async () => {
    const adaFeed = await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    const writes: [string, string, unknown[]][] = [
      ["hiring_feed_verification", "insert into hiring_feed_verification (candidate_id, verified_on, verification_basis, updated_at) values ($1, '2026-10-21', 'x', now())", [database.operatorId]],
      ["hiring_alert_feed", "insert into hiring_alert_feed (candidate_id, id, url, label, created_at) values ($1, gen_random_uuid(), $2, null, now())", [database.operatorId, HFEED_B]],
      ["hiring_post", "insert into hiring_post (candidate_id, id, canonical_url, kind, first_seen_at) values ($1, gen_random_uuid(), 'https://www.linkedin.com/posts/x', 'post', now())", [database.operatorId]],
      ["hiring_post_run", "insert into hiring_post_run (candidate_id, id, started_at, outcome) values ($1, gen_random_uuid(), now(), 'running')", [database.operatorId]],
    ]
    for (const [table, statement, params] of writes) {
      await asRuntime(bolaId, async (client) => {
        await expect(client.query(statement, params), table).rejects.toThrow(/row-level security|violates/)
      })
    }
    // Updating or deleting Ada's feed from Bola's scope touches nothing.
    await asRuntime(bolaId, async (client) => {
      expect((await client.query("update hiring_alert_feed set label = 'x' where id = $1", [adaFeed])).rowCount).toBe(0)
      expect((await client.query("delete from hiring_alert_feed where id = $1", [adaFeed])).rowCount).toBe(0)
    })
  })

  it("a Hiring post cannot name another Candidate's feed as its source (composite foreign key)", async () => {
    const adaFeed = await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    await expect(
      sql`insert into hiring_post (candidate_id, id, canonical_url, kind, first_seen_at, source_feed_id)
          values (${bolaId}::uuid, ${randomUUID()}::uuid, 'https://www.linkedin.com/posts/k8', 'post', now(), ${adaFeed}::uuid)`.execute(database.db)
    ).rejects.toThrow(/foreign key/)
  })
})

describe("routes return only the caller's rows (HAF:990, :1015, :1022, :1030; HP:309, :334)", () => {
  beforeEach(async () => {
    await setHiringVerification(database.db, database.operatorId, "2026-10-01", "Ada's basis")
    await setHiringVerification(database.db, bolaId, "2026-10-21", "Bola's basis")
  })

  it("HAF:990/:1015 Bola sees only her own feeds; Ada's failing feed and label never appear", async () => {
    await insertHiringFeed(database.db, database.operatorId, HFEED_A, { label: "Ada frontend hiring", failing: "timed_out" })
    await insertHiringFeed(database.db, bolaId, HFEED_B, { label: "Bola backend hiring" })
    const body = (await bola.get(HIRING_FEEDS_PATH).expect(200)).body as HiringFeedsBody
    expect(body.feeds.map((f) => [f.label, f.failure])).toEqual([["Bola backend hiring", null]])
    expect(JSON.stringify(body)).not.toContain("Ada")
  })

  it("HAF:1022 the same URL for two Candidates is two rows, each with its own state", async () => {
    await insertHiringFeed(database.db, database.operatorId, HFEED_A, { label: "Ada", failing: "redirected" })
    await insertHiringFeed(database.db, bolaId, HFEED_A, { label: "Bola" })
    const a = (await ada.get(HIRING_FEEDS_PATH).expect(200)).body as HiringFeedsBody
    const b = (await bola.get(HIRING_FEEDS_PATH).expect(200)).body as HiringFeedsBody
    expect(a.feeds.map((f) => [f.label, f.failure?.reason ?? null])).toEqual([["Ada", "redirected"]])
    expect(b.feeds.map((f) => [f.label, f.failure?.reason ?? null])).toEqual([["Bola", null]])
    expect(a.feeds[0]!.id).not.toBe(b.feeds[0]!.id)
    expect(JSON.stringify([a, b])).not.toContain(HFEED_A_DIGITS)
  })

  it("HP:309/:334 totalCount and items count only the session Candidate's Hiring posts", async () => {
    await insertHiringPosts(database.db, database.operatorId, 70, { prefix: "ada" })
    await insertHiringPosts(database.db, bolaId, 3, { prefix: "bola" })
    const body = (await bola.get(HIRING_POSTS_PATH).expect(200)).body as HiringPostsBody
    expect(body).toMatchObject({ page: 1, pageSize: 50, totalCount: 3, totalPages: 1 })
    expect(body.items.every((item) => item.title.startsWith("bola"))).toBe(true)
  })

  it("HAF:1030 no session: both GET routes are 401 unauthenticated", async () => {
    const supertest = (await import("supertest")).default
    for (const path of [HIRING_FEEDS_PATH, HIRING_POSTS_PATH]) {
      const response = await supertest(app.getHttpServer()).get(path).expect(401)
      expect(response.body).toEqual({ error: { code: "unauthenticated", message: "Sign in to continue." } })
    }
  })

  it("HP:348 Hiring posts never appear in the Stack posts list and Stack posts never in the Hiring list", async () => {
    const POST_1 = "https://www.linkedin.com/posts/acme_hiring-activity-7250000000000000001-aaaa"
    const POST_2 = "https://www.linkedin.com/posts/beta_frontend-activity-7250000000000000002-bbbb"
    await insertHiringPosts(database.db, database.operatorId, 1, { title: () => "Hiring one" })
    await sql`update hiring_post set canonical_url = ${POST_1}`.execute(database.db)
    await database.db
      .insertInto("stack_post")
      .values({ candidate_id: database.operatorId, id: randomUUID(), canonical_url: POST_2, kind: "post", title: "Stack one", snippet: "s", published_at: null, matched_technologies: [], source_feed_id: null, first_seen_at: new Date() })
      .execute()
    const hiring = (await ada.get(HIRING_POSTS_PATH).expect(200)).body as HiringPostsBody
    const stack = (await ada.get("/v1/stack-posts").expect(200)).body as HiringPostsBody
    expect(hiring.items.map((i) => i.canonicalUrl)).toEqual([POST_1])
    expect(stack.items.map((i) => i.canonicalUrl)).toEqual([POST_2])
  })
})

describe("posts list paging and order (HP:221 to :315)", () => {
  it.each([
    [0, 0],
    [1, 1],
    [51, 2],
    [2000, 40],
  ])("HP:296 %i posts: totalPages %i", async (n, pages) => {
    if (n > 0) {
      const rows = Array.from({ length: n }, (_, i) => sql`(${database.operatorId}::uuid, gen_random_uuid(), ${`https://www.linkedin.com/posts/bulk-${i}`}, 'post', ${new Date(Date.UTC(2026, 9, 1) + i * 1000)})`)
      for (let i = 0; i < rows.length; i += 500) {
        await sql`insert into hiring_post (candidate_id, id, canonical_url, kind, first_seen_at) values ${sql.join(rows.slice(i, i + 500))}`.execute(database.db)
      }
    }
    expect((await ada.get(HIRING_POSTS_PATH).expect(200)).body).toMatchObject({ totalCount: n, totalPages: pages, pageSize: 50, page: 1 })
  })

  it("HP:277 120 posts: 50, 50, 20 across three pages in list order; page 4 is empty with true totals", async () => {
    await insertHiringPosts(database.db, database.operatorId, 120, { title: (i) => `P${String(i).padStart(3, "0")}` })
    const pages = await Promise.all([1, 2, 3, 4].map(async (p) => (await ada.get(`${HIRING_POSTS_PATH}?page=${p}`).expect(200)).body as HiringPostsBody))
    expect(pages.map((p) => p.items.length)).toEqual([50, 50, 20, 0])
    expect(pages[0]!.items[0]!.title).toBe("P119")
    expect(pages[2]!.items.at(-1)!.title).toBe("P000")
    expect(pages[3]).toMatchObject({ page: 4, totalCount: 120, totalPages: 3 })
  })

  it.each(["0", "-1", "abc", "1.5", "01", "1e3", "1234567890"])("HP:315 ?page=%s is 400 page/invalid", async (value) => {
    const response = await ada.get(`${HIRING_POSTS_PATH}?page=${encodeURIComponent(value)}`).expect(400)
    expect(response.body).toEqual({ error: { code: "bad_request", message: "The request is not valid.", fieldErrors: [{ field: "page", position: null, problem: "invalid" }] } })
  })

  it("HP:221/:227 order: published (else first-seen) desc, then first-seen desc", async () => {
    const at = (iso: string) => new Date(iso)
    await sql`insert into hiring_post (candidate_id, id, canonical_url, kind, title, published_at, first_seen_at) values
      (${database.operatorId}::uuid, gen_random_uuid(), 'https://www.linkedin.com/posts/d22', 'post', '22', ${at("2026-10-22T08:00:00Z")}, ${at("2026-10-24T08:00:00Z")}),
      (${database.operatorId}::uuid, gen_random_uuid(), 'https://www.linkedin.com/posts/d24', 'post', '24', ${at("2026-10-24T08:00:00Z")}, ${at("2026-10-24T08:00:00Z")}),
      (${database.operatorId}::uuid, gen_random_uuid(), 'https://www.linkedin.com/posts/d23', 'post', '23', ${at("2026-10-23T08:00:00Z")}, ${at("2026-10-24T08:00:00Z")}),
      (${database.operatorId}::uuid, gen_random_uuid(), 'https://www.linkedin.com/posts/t1', 'post', 'tie-first', ${at("2026-10-21T08:00:00Z")}, ${at("2026-10-24T08:00:00Z")}),
      (${database.operatorId}::uuid, gen_random_uuid(), 'https://www.linkedin.com/posts/t2', 'post', 'tie-second', ${at("2026-10-21T08:00:00Z")}, ${at("2026-10-24T09:00:00Z")})`.execute(database.db)
    const body = (await ada.get(HIRING_POSTS_PATH).expect(200)).body as HiringPostsBody
    expect(body.items.map((i) => i.title)).toEqual(["24", "23", "22", "tie-second", "tie-first"])
  })

  it("the list is available without the caller's record and during both pauses (lists whatever is stored)", async () => {
    await insertHiringPosts(database.db, database.operatorId, 2)
    await database.db.updateTable("control_state").set({ global_paused: true, cost_paused: true }).execute()
    expect(((await ada.get(HIRING_POSTS_PATH).expect(200)).body as HiringPostsBody).totalCount).toBe(2)
  })
})

describe("daily summary reader: each Candidate's own gate and rows (DSH:222 to :289; AC 9.1, 6.5)", () => {
  type HiringSummary = { verified: boolean; hiringVerified: boolean; hiringNewPosts: { title: string }[]; hiringNewCount: number; failingHiringFeeds: { label: string | null; maskedUrl: string }[] }
  const reader = () => new StackPostsSummaryReader(app.get(TenantDatabase))
  const summaryFor = (candidateId: string) => CandidateScope.run(candidateId, () => reader().summary(randomUUID(), clock.now())) as unknown as Promise<HiringSummary>
  const inWindow = (i: number) => new Date(Date.parse("2026-10-24T10:00:00Z") + i * 60_000)

  it("DSH:258/:279 Bola's summary lists only her Hiring posts and failing feeds; Ada's never appear", async () => {
    await setHiringVerification(database.db, database.operatorId)
    await setHiringVerification(database.db, bolaId)
    await insertHiringFeed(database.db, database.operatorId, HFEED_A, { label: "Ada hiring", failing: "timed_out" })
    await insertHiringPosts(database.db, database.operatorId, 1, { title: () => "ADA-POST", firstSeen: inWindow })
    await insertHiringPosts(database.db, bolaId, 1, { title: () => "BOLA-POST", firstSeen: inWindow })
    const summary = await summaryFor(bolaId)
    expect(summary).toMatchObject({ hiringVerified: true, hiringNewCount: 1, failingHiringFeeds: [] })
    expect(summary.hiringNewPosts.map((p) => p.title)).toEqual(["BOLA-POST"])
    expect(JSON.stringify(summary)).not.toContain("Ada hiring")
  })

  it("DSH:249 Ada's record does not add the Hiring part to Bola's summary", async () => {
    await setHiringVerification(database.db, database.operatorId)
    await insertHiringPosts(database.db, bolaId, 1, { firstSeen: inWindow })
    expect(await summaryFor(bolaId)).toMatchObject({ hiringVerified: false, hiringNewPosts: [], hiringNewCount: 0, failingHiringFeeds: [] })
  })

  it("DSH:258 Bola's missing record does not remove the Hiring part from Ada's summary", async () => {
    await setHiringVerification(database.db, database.operatorId)
    await insertHiringPosts(database.db, database.operatorId, 3, { firstSeen: inWindow })
    expect(await summaryFor(database.operatorId)).toMatchObject({ hiringVerified: true, hiringNewCount: 3 })
  })

  it.each([true, false])("DSH:222 own Stack posts record %s and no own Hiring record: Hiring part left out; Stack posts gate follows her own Stack posts record (EPIC-0008)", async (shared) => {
    await setOwnStackVerification(database.db, database.operatorId, shared)
    await insertHiringFeed(database.db, database.operatorId, HFEED_A, { failing: "timed_out" })
    await insertHiringPosts(database.db, database.operatorId, 2, { firstSeen: inWindow })
    expect(await summaryFor(database.operatorId)).toMatchObject({ verified: shared, hiringVerified: false, hiringNewPosts: [], hiringNewCount: 0, failingHiringFeeds: [] })
  })

  it("DSH:238 own Hiring record and no Stack posts record of her own: Hiring part present, Stack posts parts gated off", async () => {
    await setHiringVerification(database.db, bolaId)
    await insertHiringPosts(database.db, bolaId, 2, { firstSeen: inWindow })
    expect(await summaryFor(bolaId)).toMatchObject({ verified: false, hiringVerified: true, hiringNewCount: 2 })
  })

  it("HAF:619 the summary never carries either basis", async () => {
    await setHiringVerification(database.db, database.operatorId, "2026-10-01", "Ada's basis")
    await setHiringVerification(database.db, bolaId, "2026-10-21", "Bola's basis")
    const text = JSON.stringify([await summaryFor(database.operatorId), await summaryFor(bolaId)])
    expect(text).not.toContain("Ada's basis")
    expect(text).not.toContain("Bola's basis")
  })
})

describe("migration NNNN-hiring-posts: no backfill (HAF:717; D16)", () => {
  const OWNER_SUB = "google-sub-ada-hiring-p3"
  // EPIC-0008 (merge with A2): the whole chain runs, so 0024 is checked too: it copies the shared row into the Operator's
  // Stack posts record (stack-feed-migration tests), never into a Hiring record.
  const ALL = migrationsFor({ operatorGoogleSub: OWNER_SUB })
  const hiringName = Object.keys(ALL).find((name) => name.endsWith("-hiring-posts"))
  type Db = Kysely<unknown>
  let cluster: Db
  const opened: { name: string; db: Db }[] = []

  beforeAll(() => {
    cluster = createDatabase(inject("postgresAdminUrl")) as unknown as Db
  })

  afterAll(async () => {
    for (const { name, db } of opened) {
      await db.destroy()
      await sql`drop database if exists ${sql.id(name)} with (force)`.execute(cluster)
    }
    await cluster?.destroy()
  })

  it("the Phase 3 migration exists, is followed only by A2's 0022 and 0023, EPIC-0008's 0024, apply anyway's 0025 and 0026, B1's 0027, EPIC-0010's 0028 to 0031, stuck checking's 0032, EPIC-0011's 0033 and EPIC-0012's 0034, and copies the Operator's shared record into no Hiring record", async () => {
    expect(hiringName, "a migration named NNNN-hiring-posts (api-contract.r1 Migration)").toBeDefined()
    // Run a2i (D19, later-merging branch renumbers): EPIC-0002 A2's two migrations follow it, then EPIC-0008's 0024, apply anyway's 0025 and 0026, then EPIC-0002 B1's 0027.
    expect(Object.keys(ALL).sort().filter((n) => n > hiringName!)).toEqual(["0022-candidate-binding", "0023-runtime-no-temporary", "0024-alert-feed-candidate-verification", "0025-apply-anyway", "0026-apply-anyway-bounds", "0027-preferences-version", "0028-ats-skills", "0029-ats-fit", "0030-ats-minimum", "0031-pasted-description", "0032-stuck-checking", "0033-simplify-eve", "0034-forward-statements", "0035-manual-apply-lane", "0036-retry-failed-checks", "0037-retry-backfill", "0038-lead-pipeline", "0039-blocked-claim-cause", "0040-outreach-messages", "0041-lead-policy-binding"])
    const name = `ja_hp_mig_${randomUUID().replaceAll("-", "").slice(0, 16)}`
    await sql`create database ${sql.id(name)}`.execute(cluster)
    const url = new URL(inject("postgresAdminUrl"))
    url.pathname = `/${name}`
    const db = createDatabase(url.toString()) as unknown as Db
    opened.push({ name, db })
    const before = Object.fromEntries(Object.entries(ALL).filter(([n]) => n < hiringName!))
    const first = await new Migrator({ db, provider: { getMigrations: async () => before } }).migrateToLatest()
    if (first.error) throw first.error
    // The Operator recorded the shared EPIC-0005 record before Phase 3 (2026-09-30).
    await sql`insert into alert_feed_verification (verified_on, verification_basis, updated_at) values ('2026-09-30', 'Operator basis before Phase 3', now())`.execute(db)
    const second = await new Migrator({ db, provider: { getMigrations: async () => ALL } }).migrateToLatest()
    if (second.error) throw second.error
    expect((await sql<{ n: number }>`select count(*)::int as n from hiring_feed_verification`.execute(db)).rows[0]?.n).toBe(0)
    expect((await sql<{ n: number }>`select count(*)::int as n from alert_feed_verification`.execute(db)).rows[0]?.n).toBe(1)
    for (const table of ["hiring_alert_feed", "hiring_post", "hiring_post_run"]) {
      expect((await sql<{ n: number }>`select count(*)::int as n from ${sql.table(table)}`.execute(db)).rows[0]?.n, table).toBe(0)
    }
  })
})
