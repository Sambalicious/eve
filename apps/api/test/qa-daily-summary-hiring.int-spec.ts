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
import { StackPostsSummaryReader } from "../src/stack-posts/stack-posts-summary.js"
import { FakeSmtp, plainText as plainTextLatin1 } from "./support/fake-smtp.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { AC34_GOOGLE, AC34_LINKEDIN, EMAIL_COPY, type Family, type Hint, ROLE_PHRASES, hiringGroups } from "./support/qa-hiring-oracle.js"
import { insertSecondCandidate } from "./support/second-candidate.js"
import { PUBLIC_ORIGIN } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * QA-authored (EPIC-0007 Phase 1, run epic-0007-p1, test authoring):
 * daily-summary-hiring.feature r2 @phase1 scenarios (AC 4.1, 4.2, D6) through
 * the production NotificationSender, the real StackPostsSummaryReader and the
 * Gmail SMTP adapter pointed at the in-process FakeSmtp, as
 * stack-posts-summary.int-spec.ts does. Synthetic credentials; nothing leaves
 * the machine. Expected links come from support/qa-hiring-oracle.ts and the
 * contract's literal AC 3.4 example, not from @eve/contracts.
 */
const SENDER = "ada.okafor@gmail.com"
const APP_PASSWORD = "abcdefghijklmnop"

let database: TestDatabase
let runtime: Kysely<Database>
let smtp: FakeSmtp
let config: MailerConfig
let sender: INestApplicationContext
let otherId: string
let operatorPrefs: Record<string, unknown>
const clock = new TestClock("2026-10-25T20:00:00.000Z")
/** QA-P1-T-01: SMTP lines end in CRLF; normalise to "\n" as stack-posts-summary.int-spec.ts does. */
const plainText = (raw: string) => Buffer.from(plainTextLatin1(raw), "latin1").toString("utf8").replace(/\r\n/g, "\n")
/** The whole message with quoted-printable undone, as UTF-8 (the HTML part). */
const decodedRaw = (raw: string) =>
  Buffer.from(raw.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))), "latin1")
    .toString("utf8")
    .replace(/\r\n/g, "\n")
const htmlDecode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")

const ALL: Hint[] = ["remote", "relocation", "visa sponsorship"]
type Prefs = { remoteAccepted: boolean; relocationAccepted: boolean; sponsorshipNeededForRelocation: boolean }
const ALL_PREFS: Prefs = { remoteAccepted: true, relocationAccepted: true, sponsorshipNeededForRelocation: true }

beforeAll(async () => {
  database = await startMigratedDatabase()
  runtime = createDatabase(database.url)
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
  otherId = await insertSecondCandidate(database.db, "bola.summary@example.test")
  await database.db.insertInto("job_criteria").values({ candidate_id: otherId, min_core_match_percent: 70 }).onConflict((oc) => oc.column("candidate_id").doNothing()).execute()
  operatorPrefs = (await database.db.selectFrom("job_preferences").select("values").where("candidate_id", "=", database.operatorId).executeTakeFirstOrThrow()).values as Record<string, unknown>
})

beforeEach(async () => {
  clock.set("2026-10-25T20:00:00.000Z")
  smtp.reset()
  for (const table of ["notification_outbox", "stack_post", "alert_feed", "alert_feed_candidate_verification", "ai_call", "spend_entry"] as const) await database.db.deleteFrom(table).execute()
  await sql`update job_preferences set values = ${JSON.stringify(operatorPrefs)}::jsonb where candidate_id = ${database.operatorId}::uuid`.execute(database.db)
  await database.db.deleteFrom("job_preferences").where("candidate_id", "=", otherId).execute()
})

afterAll(async () => {
  await sender?.close()
  await smtp?.stop()
  await runtime?.destroy()
  await database?.stop()
})

async function criteria(candidateId: string, families: Family[], frameworks: string[], technologies: string[] = []): Promise<void> {
  await database.db.updateTable("job_criteria").set({ target_role_families: families, frameworks, technologies }).where("candidate_id", "=", candidateId).execute()
}

