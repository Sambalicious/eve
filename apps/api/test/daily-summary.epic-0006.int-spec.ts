import { randomUUID } from "node:crypto"

import type { INestApplicationContext } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { anthropicConfig } from "../src/config/env.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import type { RenderedEmail } from "../src/notification/email-content.js"
import type { Mailer } from "../src/notification/mailer.js"
import { mailerConfig } from "../src/notification/mailer-config.js"
import { NotificationSender } from "../src/notification/notification-sender.js"
import { NotificationWorkerModule } from "../src/notification/notification.module.js"
import { CLOCK } from "../src/shared/clock.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { PUBLIC_ORIGIN } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"
import { clearPostings, resetCriteria, seed } from "./support/epic-0006.js"

/**
 * EPIC-0006 QA test authoring, repair wave 1 (run2): the daily summary email,
 * end to end through the real sender with a recording Mailer. Source: gherkin r6
 * hidden-postings-applications-and-links.feature:206-228 (AC-3.10) and
 * evaluation-failure-lines.feature:78-84 (AC-7.7, PROPOSAL P18).
 *
 * Expected red on this branch until Q3-2 merges: "AC-3.10 … failure list holds
 * 'Senior Frontend Engineer at Hooli' only". The failure list has no visibility
 * filter yet, so the hidden Globex Application's failure is still listed.
 */
const DAY = "2026-10-24"
const clock = new TestClock("2026-10-24T19:00:00.000Z") // 20:00 WAT
let database: TestDatabase
let sender: INestApplicationContext
const sent: RenderedEmail[] = []
const mailer: Mailer = { send: async (email) => void sent.push(email) }

beforeAll(async () => {
  database = await startMigratedDatabase()
  const config = mailerConfig({ user: "ada.okafor@gmail.com", to: "ada.okafor@gmail.com", dashboardOrigin: PUBLIC_ORIGIN, transport: { host: "127.0.0.1", port: 1, secure: false, ignoreTLS: true }, appPassword: "abcdefghijklmnop" })
  const { ConfigModule } = await import("../src/config/config.module.js")
  const { DatabaseModule } = await import("../src/db/database.module.js")
  const { ClockModule } = await import("../src/shared/clock.js")
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ databaseUrl: database.url, statementTimeoutMs: 60_000, anthropic: anthropicConfig(undefined, "claude-haiku-5-5") }),
      ClockModule,
      DatabaseModule,
      NotificationWorkerModule.forRoot(config, { mailer }),
    ],
  })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile()
  await moduleRef.init()
  sender = moduleRef
})

beforeEach(async () => {
  sent.length = 0
  clock.set("2026-10-24T19:00:00.000Z")
  await database.db.deleteFrom("notification_outbox").execute()
  await clearPostings(database.db)
  await resetCriteria(database.db)
})

afterAll(async () => {
  await sender?.close()
  await database?.stop()
})

