import { randomUUID } from "node:crypto"

import type { INestApplicationContext } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { type Kysely, sql } from "kysely"
import { Migrator } from "kysely/migration"
import pg from "pg"
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest"

import { anthropicConfig } from "../src/config/env.js"
import { createDatabase } from "../src/db/create-database.js"
import { migrations } from "../src/db/migrations/index.js"
import type { Database } from "../src/db/schema.js"
import { GmailSmtpMailer } from "../src/notification/mailer.js"
import { type MailerConfig, mailerConfig } from "../src/notification/mailer-config.js"
import { NotificationSender } from "../src/notification/notification-sender.js"
import { NotificationWorkerModule } from "../src/notification/notification.module.js"
import { CLOCK } from "../src/shared/clock.js"
import { StackPostsSummaryReader } from "../src/stack-posts/stack-posts-summary.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { asOperatorWith } from "./support/operator-scope.js"
import { SUMMARY_WINDOW_LOCK_KEY } from "../src/stack-posts/stack-posts.repository.js"
import { FakeSmtp, plainText as plainTextLatin1 } from "./support/fake-smtp.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { PUBLIC_ORIGIN } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0005 daily summary section against real Postgres: the D-E5-3 "new"
 * window read from `notification_outbox` (daily-summary-new-posts.feature),
 * and one end-to-end render through the production sender and Gmail SMTP
 * adapter pointed at an in-process fake SMTP server (daily-summary.feature).
 * Synthetic credentials; nothing reaches a real mail server.
 */
const SENDER = "ada.okafor@gmail.com"
const APP_PASSWORD = "abcdefghijklmnop"
const FEED_URL = "https://www.google.com/alerts/feeds/01234567890123456789/9876543210987654321"

let database: TestDatabase
let runtime: Kysely<Database>
let reader: StackPostsSummaryReader
let smtp: FakeSmtp
let config: MailerConfig
let sender: INestApplicationContext
const clock = new TestClock("2026-10-21T20:00:00.000Z")
/** The shared helper turns quoted-printable bytes into Latin-1 characters; the part is UTF-8 ("…", "·"). */
const plainText = (raw: string) => Buffer.from(plainTextLatin1(raw), "latin1").toString("utf8")
/** The whole message with quoted-printable undone, as UTF-8. */
const decodedRaw = (raw: string) =>
  Buffer.from(raw.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))), "latin1").toString("utf8")

beforeAll(async () => {
  database = await startMigratedDatabase()
  runtime = createDatabase(database.url)
  reader = asOperatorWith(new TenantDatabase(runtime), new StackPostsSummaryReader(new TenantDatabase(runtime)))
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
  clock.set("2026-10-21T20:00:00.000Z")
  smtp.reset()
  for (const table of ["notification_outbox", "stack_post", "alert_feed", "alert_feed_candidate_verification", "ai_call", "spend_entry"] as const) {
    await database.db.deleteFrom(table).execute()
  }
  // EPIC-0008: the summary Candidate's (the Operator's) own Stack posts record.
  await database.db.insertInto("alert_feed_candidate_verification").values({ candidate_id: database.operatorId, verified_on: "2026-10-20", verification_basis: "Reviewed terms.", updated_at: clock.now() }).execute()
  await database.db.updateTable("job_criteria").set({ frameworks: ["React"], technologies: ["TypeScript"] }).execute()
})

afterAll(async () => {
  await sender?.close()
  await smtp?.stop()
  await runtime?.destroy()
  await database?.stop()
})

async function post(title: string, firstSeen: string, options: { published?: string; snippet?: string; feedId?: string | null } = {}): Promise<void> {
  await database.db
    .insertInto("stack_post")
    .values({
      candidate_id: database.operatorId,
      id: randomUUID(),
      canonical_url: `https://www.linkedin.com/posts/${title.toLowerCase().replace(/\W+/g, "-")}-${randomUUID().slice(0, 6)}`,
      kind: "post",
      title,
      snippet: options.snippet ?? "SNIPPET-SENTINEL never in email",
      published_at: options.published ? new Date(options.published) : null,
      matched_technologies: ["React"],
      source_feed_id: options.feedId ?? null,
      first_seen_at: new Date(firstSeen),
    })
    .execute()
}