async function prefs(candidateId: string, values: Prefs): Promise<void> {
  await sql`insert into job_preferences (candidate_id, version, values) values (${candidateId}::uuid, 1, ${JSON.stringify(values)}::jsonb)
    on conflict (candidate_id) do update set values = job_preferences.values || excluded.values`.execute(database.db)
}

/** Sends the Operator's due daily summary through the production sender; returns the raw message. */
async function sendOperatorSummary(day = "2026-10-25"): Promise<{ raw: string; text: string; html: string }> {
  await database.db.insertInto("notification_outbox").values({ candidate_id: database.operatorId, id: randomUUID(), application_id: null, kind: "daily_summary", local_day: day, created_at: clock.now(), sent_at: null }).execute()
  expect(await sender.get(TenantDatabase).asOperator(() => sender.get(NotificationSender).sendDue())).toMatchObject({ sent: 1 })
  expect(smtp.received).toHaveLength(1)
  const raw = smtp.received[0]!.raw
  return { raw, text: plainText(raw), html: decodedRaw(raw) }
}

/** The text/plain part from "Hiring search links" up to the next part the summary adds after it. */
function hiringPart(text: string): string {
  const start = text.indexOf(`${EMAIL_COPY.title}\n`)
  expect(start, "the email has a \"Hiring search links\" part").toBeGreaterThanOrEqual(0)
  const rest = text.slice(start)
  const end = rest.search(/\n\n(Spend|Open your dashboard|New Stack posts|No new Stack posts|Failing Alert feeds)/)
  return end === -1 ? rest : rest.slice(0, end)
}

const linkLines = (part: string, label: string) =>
  part
    .split("\n")
    .filter((line) => line.startsWith(`${label}: `))
    .map((line) => line.slice(label.length + 2))

type HiringPart = { family: string | null; groups?: readonly { label: string; linkedin: string; google: string }[]; hasOtherFamilies?: boolean }

/** The reader's `hiring` field (api-contract "Daily summary (internal)"), read in a Candidate's own scope. */
async function readerHiring(candidateId: string): Promise<HiringPart> {
  const tenant = new TenantDatabase(runtime)
  const summary = await CandidateScope.run(candidateId, () => new StackPostsSummaryReader(tenant).summary(randomUUID(), clock.now()))
  return (summary as unknown as { hiring: HiringPart }).hiring
}

