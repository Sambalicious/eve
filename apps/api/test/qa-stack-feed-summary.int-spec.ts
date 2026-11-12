import { randomUUID } from "node:crypto"

import type { INestApplicationContext } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { type Kysely, sql } from "kysely"
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
import { type StackPostsSummary, StackPostsSummaryReader } from "../src/stack-posts/stack-posts-summary.js"
import { FakeSmtp, plainText as plainTextLatin1 } from "./support/fake-smtp.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { clearEpic8, insertInvitee, insertStackPosts, revokeRuntime, setHiringRecord, setLegacy, setOwnStack } from "./support/qa-stack-feed.js"
import { PUBLIC_ORIGIN } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * QA-authored (EPIC-0008, run epic-0008, test authoring).
 * daily-summary-stack-gate.feature r1 (AC 4.1, 4.2, 6.1, 6.2) and the summary
 * rows of stack-feed-copy-and-unchanged.feature: the summary's `verified` now
 * follows the summary Candidate's own `alert_feed_candidate_verification` row
 * (contract "Daily summary gate", AR-7). Reader-level checks call
 * StackPostsSummaryReader in a Candidate's scope; email checks send through the
 * production NotificationSender to a fake SMTP server. An invitee's summary is
 * sent in her own scope, as EPIC-0007 did. Nothing reaches a real mail server.
 */
const SENDER = "ada.okafor@gmail.com"
const APP_PASSWORD = "abcdefghijklmnop"
let database: TestDatabase
let runtime: Kysely<Database>
let summaries: StackPostsSummaryReader
let smtp: FakeSmtp
let config: MailerConfig
let sender: INestApplicationContext
let adaId: string
let bolaId: string
const clock = new TestClock("2026-10-24T20:00:00.000Z") // 21:00 WAT
const plainText = (raw: string) => Buffer.from(plainTextLatin1(raw), "latin1").toString("utf8").replace(/\r\n/g, "\n")
const decodedRaw = (raw: string) =>
  Buffer.from(raw.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))), "latin1").toString("utf8")
const inWindow = (i: number) => new Date(Date.parse("2026-10-24T10:00:00Z") + i * 60_000)
const BANNED = /\b(operator|admin|owner|team|shared|installation)\b|the person who runs your eve|on behalf of/i

beforeAll(async () => {
  database = await startMigratedDatabase()
  adaId = database.operatorId
  runtime = createDatabase(database.url)
  summaries = new StackPostsSummaryReader(new TenantDatabase(runtime))
  bolaId = await insertInvitee(database.db, "bola@example.com")
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
  await clearEpic8(database.db)
  await database.db.updateTable("job_criteria").set({ frameworks: ["React"], technologies: ["TypeScript"], target_role_families: ["senior_frontend"] }).execute()
})

afterAll(async () => {
  await sender?.close()
  await smtp?.stop()
  await runtime?.destroy()
  await database?.stop()
})

async function summaryFor(candidateId: string): Promise<StackPostsSummary> {
  const id = randomUUID()
  await database.db.insertInto("notification_outbox").values({ candidate_id: candidateId, id, application_id: null, kind: "daily_summary", local_day: "2026-10-24", created_at: clock.now(), sent_at: null }).execute()
  await sql`update notification_outbox set status = 'sending', claimed_at = ${clock.now()} where id = ${id}`.execute(database.db)
  return CandidateScope.run(candidateId, () => summaries.summary(id, clock.now()))
}

async function send(candidateId: string): Promise<{ raw: string; text: string; html: string }> {
  await database.db.insertInto("notification_outbox").values({ candidate_id: candidateId, id: randomUUID(), application_id: null, kind: "daily_summary", local_day: "2026-10-24", created_at: clock.now(), sent_at: null }).execute()
  expect(await CandidateScope.run(candidateId, () => sender.get(NotificationSender).sendDue())).toMatchObject({ sent: 1 })
  const raw = smtp.received.at(-1)!.raw
  return { raw, text: plainText(raw), html: decodedRaw(raw) }
}

