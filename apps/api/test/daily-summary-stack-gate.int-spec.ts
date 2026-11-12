import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"

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
import { StackPostsReader } from "../src/stack-posts/stack-posts-reader.js"
import { type StackPostsSummary, StackPostsSummaryReader } from "../src/stack-posts/stack-posts-summary.js"
import { StackPostsRepository } from "../src/stack-posts/stack-posts.repository.js"
import { atomFeed, googleRedirect } from "./support/alert-feed-fixtures.js"
import { FakeFeedServer } from "./support/fake-feed-server.js"
import { FakeSmtp, plainText as plainTextLatin1 } from "./support/fake-smtp.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { until } from "./support/qa-hiring-feeds.js"
import { BANNED_WORDING, SFEED_A, clearFeeds, insertCandidate, insertStackFeed, recordHiring, recordStack, revokeRuntime, setLegacy } from "./support/stack-feed-fixtures.js"
import { PUBLIC_ORIGIN } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0008 daily summary Stack posts parts gated by the summary Candidate's own record
 * (daily-summary-stack-gate.feature; stack-feed-copy-and-unchanged.feature:54; api-contract.md
 * v1.22.0 "Daily summary"; architecture AR-7). The reader runs through the runtime role in the
 * summary Candidate's scope; sent emails go through the production sender to a fake SMTP server.
 * Synthetic data; nothing reaches a real mail server; no AI.
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
const decodedRaw = (raw: string) =>
  Buffer.from(raw.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))), "latin1").toString("utf8")

beforeAll(async () => {
  database = await startMigratedDatabase()
  runtime = createDatabase(database.url)
  summaries = new StackPostsSummaryReader(new TenantDatabase(runtime))
  bolaId = await insertCandidate(database.db, "bola@example.com")
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
  await database.db.deleteFrom("notification_outbox").execute()
  await clearFeeds(database.db)
  await database.db.updateTable("job_criteria").set({ frameworks: ["React"], technologies: ["TypeScript"], target_role_families: ["senior_frontend"] }).execute()
})

afterAll(async () => {
  await sender?.close()
  await smtp?.stop()
  await runtime?.destroy()
  await database?.stop()
})

const ADA = () => database.operatorId

async function stackPost(candidateId: string, title: string, firstSeen = "2026-10-24T09:00:00Z", url = `https://www.linkedin.com/posts/${randomUUID()}`): Promise<void> {
  await database.db
    .insertInto("stack_post")
    .values({ candidate_id: candidateId, id: randomUUID(), canonical_url: url, kind: "post", title, snippet: "SNIPPET-SENTINEL", published_at: null, matched_technologies: ["React"], source_feed_id: null, first_seen_at: new Date(firstSeen) })
    .execute()
}

async function hiringPost(candidateId: string, title: string): Promise<void> {
  await database.db
    .insertInto("hiring_post")
    .values({ candidate_id: candidateId, id: randomUUID(), canonical_url: `https://www.linkedin.com/posts/h-${randomUUID()}`, kind: "post", title, snippet: "", published_at: null, matched_technologies: [], source_feed_id: null, first_seen_at: new Date("2026-10-24T10:00:00Z") })
    .execute()
}

async function failingFeed(candidateId: string, label: string, url = SFEED_A): Promise<void> {
  await database.db.insertInto("alert_feed").values({ candidate_id: candidateId, id: randomUUID(), url, label, created_at: clock.now(), last_read_at: null, last_failure_reason: "timed_out", last_failed_at: clock.now() }).execute()
}

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

/** The sent summary for `candidateId`, through the production sender (EPIC-0002 slice F sends it to her). */
async function send(candidateId: string): Promise<{ raw: string; text: string; html: string }> {
  await database.db.insertInto("notification_outbox").values({ candidate_id: candidateId, id: randomUUID(), application_id: null, kind: "daily_summary", local_day: "2026-10-24", created_at: clock.now(), sent_at: null }).execute()
  expect(await CandidateScope.run(candidateId, () => sender.get(NotificationSender).sendDue())).toMatchObject({ sent: 1 })
  const raw = smtp.received.at(-1)!.raw
  const decoded = decodedRaw(raw)
  return { raw, text: plainText(raw).replace(/\r\n/g, "\n"), html: decoded.slice(decoded.indexOf("<html")) }
}

