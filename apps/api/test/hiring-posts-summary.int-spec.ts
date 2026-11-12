import { randomUUID } from "node:crypto"

import type { INestApplicationContext } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { type Kysely, sql } from "kysely"
import pg from "pg"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { anthropicConfig } from "../src/config/env.js"
import { CandidateScope } from "../src/db/candidate-scope.js"
import { createDatabase } from "../src/db/create-database.js"
import type { Database } from "../src/db/schema.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { GmailSmtpMailer } from "../src/notification/mailer.js"
import { type MailerConfig, mailerConfig } from "../src/notification/mailer-config.js"
import { NotificationSender } from "../src/notification/notification-sender.js"
import { NotificationWorkerModule } from "../src/notification/notification.module.js"
import { CLOCK } from "../src/shared/clock.js"
import { createAlertFeedHttp } from "../src/stack-posts/alert-feed-http.js"
import { HiringPostsReader } from "../src/stack-posts/hiring-posts-reader.js"
import { HiringPostsRepository } from "../src/stack-posts/hiring-posts.repository.js"
import { type StackPostsSummary, StackPostsSummaryReader } from "../src/stack-posts/stack-posts-summary.js"
import { atomFeed, googleRedirect } from "./support/alert-feed-fixtures.js"
import { FakeFeedServer } from "./support/fake-feed-server.js"
import { FakeSmtp, plainText as plainTextLatin1 } from "./support/fake-smtp.js"
import { HFEED_A, HFEED_A_DIGITS, HIRING_AND_STACK_TABLES, POST_1, insertHiringFeed, insertHiringPosts, insertStackFeed, recordOwn, recordOwnStack } from "./support/hiring-fixtures.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { PUBLIC_ORIGIN } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0007 Phase 3 daily summary against real Postgres (daily-summary-hiring.feature @phase3 r4;
 * api-contract.r1.md "Daily summary"; threat model P3-15): the reader's two gates (shared record →
 * Stack posts parts; the summary Candidate's own record → Hiring posts part), the EPIC-0005 window,
 * two Candidates, one sent email through the production sender and a fake SMTP server, and the
 * exactly-one-summary race for a Hiring post. Synthetic data; nothing reaches a real mail server.
 */
const SENDER = "ada.okafor@gmail.com"
const APP_PASSWORD = "abcdefghijklmnop"
let database: TestDatabase
let runtime: Kysely<Database>
let summaries: StackPostsSummaryReader
let smtp: FakeSmtp
let config: MailerConfig
let sender: INestApplicationContext
let bolaId: string
const clock = new TestClock("2026-10-24T20:00:00.000Z")
const plainText = (raw: string) => Buffer.from(plainTextLatin1(raw), "latin1").toString("utf8")

beforeAll(async () => {
  database = await startMigratedDatabase()
  runtime = createDatabase(database.url)
  summaries = new StackPostsSummaryReader(new TenantDatabase(runtime))
  bolaId = (await database.db.insertInto("candidate").values({ email: "bola@example.test", google_sub: "sub-bola", role: "candidate" } as never).returning("id").executeTakeFirstOrThrow()).id
  await database.db.insertInto("job_criteria").values({ candidate_id: bolaId, min_core_match_percent: 70 }).onConflict((oc) => oc.column("candidate_id").doNothing()).execute()
  smtp = new FakeSmtp(SENDER, APP_PASSWORD)
  await smtp.start()
  config = mailerConfig({ user: SENDER, to: SENDER, dashboardOrigin: PUBLIC_ORIGIN, transport: { host: "127.0.0.1", port: smtp.port, secure: false, ignoreTLS: true }, appPassword: APP_PASSWORD })
  const { ConfigModule } = await import("../src/config/config.module.js")
  const { DatabaseModule } = await import("../src/db/database.module.js")
  const { ClockModule } = await import("../src/shared/clock.js")
  sender = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ databaseUrl: database.url, statementTimeoutMs: 60_000, anthropic: anthropicConfig(undefined, "claude-haiku-5-5") }),
      ClockModule,
      DatabaseModule,
      NotificationWorkerModule.forRoot(config, { mailer: new GmailSmtpMailer(config, { connectionTimeout: 2_000, greetingTimeout: 2_000, socketTimeout: 1_500 }) }),
    ],
  })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile()
  await sender.init()
})