/** A daily_summary outbox row whose claim time is `at`, in the given status. */
async function summaryRow(at: string, status: "sent" | "failed" | "skipped" | "sending"): Promise<string> {
  const id = randomUUID()
  const day = new Date(new Date(at).getTime() + 3_600_000).toISOString().slice(0, 10)
  await database.db
    .insertInto("notification_outbox")
    .values({ candidate_id: database.operatorId, id, application_id: null, kind: "daily_summary", local_day: day, created_at: new Date(at), sent_at: status === "sent" ? new Date(at) : null })
    .execute()
  await sql`update notification_outbox set status = ${status}, claimed_at = ${new Date(at)} where id = ${id}`.execute(database.db)
  return id
}

/** Renders "now" as the sender would: this row is claimed at `at`. */
async function newTitles(at: string): Promise<{ titles: string[]; count: number }> {
  const id = await summaryRow(at, "sending")
  const summary = await reader.summary(id, new Date(at))
  return { titles: summary.newPosts.map((item) => item.title), count: summary.newCount }
}

describe("which posts are new (daily-summary-new-posts.feature, D-E5-3)", () => {
  it("first summary ever: the 24 hours before the render, newest first", async () => {
    await post("Two days old", "2026-10-19T20:00:00Z")
    await post("Yesterday", "2026-10-20T21:00:00Z")
    await post("This morning", "2026-10-21T07:00:00Z")
    expect(await newTitles("2026-10-21T20:00:00Z")).toEqual({ titles: ["This morning", "Yesterday"], count: 2 })
  })

  it.each([
    ["2026-10-20T19:59:59Z", false],
    ["2026-10-20T20:00:00Z", false],
    ["2026-10-20T20:00:01Z", true],
    ["2026-10-21T19:59:59Z", true],
    ["2026-10-21T20:00:00Z", true],
  ])("first summary window edge: first seen %s listed=%s", async (seen, listed) => {
    await post("Edge", seen)
    expect((await newTitles("2026-10-21T20:00:00Z")).titles).toEqual(listed ? ["Edge"] : [])
  })

  it("a long backlog: 10 listed, the count is the full 24-hour total", async () => {
    for (let i = 0; i < 30; i += 1) await post(`Old ${i}`, `2026-10-1${i % 9}T10:00:00Z`)
    for (let i = 0; i < 15; i += 1) await post(`New ${String(i).padStart(2, "0")}`, new Date(Date.parse("2026-10-21T01:00:00Z") + i * 60_000).toISOString())
    const { titles, count } = await newTitles("2026-10-21T20:00:00Z")
    expect(count).toBe(15)
    expect(titles).toHaveLength(10)
    expect(titles[0]).toBe("New 14")
  })

  it("the second summary counts from the first summary's claim time", async () => {
    await summaryRow("2026-10-21T20:00:00Z", "sent")
    await post("Late", "2026-10-21T21:00:00Z")
    await post("Already sent", "2026-10-21T08:00:00Z")
    expect((await newTitles("2026-10-22T20:00:00Z")).titles).toEqual(["Late"])
  })

  it("a failed send does not move the boundary", async () => {
    await summaryRow("2026-10-19T20:00:00Z", "sent")
    await summaryRow("2026-10-20T20:00:00Z", "failed")
    await post("Missed", "2026-10-20T10:00:00Z")
    await post("Today", "2026-10-21T10:00:00Z")
    expect((await newTitles("2026-10-21T20:00:00Z")).titles).toEqual(["Today", "Missed"])
  })

  it("a disabled (no row) period does not move the boundary", async () => {
    await summaryRow("2026-10-18T20:00:00Z", "sent")
    await post("While disabled", "2026-10-19T12:00:00Z")
    expect((await newTitles("2026-10-21T20:00:00Z")).titles).toEqual(["While disabled"])
  })

  it("a first summary whose send failed leaves the next one on the 24-hour rule", async () => {
    await summaryRow("2026-10-20T20:00:00Z", "failed")
    await post("Two days old", "2026-10-19T22:00:00Z")
    await post("Recent", "2026-10-21T09:00:00Z")
    expect((await newTitles("2026-10-21T20:00:00Z")).titles).toEqual(["Recent"])
  })

  it("a post first seen exactly at the previous claim belongs to that summary only", async () => {
    await summaryRow("2026-10-20T20:00:00Z", "sent")
    await post("Hooks in practice", "2026-10-20T20:00:00Z")
    expect(await newTitles("2026-10-21T20:00:00Z")).toEqual({ titles: [], count: 0 })
  })

  it("without a verification, posts and failures are left out", async () => {
    await database.db.deleteFrom("alert_feed_candidate_verification").execute()
    await post("This morning", "2026-10-21T07:00:00Z")
    const id = await summaryRow("2026-10-21T20:00:00Z", "sending")
    expect(await reader.summary(id, new Date("2026-10-21T20:00:00Z"))).toMatchObject({ verified: false, newPosts: [], newCount: 0, failingFeeds: [] })
  })
})