const lastLine = (text: string) => text.replace(/\s+$/, "").split("\n").at(-1)

async function failingFeed(candidateId: string, label: string): Promise<void> {
  await sql`insert into alert_feed (candidate_id, id, url, label, created_at, last_read_at, last_failure_reason, last_failed_at)
    values (${candidateId}::uuid, gen_random_uuid(), 'https://www.google.com/alerts/feeds/01234567890123456789/9876543210987654321', ${label}, now(), null, 'redirected', now())`.execute(database.db)
}

async function hiringPosts(candidateId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await sql`insert into hiring_post (candidate_id, id, canonical_url, kind, title, first_seen_at) values (${candidateId}::uuid, gen_random_uuid(), ${`https://www.linkedin.com/posts/h-${randomUUID()}`}, 'post', ${`hiring ${i}`}, ${inWindow(i)})`.execute(database.db)
  }
}

describe("own record shows the Stack posts parts (gate:25, :34, :41)", () => {
  it("gate:25 Ada with her own record: new posts and failing feeds, in the email and the count line", async () => {
    await setOwnStack(database.db, adaId)
    await insertStackPosts(database.db, adaId, 2, { prefix: "ada", firstSeen: inWindow })
    await failingFeed(adaId, "React posts")
    expect(await summaryFor(adaId)).toMatchObject({ verified: true, newCount: 2 })
    smtp.reset()
    await database.db.deleteFrom("notification_outbox").execute()
    const { text } = await send(adaId)
    expect(text).toContain("New Stack posts: 2")
    expect(text).toContain("Failing Alert feeds")
    expect(text).toContain("React posts (…654321): Redirected (not followed)")
    expect(lastLine(text)).toBe("0 not a match, 0 failed, 0 unsure, 2 new Stack posts.")
  })

  it("gate:34 her own record and no new posts: 'No new Stack posts.'", async () => {
    await setOwnStack(database.db, adaId)
    const { text } = await send(adaId)
    expect(text).toContain("No new Stack posts.")
  })

  it("gate:41 an invitee's summary shows her Stack posts parts on her own record, with no legacy row", async () => {
    await setLegacy(database.db, false)
    await setOwnStack(database.db, bolaId)
    await insertStackPosts(database.db, bolaId, 2, { prefix: "bola", firstSeen: inWindow })
    const { text } = await send(bolaId)
    expect(text).toContain("New Stack posts: 2")
    expect(text).toContain("bola post 0")
    expect(text).toContain("bola post 1")
  })
})

describe("without her own record the Stack posts parts are left out (gate:51, :134)", () => {
  it.each([
    ["no other record exists", async (): Promise<void> => undefined],
    ["the legacy shared record exists", async () => setLegacy(database.db, true)],
    ["bola has her own Stack posts record", async () => setOwnStack(database.db, bolaId)],
    ["ada has her own Hiring record", async () => setHiringRecord(database.db, adaId)],
  ] as const)("Ada, no record of her own (%s): search links only; no posts part, no 'No new' line, no failing part, no count", async (_name, given) => {
    await given()
    await insertStackPosts(database.db, adaId, 2, { prefix: "ada", firstSeen: inWindow })
    await failingFeed(adaId, "React posts")
    expect(await summaryFor(adaId)).toMatchObject({ verified: false, newPosts: [], newCount: 0, failingFeeds: [] })
    smtp.reset()
    await database.db.deleteFrom("notification_outbox").execute()
    const { text } = await send(adaId)
    expect(text).toContain("LinkedIn posts: ")
    expect(text).not.toContain("New Stack posts")
    expect(text).not.toContain("No new Stack posts.")
    expect(text).not.toContain("Failing Alert feeds")
    // No Stack posts count; a Hiring count (0 here) appears only when her own Hiring record exists.
    expect(lastLine(text)).not.toMatch(/Stack post/)
    expect(lastLine(text)?.startsWith("0 not a match, 0 failed, 0 unsure")).toBe(true)
  })

  it("gate:134 Ada's record does not add the Stack posts parts to Bola's summary", async () => {
    await setOwnStack(database.db, adaId)
    await insertStackPosts(database.db, bolaId, 1, { prefix: "bola", firstSeen: inWindow })
    const { text } = await send(bolaId)
    expect(text).not.toContain("New Stack posts")
    expect(text).not.toMatch(/new Stack post/)
  })

  it("gate:142 Bola's missing record does not remove the parts from Ada's summary", async () => {
    await setOwnStack(database.db, adaId)
    await insertStackPosts(database.db, adaId, 3, { prefix: "ada", firstSeen: inWindow })
    const { text } = await send(adaId)
    expect(text).toContain("New Stack posts: 3")
  })
})