beforeEach(async () => {
  clock.set("2026-10-24T20:00:00.000Z")
  smtp.reset()
  for (const table of ["notification_outbox", ...HIRING_AND_STACK_TABLES, "ai_call", "spend_entry"] as const) await database.db.deleteFrom(table).execute()
  await database.db.updateTable("job_criteria").set({ frameworks: ["React"], technologies: ["TypeScript"] }).execute()
})

afterAll(async () => {
  await sender?.close()
  await smtp?.stop()
  await runtime?.destroy()
  await database?.stop()
})

const ADA = () => database.operatorId

async function summaryRow(candidateId: string, at: string, status: "sent" | "sending"): Promise<string> {
  const id = randomUUID()
  const day = new Date(new Date(at).getTime() + 3_600_000).toISOString().slice(0, 10)
  await database.db.insertInto("notification_outbox").values({ candidate_id: candidateId, id, application_id: null, kind: "daily_summary", local_day: day, created_at: new Date(at), sent_at: status === "sent" ? new Date(at) : null }).execute()
  await sql`update notification_outbox set status = ${status}, claimed_at = ${new Date(at)} where id = ${id}`.execute(database.db)
  return id
}

async function summaryFor(candidateId: string, at = "2026-10-24T20:00:00Z"): Promise<StackPostsSummary> {
  const id = await summaryRow(candidateId, at, "sending")
  return CandidateScope.run(candidateId, () => summaries.summary(id, new Date(at)))
}

async function stackPost(candidateId: string, title: string, firstSeen: string): Promise<void> {
  await database.db
    .insertInto("stack_post")
    .values({ candidate_id: candidateId, id: randomUUID(), canonical_url: `https://www.linkedin.com/posts/${randomUUID()}`, kind: "post", title, snippet: "", published_at: null, matched_technologies: [], source_feed_id: null, first_seen_at: new Date(firstSeen) })
    .execute()
}

describe("the two gates (AC 9.1, 9.2; DSH:222, DSH:239, DSH:250, DSH:259; P3-15a/b)", () => {
  beforeEach(async () => {
    await stackPost(ADA(), "STACK-NEW", "2026-10-24T10:00:00Z")
    await insertStackFeed(database.db, ADA(), "https://www.google.com/alerts/feeds/01234567890123456789/9876543210987654321", { label: "React posts", failure: "redirected" })
    await insertHiringPosts(database.db, ADA(), [{ title: "HIRING-NEW-1", firstSeenAt: new Date("2026-10-24T11:00:00Z") }, { title: "HIRING-NEW-2", firstSeenAt: new Date("2026-10-24T12:00:00Z") }])
    await insertHiringFeed(database.db, ADA(), HFEED_A, { label: "Frontend hiring", failure: "timed_out" })
  })

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])("own Stack posts record %s × own Hiring record %s: Stack parts follow her own Stack posts record (EPIC-0008), the Hiring part her own Hiring record", async (shared, own) => {
    if (shared) await recordOwnStack(database.db, ADA())
    if (own) await recordOwn(database.db, ADA())
    const summary = await summaryFor(ADA())
    expect(summary.verified).toBe(shared)
    expect(summary.hiringVerified).toBe(own)
    expect(summary.newPosts.map((post) => post.title)).toEqual(shared ? ["STACK-NEW"] : [])
    expect(summary.failingFeeds.map((feed) => feed.label)).toEqual(shared ? ["React posts"] : [])
    expect(summary.hiringNewPosts.map((post) => post.title)).toEqual(own ? ["HIRING-NEW-2", "HIRING-NEW-1"] : [])
    expect(summary.hiringNewCount).toBe(own ? 2 : 0)
    expect(summary.failingHiringFeeds).toEqual(own ? [{ label: "Frontend hiring", maskedUrl: "…123456", reason: "timed_out" }] : [])
    expect(summary.hiring.family).toBe("senior_frontend")
  })

  it("DSH:250, DSH:259, DSH:280 bola's record does not add the Hiring part to ada's summary; DSH:259 and the reverse", async () => {
    await recordOwn(database.db, bolaId)
    await insertHiringPosts(database.db, bolaId, [{ title: "BOLA-ONLY", firstSeenAt: new Date("2026-10-24T11:00:00Z") }])
    const adaSummary = await summaryFor(ADA())
    expect(adaSummary.hiringVerified).toBe(false)
    expect(JSON.stringify(adaSummary)).not.toContain("BOLA-ONLY")
    const bolaSummary = await summaryFor(bolaId)
    expect(bolaSummary.hiringVerified).toBe(true)
    expect(bolaSummary.hiringNewPosts.map((post) => post.title)).toEqual(["BOLA-ONLY"])
    expect(JSON.stringify(bolaSummary)).not.toMatch(/HIRING-NEW|Frontend hiring/)
  })
})