describe("the \"Hiring search links\" part (AC 4.1)", () => {
  it("DSH:19 follows the EPIC-0005 Stack posts search links", async () => {
    await criteria(database.operatorId, ["senior_frontend", "fullstack"], ["React"])
    const { text } = await sendOperatorSummary()
    const stackLinks = text.indexOf("Google articles: ")
    expect(stackLinks).toBeGreaterThan(0)
    expect(text.indexOf(`${EMAIL_COPY.title}\n`)).toBeGreaterThan(stackLinks)
    expect(text.indexOf("Stack posts")).toBeLessThan(text.indexOf(EMAIL_COPY.title))
  })

  it("DSH:27 names the first target family in display order (D6) and every role clause is the Frontend clause", async () => {
    await criteria(database.operatorId, ["backend", "fullstack", "senior_frontend"], ["React"])
    const part = hiringPart((await sendOperatorSummary()).text)
    expect(part).toContain(EMAIL_COPY.intro("Frontend"))
    const frontend = `(${ROLE_PHRASES.senior_frontend.map((p) => `"${p}"`).join(" OR ")})`
    for (const href of linkLines(part, EMAIL_COPY.linkLi)) expect(decodeURIComponent(new URL(href).search)).toContain(frontend)
    expect(linkLines(part, EMAIL_COPY.linkLi)).toEqual(hiringGroups("senior_frontend", ["React"], [], ALL).map((g) => g.linkedin))
  })

  it("DSH:35 the AC 3.4 inputs give 1 group \"React, TypeScript\" with exactly the AC 3.4 LinkedIn and Google links and no Alerts query string", async () => {
    await criteria(database.operatorId, ["senior_frontend"], ["React"], ["TypeScript"])
    await prefs(database.operatorId, ALL_PREFS)
    const { text, html } = await sendOperatorSummary()
    const part = hiringPart(text)
    expect(part.split("\n")).toContain("React, TypeScript")
    expect(linkLines(part, EMAIL_COPY.linkLi)).toEqual([AC34_LINKEDIN])
    expect(linkLines(part, EMAIL_COPY.linkG)).toEqual([AC34_GOOGLE])
    expect(htmlDecode(html)).toContain(`href="${AC34_LINKEDIN}"`)
    // No plain-text hiring Alerts query anywhere in the email.
    expect(text).not.toContain('site:linkedin.com/posts ("we\'re hiring"')
    expect(htmlDecode(html)).not.toContain('site:linkedin.com/posts ("we\'re hiring"')
  })

  it("DSH:46 with 2+ families, \"Searches for your other role families\" links to /stack-posts?view=hiring after the groups", async () => {
    await criteria(database.operatorId, ["senior_frontend", "backend"], ["React"])
    const part = hiringPart((await sendOperatorSummary()).text)
    const otherLine = `${EMAIL_COPY.other}: ${PUBLIC_ORIGIN}/stack-posts?view=hiring`
    expect(part.split("\n")).toContain(otherLine)
    expect(part.indexOf(otherLine)).toBeGreaterThan(part.lastIndexOf(`${EMAIL_COPY.linkG}: `))
  })

  it("DSH:46 with one family there is no \"other role families\" link", async () => {
    await criteria(database.operatorId, ["senior_frontend", "other"], ["React"])
    expect((await sendOperatorSummary()).text).not.toContain(EMAIL_COPY.other)
  })

  it("DSH:54 at 40 terms: 10 groups of 4, the groups the Hiring view shows, each with exactly 1 LinkedIn and 1 Google link", async () => {
    const frameworks = Array.from({ length: 20 }, (_, i) => `F${i + 1}`)
    const technologies = Array.from({ length: 20 }, (_, i) => `T${i + 1}`)
    await criteria(database.operatorId, ["senior_frontend"], frameworks, technologies)
    const part = hiringPart((await sendOperatorSummary()).text)
    const expected = hiringGroups("senior_frontend", frameworks, technologies, ALL)
    expect(expected).toHaveLength(10)
    expect(linkLines(part, EMAIL_COPY.linkLi)).toEqual(expected.map((g) => g.linkedin))
    expect(linkLines(part, EMAIL_COPY.linkG)).toEqual(expected.map((g) => g.google))
    for (const group of expected) expect(part.split("\n")).toContain(group.label)
  })

  it("DSH:62 empty technology lists give 1 group \"Any technology\" with no technology clause", async () => {
    await criteria(database.operatorId, ["senior_frontend"], [], [])
    const part = hiringPart((await sendOperatorSummary()).text)
    expect(part.split("\n")).toContain(EMAIL_COPY.groupAny)
    expect(linkLines(part, EMAIL_COPY.linkLi)).toEqual(hiringGroups("senior_frontend", [], [], ALL).map((g) => g.linkedin))
  })

  it("DSH:70 every hiring linkedin.com and google.com link in the HTML has target _blank and rel noopener noreferrer", async () => {
    await criteria(database.operatorId, ["senior_frontend"], ["React"])
    const html = htmlDecode((await sendOperatorSummary()).html)
    const expected = hiringGroups("senior_frontend", ["React"], [], ALL)[0]!
    for (const href of [expected.linkedin, expected.google]) {
      const tag = new RegExp(`<a href="${href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"([^>]*)>`).exec(html)
      expect(tag, href).not.toBeNull()
      expect(tag![1]).toContain('target="_blank"')
      expect(tag![1]).toContain('rel="noopener noreferrer"')
    }
  })

  it("DSH:77 the next summary after a settings save names Backend with group \"Go\"", async () => {
    await criteria(database.operatorId, ["senior_frontend"], ["React"])
    await sendOperatorSummary()
    await criteria(database.operatorId, ["backend"], ["Go"])
    clock.set("2026-10-26T20:00:00.000Z")
    smtp.reset()
    const part = hiringPart((await sendOperatorSummary("2026-10-26")).text)
    expect(part).toContain(EMAIL_COPY.intro("Backend"))
    expect(part.split("\n")).toContain("Go")
    expect(linkLines(part, EMAIL_COPY.linkLi)).toEqual(hiringGroups("backend", ["Go"], [], ALL).map((g) => g.linkedin))
  })

  it("DSH:92 rendering the hiring part makes no AI call and records no spend", async () => {
    await criteria(database.operatorId, ["senior_frontend"], ["React"])
    await sendOperatorSummary()
    expect(await database.db.selectFrom("ai_call").select("id").execute()).toEqual([])
    expect(await database.db.selectFrom("spend_entry").selectAll().execute()).toEqual([])
  })

  it("AC 4.1: the part is built without an Alert feed verification and the plain-text count names no Hiring posts (Phase 1)", async () => {
    await criteria(database.operatorId, ["senior_frontend"], ["React"])
    const { text } = await sendOperatorSummary()
    expect(hiringPart(text)).toContain(EMAIL_COPY.intro("Frontend"))
    expect(text).not.toContain("Hiring post")
  })

  it("DSH:86 no new notification kind: the outbox kind check is unchanged", async () => {
    const { rows } = await sql<{ def: string }>`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'notification_outbox_kind_check'`.execute(database.db)
    for (const kind of ["confirmed", "blocked", "uncertain", "daily_summary", "cost_pause", "access_request", "access_request_cap"]) expect(rows[0]!.def).toContain(`'${kind}'`)
    expect(rows[0]!.def).not.toMatch(/hiring/i)
  })
})