/** An Application for `postingId` that failed on DAY in `state`. */
async function failedApplication(postingId: string, role: string, company: string, state: "documents_failed" | "documents_blocked") {
  await database.db
    .insertInto("application")
    .values({
      candidate_id: database.operatorId,
      id: randomUUID(),
      job_posting_id: postingId,
      application_url: `https://boards.greenhouse.io/qa6/jobs/${postingId}`,
      requisition_id: postingId.slice(0, 12),
      company,
      role_title: role,
      state,
      career_profile_version: 1,
      blocked_document: state === "documents_blocked" ? "resume" : null,
      blocked_claim: state === "documents_blocked" ? "Led a team of 40" : null,
      failure: state === "documents_failed" ? "generation_failed" : null,
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute()
}

/** "that day's daily summary is sent": one outbox row for DAY, sent through the real sender. */
async function sendSummary(): Promise<string> {
  await database.db.insertInto("notification_outbox").values({ id: randomUUID(), candidate_id: database.operatorId, application_id: null, kind: "daily_summary", local_day: DAY, created_at: clock.now(), sent_at: null }).execute()
  await sender.get(TenantDatabase).asOperator(() => sender.get(NotificationSender).sendDue())
  const summaries = sent.filter((email) => email.subject.startsWith("Eve, 24 Oct 2026"))
  expect(summaries).toHaveLength(1)
  return summaries[0]!.text
}

/** The lines of the summary section headed `heading`: the text renders "Heading", a blank line, then one line per item until the next blank line. */
function section(text: string, heading: string): string[] {
  const lines = text.split("\n").map((line) => line.trim())
  const start = lines.findIndex((line) => line === heading)
  expect(start, `section "${heading}"`).toBeGreaterThanOrEqual(0)
  let i = start + 1
  while (i < lines.length && lines[i] === "") i++
  const out: string[] = []
  for (; i < lines.length && lines[i] !== ""; i++) out.push(lines[i]!)
  return out
}

describe("AC-3.10 @AC-3.10 hidden postings are left out of the daily summary's skipped and failure lists (applications-and-links:206-221)", () => {
  async function seedDay() {
    await seed(database.db, database.operatorId, { title: "Hotline Paralegal", company: "Acme Legal", family: null, prefilterSkip: "not_software_role", marker: "none" }, { status: "skipped", skipReason: "not_software_role" })
    await seed(database.db, database.operatorId, { title: "Frontend Engineer", company: "Initech" }, { status: "skipped", skipReason: "weak_core_match", covered: 5 })
    const globex = await seed(database.db, database.operatorId, { title: "Solutions Architect", company: "Globex", family: "solutions_customer" }, { status: "ranked" })
    const hooli = await seed(database.db, database.operatorId, { title: "Senior Frontend Engineer", company: "Hooli" }, { status: "ranked" })
    await failedApplication(globex, "Solutions Architect", "Globex", "documents_failed")
    await failedApplication(hooli, "Senior Frontend Engineer", "Hooli", "documents_blocked")
    // Postings decided on DAY (`seed` stamps 2026-10-20); move them onto the summary's WAT day.
    await database.db.updateTable("candidate_posting").set({ evaluated_at: clock.now(), discovered_at: clock.now() }).execute()
  }

  it("applications-and-links:220 the skipped list holds 'Frontend Engineer at Initech' only", async () => {
    await seedDay()
    const text = await sendSummary()
    const skipped = section(text, "Not a match")
    expect(skipped.filter((line) => line.includes(" at "))).toEqual([expect.stringMatching(/^(?:- )?Frontend Engineer at Initech: your profile backs too few of the core responsibilities$/)])
    expect(text).not.toContain("Hotline Paralegal")
  })

  // Expected red until Q3-2 (failure-list visibility filter) merges.
  it("applications-and-links:221 the failure list holds 'Senior Frontend Engineer at Hooli' only (expected red pending Q3-2)", async () => {
    await seedDay()
    const text = await sendSummary()
    const failures = section(text, "Failures")
    expect(failures.filter((line) => line.includes(" at "))).toEqual([expect.stringMatching(/^(?:- )?Senior Frontend Engineer at Hooli: document validation blocked$/)])
    expect(text).not.toContain("Solutions Architect at Globex")
  })

  it("applications-and-links:224 40 hidden postings stored on DAY: exactly one summary, no line about hidden postings or counts", async () => {
    for (let i = 0; i < 40; i++) await seed(database.db, database.operatorId, { title: `Senior Data Engineer ${i}`, family: "data_ml" }, { status: "skipped", skipReason: "weak_core_match", covered: 5 })
    await database.db.updateTable("candidate_posting").set({ evaluated_at: clock.now(), discovered_at: clock.now() }).execute()
    const text = await sendSummary()
    expect(text).not.toMatch(/hidden/i)
    expect(text).not.toContain("Senior Data Engineer")
    expect(text).toContain("No jobs were ruled out.")
  })
})

describe("AC-7.7 @AC-7.7 @AC-3.10 the daily summary lists no posting evaluation failure (evaluation-failure-lines:78-84, P18)", () => {
  it("a visible timed_out posting failure is not in the failure list and the old retry phrase is absent", async () => {
    await seed(database.db, database.operatorId, { title: "Senior Frontend Engineer", company: "Globex" }, { status: "evaluation_failed", evaluationFailure: "timed_out" })
    await database.db.updateTable("candidate_posting").set({ evaluated_at: clock.now(), discovered_at: clock.now() }).execute()
    const text = await sendSummary()
    expect(section(text, "Failures")).toEqual(["Nothing failed."])
    expect(text).not.toContain("Senior Frontend Engineer at Globex")
    expect(text).not.toContain("Paste the link again later")
  })
})