describe("the window (DSH:181, DSH:189)", () => {
  beforeEach(async () => {
    await recordOwn(database.db, ADA())
  })

  it("DSH:181 new means first seen after the last sent summary's claim", async () => {
    await summaryRow(ADA(), "2026-10-23T19:30:00Z", "sent")
    await insertHiringPosts(database.db, ADA(), [{ title: "before", firstSeenAt: new Date("2026-10-23T19:29:00Z") }, { title: "after", firstSeenAt: new Date("2026-10-23T19:31:00Z") }])
    expect((await summaryFor(ADA())).hiringNewPosts.map((post) => post.title)).toEqual(["after"])
  })

  it("DSH:189 a post listed in a sent summary is not listed in the next", async () => {
    await insertHiringPosts(database.db, ADA(), [{ title: "POST_1", firstSeenAt: new Date("2026-10-23T10:00:00Z") }])
    await summaryRow(ADA(), "2026-10-23T19:00:00Z", "sent")
    expect((await summaryFor(ADA())).hiringNewPosts).toEqual([])
  })

  it("DSH:159 more than 10: lists 10 newest, the count is the full total", async () => {
    await insertHiringPosts(database.db, ADA(), Array.from({ length: 57 }, (_, i) => ({ title: `p${i}`, firstSeenAt: new Date(Date.UTC(2026, 9, 24, 10, i)) })))
    const summary = await summaryFor(ADA())
    expect(summary.hiringNewCount).toBe(57)
    expect(summary.hiringNewPosts.map((post) => post.title)).toEqual(Array.from({ length: 10 }, (_, i) => `p${56 - i}`))
  })
})

describe("the sent email (DSH:142 to :330; HAF:624 summary half)", () => {
  async function send(candidateId: string): Promise<string> {
    await database.db.insertInto("notification_outbox").values({ candidate_id: candidateId, id: randomUUID(), application_id: null, kind: "daily_summary", local_day: "2026-10-24", created_at: clock.now(), sent_at: null }).execute()
    expect(await CandidateScope.run(candidateId, () => sender.get(NotificationSender).sendDue())).toMatchObject({ sent: 1 })
    const raw = smtp.received.at(-1)!.raw
    return raw
  }

  it("own Hiring record and own Stack posts record: Hiring part after the Stack parts, Not vetted meta, no snippet, both counts, no basis, no feed URL", async () => {
    await recordOwnStack(database.db, ADA())
    await recordOwn(database.db, ADA(), "SUMMARY-BASIS-MARKER")
    await stackPost(ADA(), "Stack one", "2026-10-24T09:00:00Z")
    const feedId = await insertHiringFeed(database.db, ADA(), HFEED_A, { label: "Frontend hiring", failure: "timed_out" })
    await insertHiringPosts(database.db, ADA(), [{ canonicalUrl: POST_1, title: "We're hiring a frontend engineer", snippet: "SNIPPET-SENTINEL", publishedAt: new Date("2026-10-24T08:30:00Z"), firstSeenAt: new Date("2026-10-24T10:00:00Z"), matched: ["React"], feedId }])
    const raw = await send(ADA())
    const text = plainText(raw)
    expect(text.indexOf("Hiring search links")).toBeLessThan(text.indexOf("New Hiring posts: 1"))
    expect(text.indexOf("New Stack posts: 1")).toBeLessThan(text.indexOf("New Hiring posts: 1"))
    expect(text).toContain("We're hiring a frontend engineer")
    expect(text).toContain("Posted 24 Oct 2026 · React · Not vetted")
    expect(text).toContain("Failing Hiring Alert feeds")
    expect(text).toContain("Frontend hiring (…123456): Timed out")
    expect(text.replace(/\s+$/, "").split(/\r?\n/).at(-1)).toBe("0 not a match, 0 failed, 0 unsure, 1 new Stack post, 1 new Hiring post.")
    expect(raw).not.toContain("SNIPPET-SENTINEL")
    expect(raw).not.toContain("SUMMARY-BASIS-MARKER")
    expect(raw).not.toContain(HFEED_A_DIGITS)
    expect(await database.db.selectFrom("ai_call").select("id").execute()).toEqual([])
  })

  it("DSH:319 without her own Hiring record the line ends with the Stack posts count, with her own Stack posts record", async () => {
    await recordOwnStack(database.db, ADA())
    for (const n of [1, 2, 3]) await stackPost(ADA(), `s${n}`, "2026-10-24T09:00:00Z")
    await insertHiringPosts(database.db, ADA(), [{ firstSeenAt: new Date("2026-10-24T10:00:00Z") }])
    const text = plainText(await send(ADA()))
    expect(text).not.toMatch(/Hiring posts|Hiring post\b/)
    expect(text.replace(/\s+$/, "").split(/\r?\n/).at(-1)).toBe("0 not a match, 0 failed, 0 unsure, 3 new Stack posts.")
  })

  it("DSH:239 own record, no shared record: the Hiring count stands alone and the Stack parts are left out", async () => {
    await recordOwn(database.db, ADA())
    await insertHiringPosts(database.db, ADA(), [{ firstSeenAt: new Date("2026-10-24T10:00:00Z") }, { firstSeenAt: new Date("2026-10-24T11:00:00Z") }])
    const text = plainText(await send(ADA()))
    expect(text).toContain("New Hiring posts: 2")
    expect(text).not.toContain("New Stack posts")
    expect(text.replace(/\s+$/, "").split(/\r?\n/).at(-1)).toBe("0 not a match, 0 failed, 0 unsure, 2 new Hiring posts.")
  })
})