describe("the summary never reads the legacy row (gate:68, :77; migration:217)", () => {
  it("gate:77 the runtime role cannot read the legacy row: the summary still sends with 'New Stack posts: 1'", async () => {
    await setLegacy(database.db, true)
    await setOwnStack(database.db, adaId)
    await insertStackPosts(database.db, adaId, 1, { prefix: "ada", firstSeen: inWindow })
    const restore = await revokeRuntime(database.db, database.roles.runtime.name, "alert_feed_verification")
    try {
      const { text } = await send(adaId)
      expect(text).toContain("New Stack posts: 1")
    } finally {
      await restore()
    }
  })

  it("gate:68 with the legacy row present and no own record, the parts stay off (the legacy row is not a gate)", async () => {
    await setLegacy(database.db, true)
    await insertStackPosts(database.db, adaId, 1, { prefix: "ada", firstSeen: inWindow })
    expect((await summaryFor(adaId)).verified).toBe(false)
  })
})

describe("search links always; two records, two parts (gate:86, :102)", () => {
  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ] as const)("gate:86, :102 Stack record %s × Hiring record %s: links first; each part follows only its own record; counts match", async (stack, hiring) => {
    if (stack) await setOwnStack(database.db, adaId)
    if (hiring) await setHiringRecord(database.db, adaId)
    await insertStackPosts(database.db, adaId, 2, { prefix: "ada", firstSeen: inWindow })
    await hiringPosts(adaId, 3)
    const summary = await summaryFor(adaId)
    expect(summary).toMatchObject({ verified: stack, hiringVerified: hiring })
    expect(summary.groups.length).toBeGreaterThan(0)
    smtp.reset()
    await database.db.deleteFrom("notification_outbox").execute()
    const { text } = await send(adaId)
    const links = text.indexOf("LinkedIn posts: ")
    const hiringLinks = text.indexOf("Hiring search links")
    expect(links).toBeGreaterThanOrEqual(0)
    expect(hiringLinks).toBeGreaterThan(links)
    expect(text.includes("New Stack posts: 2")).toBe(stack)
    expect(text.includes("New Hiring posts: 3")).toBe(hiring)
    const counts = ["0 not a match, 0 failed, 0 unsure", ...(stack ? ["2 new Stack posts"] : []), ...(hiring ? ["3 new Hiring posts"] : [])].join(", ")
    expect(lastLine(text)).toBe(`${counts}.`)
  })
})