describe("the rendered email (daily-summary.feature)", () => {
  it("lists new posts without snippets, masks failing feeds, adds the plain-text count; no AI, no spend", async () => {
    const feedId = randomUUID()
    await database.db
      .insertInto("alert_feed")
      .values({ candidate_id: database.operatorId, id: feedId, url: FEED_URL, label: "React posts", created_at: clock.now(), last_read_at: null, last_failure_reason: "redirected", last_failed_at: clock.now() })
      .execute()
    await post("Hooks in practice", "2026-10-21T10:00:00Z", { published: "2026-10-21T09:00:00Z", feedId })
    await post("From a removed feed", "2026-10-21T11:00:00Z")
    await database.db.insertInto("notification_outbox").values({ candidate_id: database.operatorId, id: randomUUID(), application_id: null, kind: "daily_summary", local_day: "2026-10-21", created_at: clock.now(), sent_at: null }).execute()

    expect(await sender.get(TenantDatabase).asOperator(() => sender.get(NotificationSender).sendDue())).toMatchObject({ sent: 1 })
    expect(smtp.received).toHaveLength(1)
    const raw = smtp.received[0]!.raw
    const text = plainText(raw)
    expect(text).toContain("Stack posts")
    expect(text).toContain("New Stack posts: 2")
    expect(text).toContain("Hooks in practice")
    expect(text).toContain("From a removed feed")
    expect(text).toContain("Failing Alert feeds")
    expect(text).toContain("React posts (…654321): Redirected (not followed)")
    // C-SP-EMAIL-SUMMARY-COUNT: appended to the existing "{k} skipped, {f} failed, {u} unsure." count list (the preheader).
    expect(decodedRaw(raw)).toContain("0 not a match, 0 failed, 0 unsure, 2 new Stack posts.")
    // daily-summary.feature r3 (D-E5-14, AC 8.5): C-SP-EMAIL-TEXT-SUMMARY is the last line of the sent text/plain part.
    const textLines = text.replace(/\s+$/, "").split(/\r?\n/)
    expect(textLines.at(-1)).toBe("0 not a match, 0 failed, 0 unsure, 2 new Stack posts.")
    expect(textLines.at(-2)).toBe("")
    expect(textLines.at(-3)).toMatch(/^Open your dashboard: /)
    expect(text.indexOf("Stack posts")).toBeLessThan(text.indexOf("Failing Alert feeds"))
    expect(raw).not.toContain("SNIPPET-SENTINEL")
    expect(raw).not.toContain("01234567890123456789")
    expect(await database.db.selectFrom("ai_call").select("id").execute()).toEqual([])
    const row = await database.db.selectFrom("notification_outbox").select(["status", "claimed_at"]).executeTakeFirstOrThrow()
    expect(row.status).toBe("sent")

    // The next summary counts from this one's claim time: the same posts are not new again.
    clock.set("2026-10-22T20:00:00.000Z")
    smtp.reset()
    await database.db.insertInto("notification_outbox").values({ candidate_id: database.operatorId, id: randomUUID(), application_id: null, kind: "daily_summary", local_day: "2026-10-22", created_at: clock.now(), sent_at: null }).execute()
    await sender.get(TenantDatabase).asOperator(() => sender.get(NotificationSender).sendDue())
    expect(plainText(smtp.received[0]!.raw)).toContain("No new Stack posts.")
  })
})