const summaryLine = (text: string) => text.replace(/\s+$/, "").split("\n").at(-1)
const stackSection = (text: string) => text.slice(text.indexOf("\n\nStack posts\n"), text.indexOf("\n\nSpend\n") > 0 ? text.indexOf("\n\nSpend\n") : undefined)

describe("with her own record (DSS:25, :34, :41)", () => {
  it("DSS:25 shows her 3 new posts, the failing feed line and the 3-post count", async () => {
    await recordStack(database.db, ADA())
    for (const n of [1, 2, 3]) await stackPost(ADA(), `Post ${n}`)
    await failingFeed(ADA(), "React posts")
    const { text } = await send(ADA())
    expect(text).toContain("New Stack posts: 3")
    for (const n of [1, 2, 3]) expect(text).toContain(`Post ${n}`)
    expect(text).toContain("Failing Alert feeds")
    expect(text).toContain("React posts (…654321): Timed out")
    expect(summaryLine(text)).toBe("0 not a match, 0 failed, 0 unsure, 3 new Stack posts.")
  })

  it("DSS:34 with no new posts the part says 'No new Stack posts.' and the line shows 0", async () => {
    await recordStack(database.db, ADA())
    const { text } = await send(ADA())
    expect(text).toContain("No new Stack posts.")
    expect(summaryLine(text)).toBe("0 not a match, 0 failed, 0 unsure, 0 new Stack posts.")
  })

  it("DSS:41 an invited Candidate's summary shows her 2 posts on her own record, with no legacy record", async () => {
    await setLegacy(database.db as never, false)
    await recordStack(database.db, bolaId)
    await stackPost(bolaId, "Bola one")
    await stackPost(bolaId, "Bola two")
    const { text } = await send(bolaId)
    expect(text).toContain("New Stack posts: 2")
    expect(text).toContain("Bola one")
    expect(text).toContain("Bola two")
  })
})

describe("without her own record (DSS:51, :136, :144)", () => {
  it.each([
    ["no other record exists", async () => undefined],
    ["the legacy shared record exists", async () => setLegacy(database.db as never, true)],
    ["bola has her own Stack posts record", async () => recordStack(database.db, bolaId)],
    ["ada has her own Hiring record", async () => recordHiring(database.db, ADA())],
  ])("DSS:51 %s: search links only; no new-posts part, no 'No new' line, no failing part, no count", async (_name, arrange) => {
    await arrange()
    await stackPost(ADA(), "Hidden one")
    await stackPost(ADA(), "Hidden two")
    await failingFeed(ADA(), "Ada React")
    const { text } = await send(ADA())
    const section = stackSection(text)
    expect(section).toContain("LinkedIn posts: ")
    expect(section).not.toMatch(/New Stack posts|No new Stack posts\.|Failing Alert feeds|Hidden one|Ada React/)
    expect(summaryLine(text)).not.toMatch(/Stack post/)
  })

  it("DSS:136 ada's record adds no Stack posts parts to bola's summary", async () => {
    await recordStack(database.db, ADA())
    await stackPost(bolaId, "Bola hidden")
    const { text } = await send(bolaId)
    expect(text).not.toMatch(/New Stack posts|Bola hidden/)
    expect(summaryLine(text)).not.toMatch(/Stack post/)
  })

  it("DSS:144 bola's missing record does not remove ada's Stack posts parts", async () => {
    await recordStack(database.db, ADA())
    for (const n of [1, 2, 3]) await stackPost(ADA(), `Ada ${n}`)
    expect((await send(ADA())).text).toContain("New Stack posts: 3")
  })
})

describe("the legacy shared record is never read (DSS:68, :77)", () => {
  it("DSS:68 the summary renders the Stack posts parts with the runtime role locked out of the legacy table", async () => {
    await setLegacy(database.db as never, true)
    await recordStack(database.db, ADA())
    await stackPost(ADA(), "Visible")
    const restore = await revokeRuntime(database, "alert_feed_verification")
    try {
      expect(await summaryFor(ADA())).toMatchObject({ verified: true, newCount: 1 })
    } finally {
      await restore()
    }
  })

  it("DSS:77 the sent summary shows 'New Stack posts: 1' when the runtime role cannot read the legacy record", async () => {
    await recordStack(database.db, ADA())
    await stackPost(ADA(), "Visible")
    const restore = await revokeRuntime(database, "alert_feed_verification")
    try {
      expect((await send(ADA())).text).toContain("New Stack posts: 1")
    } finally {
      await restore()
    }
  })
})