describe("output unchanged from EPIC-0005 for the same verified value (gate:118, :125)", () => {
  async function fixedInputs(): Promise<void> {
    await insertStackPosts(database.db, adaId, 2, { prefix: "fixed", firstSeen: inWindow })
    await failingFeed(adaId, "React posts")
  }

  it("gate:118 own record, no legacy row: the field is still named verified (true) and the Stack posts part is the EPIC-0005 verified text", async () => {
    await setOwnStack(database.db, adaId)
    await fixedInputs()
    const summary = await summaryFor(adaId)
    expect(Object.keys(summary)).toContain("verified")
    expect(summary.verified).toBe(true)
    smtp.reset()
    await database.db.deleteFrom("notification_outbox").execute()
    const { text } = await send(adaId)
    const part = text.slice(text.indexOf("New Stack posts: 2"))
    // EPIC-0005 STACK_COPY (email-content.ts) text, unchanged: title, two rows, failing heading and line.
    expect(part).toContain("New Stack posts: 2")
    expect(part).toContain("fixed post 1")
    expect(part).toContain("fixed post 0")
    expect(part).toMatch(/Failing Alert feeds\n+React posts \(…654321\): Redirected \(not followed\)/)
    expect(text).not.toContain("SNIPPET-SENTINEL")
  })

  it("gate:125 no own record, legacy row present: verified false; the email equals the same render with no legacy row (byte-identical)", async () => {
    await fixedInputs()
    await setLegacy(database.db, true)
    expect((await summaryFor(adaId)).verified).toBe(false)
    smtp.reset()
    await database.db.deleteFrom("notification_outbox").execute()
    const withLegacy = (await send(adaId)).text
    await database.db.deleteFrom("notification_outbox").execute()
    await setLegacy(database.db, false)
    const withoutLegacy = (await send(adaId)).text
    const body = (t: string) => t.replace(/^Message-ID:.*$/gm, "").replace(/^Date:.*$/gm, "")
    expect(body(withLegacy)).toBe(body(withoutLegacy))
  })
})

describe("tenancy and privacy (gate:149, :159; copy-and-unchanged:54)", () => {
  it("gate:149 Bola's summary lists only her posts and failing feeds; Ada's never appear", async () => {
    await setOwnStack(database.db, adaId)
    await setOwnStack(database.db, bolaId)
    await insertStackPosts(database.db, adaId, 1, { prefix: "POST_A", firstSeen: inWindow })
    await failingFeed(adaId, "Ada React")
    await insertStackPosts(database.db, bolaId, 1, { prefix: "POST_B", firstSeen: inWindow })
    const { raw, text } = await send(bolaId)
    expect(text).toContain("POST_B post 0")
    expect(raw).not.toContain("POST_A")
    expect(raw).not.toContain("Ada React")
  })

  it("gate:159 no summary contains a permitted-use basis", async () => {
    await setOwnStack(database.db, adaId, "2026-10-21", "Summary-marker-1a9d")
    await insertStackPosts(database.db, adaId, 1, { firstSeen: inWindow })
    const { raw, html } = await send(adaId)
    expect(raw).not.toContain("Summary-marker-1a9d")
    expect(html).not.toContain("Summary-marker-1a9d")
  })

  it.each([
    ["with her own record and posts", true],
    ["without her own record", false],
  ] as const)("copy-and-unchanged:54 the Stack posts section names no other person or shared record (%s)", async (_name, own) => {
    if (own) await setOwnStack(database.db, adaId)
    await insertStackPosts(database.db, adaId, 2, { firstSeen: inWindow })
    await failingFeed(adaId, "React posts")
    const { text, html } = await send(adaId)
    const stackSection = (t: string) => t.slice(t.indexOf("Stack posts"), t.indexOf("Hiring search links"))
    expect(stackSection(text)).not.toMatch(BANNED)
    const after = text.slice(text.indexOf("Hiring search links"))
    expect(after.slice(0, Math.max(0, after.indexOf("Spend")))).not.toMatch(BANNED)
    expect(html).not.toMatch(/the person who runs your Eve|on behalf of/i)
  })
})

describe("boundary (gate:167)", () => {
  it("gate:167 a record saved at 20:59 WAT gates the 21:00 WAT summary", async () => {
    await insertStackPosts(database.db, adaId, 1, { firstSeen: inWindow })
    clock.set("2026-10-24T19:59:00.000Z")
    await setOwnStack(database.db, adaId, "2026-10-24", "Just in time", new Date("2026-10-24T19:59:00.000Z"))
    clock.set("2026-10-24T20:00:00.000Z")
    const { text } = await send(adaId)
    expect(text).toContain("New Stack posts: 1")
  })
})