describe("empty and per-Candidate (AC 4.2)", () => {
  it("DSH:101 only Other targeted: C-HP-EMAIL-NOFAMILY and \"Choose role families\" to Settings, no hiring link", async () => {
    await criteria(database.operatorId, ["other"], ["React"])
    const part = hiringPart((await sendOperatorSummary()).text)
    expect(part).toContain(EMAIL_COPY.noFamily)
    expect(part.split("\n")).toContain(`${EMAIL_COPY.noFamilyLink}: ${PUBLIC_ORIGIN}/settings#job-criteria`)
    expect(linkLines(part, EMAIL_COPY.linkLi)).toEqual([])
    expect(part).not.toContain("we%27re%20hiring")
  })

  it("DSH:110 each Candidate's part uses only her own settings and preferences (reader, in each one's scope)", async () => {
    await criteria(database.operatorId, ["senior_frontend"], ["React"])
    await criteria(otherId, ["backend"], ["Django"])
    const ada = await readerHiring(database.operatorId)
    const bola = await readerHiring(otherId)
    expect(ada).toMatchObject({ family: "senior_frontend", hasOtherFamilies: false })
    expect(ada.groups!.map((g) => g.linkedin)).toEqual(hiringGroups("senior_frontend", ["React"], [], ALL).map((g) => g.linkedin))
    expect(bola).toMatchObject({ family: "backend", hasOtherFamilies: false })
    expect(bola.groups!.map((g) => g.linkedin)).toEqual(hiringGroups("backend", ["Django"], [], []).map((g) => g.linkedin))
    const bolaText = decodeURIComponent(JSON.stringify(bola))
    expect(bolaText).not.toContain("React")
    for (const phrase of ROLE_PHRASES.senior_frontend) expect(bolaText).not.toContain(phrase)
    expect(bolaText).not.toContain("remote")
  })

  it("DSH:110 Bola's own preferences, not Ada's, give her hint clause", async () => {
    await criteria(otherId, ["backend"], ["Django"])
    await prefs(otherId, { remoteAccepted: false, relocationAccepted: true, sponsorshipNeededForRelocation: false })
    const bola = await readerHiring(otherId)
    expect(bola.groups!.map((g) => g.linkedin)).toEqual(hiringGroups("backend", ["Django"], [], ["relocation"]).map((g) => g.linkedin))
  })

  it("AC 4.2: the reader returns { family: null } for only Other", async () => {
    await criteria(otherId, ["other"], [])
    expect(await readerHiring(otherId)).toEqual({ family: null })
  })

  it("DSH:127 with the daily summary disabled (no outbox row) no email is sent", async () => {
    await criteria(database.operatorId, ["senior_frontend"], ["React"])
    expect(await sender.get(TenantDatabase).asOperator(() => sender.get(NotificationSender).sendDue())).toMatchObject({ sent: 0 })
    expect(smtp.received).toEqual([])
  })
})