describe("EPIC-0007 Phase 1: the sent summary's hiring links part (daily-summary-hiring.feature @phase1 @ac-4.1)", () => {
  it("follows the Stack posts search links, names Frontend, carries one LinkedIn and one Google link, and links to the Hiring view", async () => {
    await database.db.updateTable("job_criteria").set({ target_role_families: ["senior_frontend", "backend"] }).where("candidate_id", "=", database.operatorId).execute()
    await database.db.insertInto("notification_outbox").values({ candidate_id: database.operatorId, id: randomUUID(), application_id: null, kind: "daily_summary", local_day: "2026-10-21", created_at: clock.now(), sent_at: null }).execute()
    expect(await sender.get(TenantDatabase).asOperator(() => sender.get(NotificationSender).sendDue())).toMatchObject({ sent: 1 })
    const raw = decodedRaw(smtp.received[0]!.raw)
    const text = plainText(smtp.received[0]!.raw).replace(/\r\n/g, "\n")
    expect(text.indexOf("Google articles: ")).toBeLessThan(text.indexOf("Hiring search links"))
    expect(text).toContain("Past-week search hints for Frontend roles. Some results won't fit, and Eve can't check pay, hours or sponsorship from them.")
    const hiringText = text.slice(text.indexOf("Hiring search links"))
    expect(hiringText).toContain("React, TypeScript\nLinkedIn posts: https://www.linkedin.com/search/results/content/?keywords=")
    expect(hiringText.match(/^LinkedIn posts: /gm)).toHaveLength(1)
    expect(hiringText.match(/^Google posts: /gm)).toHaveLength(1)
    expect(text).toContain(`Searches for your other role families: ${PUBLIC_ORIGIN}/stack-posts?view=hiring`)
    expect(raw).toMatch(/<a href="https:\/\/www\.google\.com\/search\?q=site%3Alinkedin\.com%2Fposts[^"]*" target="_blank" rel="noopener noreferrer"/)
    expect(text).not.toContain("site:linkedin.com/posts (")
    expect(await database.db.selectFrom("ai_call").select("id").execute()).toEqual([])
    expect(await database.db.selectFrom("spend_entry").select("id").execute()).toEqual([])
  })
})

describe("daily-summary.feature @sad @ac-8.2 (a summary read that times out on the window lock, SEC-E5F-04)", () => {
  async function withWindowLockHeld<T>(work: () => Promise<T>): Promise<T> {
    const holder = new pg.Client({ connectionString: database.adminUrl })
    await holder.connect()
    try {
      await holder.query("select pg_advisory_lock($1)", [SUMMARY_WINDOW_LOCK_KEY])
      return await work()
    } finally {
      await holder.end()
    }
  }

  const sendAsOperator = () => sender.get(TenantDatabase).asOperator(() => sender.get(NotificationSender).sendDue())

  it("is recorded as attempt 1 with last error unknown, retried 1 minute later, no email, boundary unchanged; the retry lists the post once", async () => {
    await summaryRow("2026-10-20T20:00:00Z", "sent")
    await post("Waiting post", "2026-10-21T19:00:00Z")
    const id = randomUUID()
    await database.db.insertInto("notification_outbox").values({ candidate_id: database.operatorId, id, application_id: null, kind: "daily_summary", local_day: "2026-10-21", created_at: clock.now(), sent_at: null }).execute()

    const started = Date.now()
    const result = await withWindowLockHeld(() => sendAsOperator())
    const ms = Date.now() - started
    expect(result).toMatchObject({ sent: 0, retrying: 1, failed: 0 })
    // The 5 s lock bound fires, not the worker pool's 60 s statement bound (which took about 62 s before r4).
    // The upper bound leaves room for the claim and render queries on a loaded host.
    expect(ms).toBeGreaterThanOrEqual(4_900)
    expect(ms).toBeLessThan(30_000)
    expect(smtp.received).toEqual([])
    const row = await database.db.selectFrom("notification_outbox").select(["status", "attempts", "last_error", "next_attempt_at"]).where("id", "=", id).executeTakeFirstOrThrow()
    expect(row).toEqual({ status: "pending", attempts: 1, last_error: "unknown", next_attempt_at: new Date("2026-10-21T20:01:00.000Z") })

    // The failed claim moved no boundary: the retry still lists the post first seen before it.
    clock.set("2026-10-21T20:01:00.000Z")
    expect(await sendAsOperator()).toMatchObject({ sent: 1 })
    expect(plainText(smtp.received[0]!.raw)).toContain("Waiting post")

    clock.set("2026-10-22T20:00:00.000Z")
    smtp.reset()
    await database.db.insertInto("notification_outbox").values({ candidate_id: database.operatorId, id: randomUUID(), application_id: null, kind: "daily_summary", local_day: "2026-10-22", created_at: clock.now(), sent_at: null }).execute()
    expect(await sendAsOperator()).toMatchObject({ sent: 1 })
    expect(plainText(smtp.received[0]!.raw)).not.toContain("Waiting post")
  })
})