describe("DSH:290 a Hiring post stored while the summary renders appears in exactly one summary", () => {
  it("a Hiring read parked holding the shared window lock: the summary waits, and the post lands in exactly one summary", async () => {
    await recordOwn(database.db, ADA())
    await summaryRow(ADA(), "2026-10-23T19:00:00Z", "sent")
    const feeds = await FakeFeedServer.start()
    const holder = new pg.Client({ connectionString: database.adminUrl })
    await holder.connect()
    const LOCK = 990_001
    try {
      await insertHiringFeed(database.db, ADA(), HFEED_A)
      feeds.on(HFEED_A, { kind: "body", body: atomFeed([{ title: "Racing hiring post", link: googleRedirect(POST_1), content: "React" }]) })
      await holder.query("select pg_advisory_lock($1)", [LOCK])
      await sql
        .raw(`create or replace function qa_park_hiring() returns trigger language plpgsql as $$
          begin perform pg_advisory_lock_shared(${LOCK}); perform pg_advisory_unlock_shared(${LOCK}); return new; end $$;
          create trigger qa_park_hiring after update on hiring_post for each row execute function qa_park_hiring();`)
        .execute(database.db)
      const tenant = new TenantDatabase(runtime)
      const readClock = new TestClock("2026-10-24T18:59:59.900Z")
      const reader = new HiringPostsReader(new HiringPostsRepository(tenant), createAlertFeedHttp({ testOrigin: feeds.origin, timeoutMs: 2_000 }), readClock)
      const run = CandidateScope.run(ADA(), () => reader.runRead())
      await until(async () => (await holder.query<{ n: number }>("select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = $1 and not granted", [LOCK])).rows[0]!.n === 1)
      let rendered = false
      const thisOne = summaryFor(ADA(), "2026-10-24T19:00:00Z").finally(() => (rendered = true))
      await until(async () => rendered || (await holder.query<{ n: number }>("select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted and objid <> $1", [LOCK])).rows[0]!.n >= 1)
      await holder.query("select pg_advisory_unlock_all()")
      await run
      const first = await thisOne
      await sql`update notification_outbox set status = 'sent' where claimed_at = ${new Date("2026-10-24T19:00:00Z")}`.execute(database.db)
      const next = await summaryFor(ADA(), "2026-10-25T19:00:00Z")
      const seen = [first, next].filter((summary) => summary.hiringNewPosts.some((post) => post.canonicalUrl === POST_1)).length
      expect(seen, "exactly one summary lists the post").toBe(1)
    } finally {
      await holder.query("select pg_advisory_unlock_all()").catch(() => undefined)
      await holder.end()
      await sql.raw("drop trigger if exists qa_park_hiring on hiring_post; drop function if exists qa_park_hiring();").execute(database.db)
      await feeds.close()
    }
  })
})

async function until(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not reached")
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