describe("the summary never selects the basis (T8-9, CR-E8-01)", () => {
  it("renders the Stack posts parts when the runtime role may read only candidate_id of the record table", async () => {
    await recordStack(database.db, ADA(), { basis: "Column-marker-5c1e" })
    await stackPost(ADA(), "Visible")
    const role = sql.id(database.roles.runtime.name)
    const restore = await revokeRuntime(database, "alert_feed_candidate_verification")
    await sql`grant select (candidate_id) on alert_feed_candidate_verification to ${role}`.execute(database.db)
    try {
      expect(await summaryFor(ADA())).toMatchObject({ verified: true, newCount: 1 })
      expect(await summaryFor(bolaId, "2026-10-24T20:05:00Z")).toMatchObject({ verified: false, newCount: 0 })
    } finally {
      await sql`revoke select (candidate_id) on alert_feed_candidate_verification from ${role}`.execute(database.db)
      await restore()
    }
  })
})

describe("search links and two records (DSS:86, :102)", () => {
  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])("DSS:86 Stack posts record %s, Hiring record %s: the section starts with its search links, then the Hiring search links", async (stack, hiring) => {
    if (stack) await recordStack(database.db, ADA())
    if (hiring) await recordHiring(database.db, ADA())
    const section = stackSection((await send(ADA())).text)
    expect(section.indexOf("Past-week searches from your job criteria.")).toBeGreaterThan(0)
    expect(section.indexOf("LinkedIn posts: ")).toBeLessThan(section.indexOf("Hiring search links"))
  })

  it.each([
    [true, true, "0 not a match, 0 failed, 0 unsure, 2 new Stack posts, 3 new Hiring posts."],
    [true, false, "0 not a match, 0 failed, 0 unsure, 2 new Stack posts."],
    [false, true, "0 not a match, 0 failed, 0 unsure, 3 new Hiring posts."],
    [false, false, "0 not a match, 0 failed, 0 unsure."],
  ])("DSS:102 Stack posts record %s, Hiring record %s: summary line %s", async (stack, hiring, line) => {
    if (stack) await recordStack(database.db, ADA())
    if (hiring) await recordHiring(database.db, ADA())
    await stackPost(ADA(), "s1")
    await stackPost(ADA(), "s2")
    for (const n of [1, 2, 3]) await hiringPost(ADA(), `h${n}`)
    const { text } = await send(ADA())
    expect(text.includes("New Stack posts: 2")).toBe(stack)
    expect(text.includes("New Hiring posts: 3")).toBe(hiring)
    expect(summaryLine(text)).toBe(line)
  })
})

describe("byte-identical to EPIC-0005 (DSS:118, :126)", () => {
  it("DSS:118, DSS:126 the reader names the field `verified`, true on her own record and false without it, whatever the legacy row says", async () => {
    await setLegacy(database.db as never, false)
    await recordStack(database.db, ADA())
    const recorded = await summaryFor(ADA())
    expect(Object.keys(recorded)).toContain("verified")
    expect(recorded.verified).toBe(true)
    await database.db.deleteFrom("alert_feed_candidate_verification").execute()
    await setLegacy(database.db as never, true)
    expect((await summaryFor(ADA(), "2026-10-25T20:00:00Z")).verified).toBe(false)
  })

  it("DSS:118, DSS:126 the recorded EPIC-0005 verified and unverified renderings (the owner Stack posts golden) are unchanged by EPIC-0008", () => {
    // stack-posts-regression.spec.ts renders `verified: true` and `verified: false` sections and compares them byte for byte with
    // this checked-in snapshot; EPIC-0008 changes only where `verified` comes from, so the snapshot file is untouched.
    const snapshot = JSON.parse(readFileSync(new URL("../src/stack-posts/__golden__/stack-posts.snap.json", import.meta.url), "utf8")) as { capturedOn: string; dailySummary: Record<string, unknown> }
    expect(snapshot.capturedOn).toBe("main 86637ae (pre-A1), proved on epic-0002/a0-gap")
    expect(Object.keys(snapshot.dailySummary).sort()).toEqual(["noCriteria", "unverified", "verified"])
  })
})