describe("migration chain (D-E5-9)", () => {
  it("0013-stack-posts applies after 0011-postings-paging-filter and 0012-job-criteria on an empty database, and rolls back cleanly", async () => {
    // Scoped to the image that shipped 0013 as its latest migration; later migrations (0014-access-request, 0015-retention) are out of scope.
    const through0013 = Object.fromEntries(Object.entries(migrations).filter(([migrationName]) => migrationName < "0014"))
    expect(Object.keys(through0013).slice(-3)).toEqual(["0011-postings-paging-filter", "0012-job-criteria", "0013-stack-posts"])
    const admin = createDatabase(inject("postgresAdminUrl")) as unknown as Kysely<unknown>
    const name = `ja_sp_mig_${randomUUID().replaceAll("-", "").slice(0, 12)}`
    await sql`create database ${sql.id(name)}`.execute(admin)
    const url = new URL(inject("postgresAdminUrl"))
    url.pathname = `/${name}`
    const db = createDatabase(url.toString()) as unknown as Kysely<unknown>
    try {
      const migrator = new Migrator({ db, provider: { getMigrations: async () => through0013 } })
      const up = await migrator.migrateToLatest()
      expect(up.error).toBeUndefined()
      expect(up.results?.map((result) => [result.migrationName, result.status])).toContainEqual(["0013-stack-posts", "Success"])
      const tables = await sql<{ tablename: string }>`
        select tablename from pg_tables where schemaname = 'public' and tablename in ('alert_feed_verification', 'alert_feed', 'stack_post', 'stack_post_run') order by tablename`.execute(db)
      expect(tables.rows.map((row) => row.tablename)).toEqual(["alert_feed", "alert_feed_verification", "stack_post", "stack_post_run"])
      // The URL pattern is repeated as a check constraint.
      await expect(sql`insert into alert_feed (id, url, created_at) values (${randomUUID()}, 'https://evil.test/alerts/feeds/1/2', now())`.execute(db)).rejects.toThrow()
      const down = await migrator.migrateDown()
      expect(down.error).toBeUndefined()
      const after = await sql<{ n: number }>`select count(*)::int as n from pg_tables where schemaname = 'public' and tablename like 'stack_post%'`.execute(db)
      expect(after.rows[0]!.n).toBe(0)
    } finally {
      await db.destroy()
      await sql`drop database if exists ${sql.id(name)} with (force)`.execute(admin)
      await admin.destroy()
    }
  })

  it("the runtime role can read and write the four tables but not alter them", async () => {
    // EPIC-0002 A1: the tables are Candidate data under forced RLS, so the write runs in the Operator's scope.
    await new TenantDatabase(runtime).forCandidate(database.operatorId, async (tx) => {
      await tx.insertInto("stack_post_run").values({ candidate_id: database.operatorId, id: randomUUID(), started_at: new Date(), finished_at: null, outcome: "running" }).execute()
      await tx.deleteFrom("stack_post_run").where("candidate_id", "=", database.operatorId).execute()
    })
    await expect(sql`alter table stack_post add column x int`.execute(runtime)).rejects.toThrow()
  })
})