describe("tenancy and the basis (DSS:151, :161; COPY:54)", () => {
  it("DSS:151 bola's summary lists POST_B only and never mentions 'Ada React'", async () => {
    await recordStack(database.db, ADA())
    await recordStack(database.db, bolaId)
    await stackPost(ADA(), "POST_A")
    await failingFeed(ADA(), "Ada React")
    await stackPost(bolaId, "POST_B")
    const { text, html } = await send(bolaId)
    expect(text).toContain("POST_B")
    expect(text + html).not.toMatch(/POST_A|Ada React/)
  })

  it("DSS:161 neither part of her summary contains her basis", async () => {
    await recordStack(database.db, ADA(), { basis: "Summary-marker-1a9d" })
    await stackPost(ADA(), "One")
    const { raw, text } = await send(ADA())
    expect(decodedRaw(raw)).not.toContain("Summary-marker-1a9d")
    expect(text).not.toContain("Summary-marker-1a9d")
  })

  it.each([
    ["her own record, 2 new Stack posts and a failing feed", true, 2, true],
    ["her own record and no new Stack posts", true, 0, false],
    ["no Stack posts record of her own", false, 2, true],
  ])("COPY:54 %s: neither the HTML nor the plain-text Stack posts section contains the banned wording", async (_name, recorded, posts, failing) => {
    if (recorded) await recordStack(database.db, ADA())
    for (let n = 0; n < posts; n++) await stackPost(ADA(), `Post ${n}`)
    if (failing) await failingFeed(ADA(), "React posts")
    const { text, html } = await send(ADA())
    expect(stackSection(text)).not.toMatch(BANNED_WORDING)
    const start = html.indexOf(">Stack posts</h2>")
    const htmlSection = html.slice(start, html.indexOf("<h2", start + 1))
    expect(htmlSection.replace(/<[^>]+>/g, " ")).not.toMatch(BANNED_WORDING)
  })
})

describe("boundary and race (DSS:169, :178)", () => {
  it("DSS:169 a record saved at 20:59 WAT gates the 21:00 WAT summary", async () => {
    await stackPost(ADA(), "Late record post")
    clock.set("2026-10-24T19:59:00.000Z")
    await recordStack(database.db, ADA(), { at: clock.now() })
    clock.set("2026-10-24T20:00:00.000Z")
    expect((await send(ADA())).text).toContain("New Stack posts: 1")
  })

  it("DSS:178 a Stack post stored by her own read while her summary renders appears in exactly one summary", async () => {
    await recordStack(database.db, ADA())
    await summaryRow(ADA(), "2026-10-23T19:00:00Z", "sent")
    const POST = "https://www.linkedin.com/posts/e8-racing-stack-post"
    const feeds = await FakeFeedServer.start()
    const holder = new pg.Client({ connectionString: database.adminUrl })
    await holder.connect()
    const LOCK = 990_008
    try {
      await insertStackFeed(database.db, ADA(), SFEED_A)
      feeds.on(SFEED_A, { kind: "body", body: atomFeed([{ title: "Racing Stack post", link: googleRedirect(POST), content: "React" }]) })
      await holder.query("select pg_advisory_lock($1)", [LOCK])
      await sql
        .raw(`create or replace function e8_park_stack() returns trigger language plpgsql as $$
          begin perform pg_advisory_lock_shared(${LOCK}); perform pg_advisory_unlock_shared(${LOCK}); return new; end $$;
          create trigger e8_park_stack after update on stack_post for each row execute function e8_park_stack();`)
        .execute(database.db)
      const readClock = new TestClock("2026-10-24T18:59:59.900Z")
      const reader = new StackPostsReader(new StackPostsRepository(new TenantDatabase(runtime)), createAlertFeedHttp({ testOrigin: feeds.origin, timeoutMs: 2_000 }), readClock)
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
      expect([first, next].filter((summary) => summary.newPosts.some((post) => post.canonicalUrl === POST)).length, "exactly one summary lists the post").toBe(1)
    } finally {
      await holder.query("select pg_advisory_unlock_all()").catch(() => undefined)
      await holder.end()
      await sql.raw("drop trigger if exists e8_park_stack on stack_post; drop function if exists e8_park_stack();").execute(database.db)
      await feeds.close()
    }
  })
})
