import { randomUUID } from "node:crypto"

import { pasteJobLinkResponseSchema } from "@eve/contracts"
import { type INestApplicationContext } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { anthropicConfig } from "../src/config/env.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { DiscoveryRepository } from "../src/discovery/discovery.repository.js"
import { GmailSmtpMailer } from "../src/notification/mailer.js"
import { type MailerConfig, mailerConfig } from "../src/notification/mailer-config.js"
import { NotificationSender } from "../src/notification/notification-sender.js"
import { NotificationWorkerModule } from "../src/notification/notification.module.js"
import { CLOCK } from "../src/shared/clock.js"
import { FakeSmtp, plainText } from "./support/fake-smtp.js"
import { COMPANY, type PasteStack, descPaystack, startPasteStack } from "./support/qa-epic-0010.js"
import { GOOD_DOCUMENTS, createApplicationFor, generateDocuments, installDocumentProfile, pastedPosting } from "./support/qa-epic-0010-documents.js"
import { PUBLIC_ORIGIN } from "./support/test-app.js"

/**
 * QA gate r1, step [6a], EPIC-0010 (candidate 083748bd). Gap tests added by the gate session where the
 * author r1 tests stop short of the scenario. Real routes, Postgres and the real notification sender
 * against an in-process SMTP server; the model answered by FakeAnthropic. No product code is touched.
 *
 * Covers:
 * - SAFE:166: the author test reads waiting rows with raw SQL. The worker's spend tick releases waiting
 *   postings through DiscoveryRepository.waitingIds, which applies the EPIC-0006 visibility filter. This
 *   checks that query returns a pasted description saved during the pause, including one whose title
 *   EPIC-0006 would otherwise hide (OQ-5 exemption), so the pause end really reaches it.
 * - SAFE:268: the author test asserts at least one email. This checks that each email type that can
 *   carry a pasted Application's facts (daily summary, blocked) and the cost-pause email are sent,
 *   that the blocked email is about the pasted Application, and that none contains the marker.
 */
const SENDER = "ada.okafor@gmail.com"
const APP_PASSWORD = "abcdefghijklmnop"
const MARKER = "ZX-PASTE-MARKER-7731"

let s: PasteStack
let smtp: FakeSmtp
let config: MailerConfig
let sender: INestApplicationContext

beforeAll(async () => {
  s = await startPasteStack()
  await installDocumentProfile(s)
  smtp = new FakeSmtp(SENDER, APP_PASSWORD)
  await smtp.start()
  config = mailerConfig({ user: SENDER, to: SENDER, dashboardOrigin: PUBLIC_ORIGIN, transport: { host: "127.0.0.1", port: smtp.port, secure: false, ignoreTLS: true }, appPassword: APP_PASSWORD })
  const { ConfigModule } = await import("../src/config/config.module.js")
  const { DatabaseModule } = await import("../src/db/database.module.js")
  const { ClockModule } = await import("../src/shared/clock.js")
  sender = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ databaseUrl: s.database.url, statementTimeoutMs: 60_000, anthropic: anthropicConfig(undefined, "claude-haiku-5-5") }),
      ClockModule,
      DatabaseModule,
      NotificationWorkerModule.forRoot(config, { mailer: new GmailSmtpMailer(config, { connectionTimeout: 2_000, greetingTimeout: 2_000, socketTimeout: 1_500 }) }),
    ],
  })
    .overrideProvider(CLOCK)
    .useValue(s.clock)
    .compile()
    .then((moduleRef) => moduleRef.init())
}, 180_000)

beforeEach(async () => {
  await s.reset()
  await s.database.db.deleteFrom("notification_outbox").execute()
  smtp.reset()
  await installDocumentProfile(s)
})

afterAll(async () => {
  await sender?.close()
  await smtp?.stop()
  await s?.stop()
})

describe("SAFE:166 the pause release query reaches a pasted description saved during a cost pause", () => {
  it.each([
    ["an on-target title", "Senior Frontend Engineer"],
    ["a title EPIC-0006 would hide as off target", "Head Chef"],
  ])("with %s, DiscoveryRepository.waitingIds returns it once the pause ends", async (_label, title) => {
    await s.database.db.updateTable("control_state").set({ cost_paused: true }).execute()
    const response = await s.paste(s.ada, { description: descPaystack(`QA-GATE-SAFE166-${title}`), title, company: COMPANY })
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    const pasted = pasteJobLinkResponseSchema.parse(response.body)
    expect(pasted.posting.status).toBe("waiting_to_be_checked")
    expect(s.anthropic.requests).toHaveLength(0)

    await s.database.db.updateTable("control_state").set({ cost_paused: false }).execute()
    const waiting = await s.app.get(TenantDatabase).asOperator(() => s.app.get(DiscoveryRepository).waitingIds(50, s.clock.now()))
    expect(waiting).toContain(pasted.posting.id)
  })
})

describe("SAFE:268 pasted text appears in no email, with every email type actually sent", () => {
  it("daily summary, blocked (for the pasted Application) and cost-pause emails are all sent and none contains the marker", async () => {
    const postingId = await pastedPosting(s, { marker: "QA-GATE-SAFE268", description: `${descPaystack("QA-GATE-SAFE268")}\n${MARKER}\n` })
    const applicationId = await createApplicationFor(s, postingId)
    s.anthropic.replyWithObject(GOOD_DOCUMENTS)
    await generateDocuments(s, applicationId)
    expect((await s.database.db.selectFrom("job_posting").select("posting_text").where("id", "=", postingId).executeTakeFirstOrThrow()).posting_text).toContain(MARKER)

    const now = s.clock.now()
    const base = { candidate_id: s.database.operatorId, created_at: now, sent_at: null }
    await s.database.db.updateTable("application").set({ blocked_reason: "login", blocked_detail: "A login is needed.", blocked_at: now }).where("id", "=", applicationId).execute()
    await s.database.db.insertInto("notification_outbox").values({ ...base, id: randomUUID(), application_id: null, kind: "daily_summary", local_day: "2026-11-02" }).execute()
    await s.database.db.insertInto("notification_outbox").values({ ...base, id: randomUUID(), application_id: applicationId, kind: "blocked" }).execute()
    await s.database.db
      .insertInto("notification_outbox")
      .values({ ...base, id: randomUUID(), application_id: null, kind: "cost_pause", local_day: null, payload: JSON.stringify({ month: "2026-11-01", spentMicros: 50_000_000, ceilingMicros: 50_000_000, action: null, estimateMicros: null, pausedAt: now.toISOString() }) })
      .execute()

    const result = await sender.get(TenantDatabase).asOperator(() => sender.get(NotificationSender).sendDue())
    expect(result).toMatchObject({ sent: 3, retrying: 0, failed: 0 })
    expect(smtp.received).toHaveLength(3)
    const texts = smtp.received.map((email) => plainText(email.raw))
    // The blocked email is about the pasted Application (its typed company), so the per-Application path ran.
    expect(texts.filter((text) => text.includes(COMPANY)).length).toBeGreaterThanOrEqual(1)
    for (const [index, email] of smtp.received.entries()) {
      expect(email.raw).not.toContain(MARKER)
      expect(texts[index]).not.toContain(MARKER)
      expect(texts[index]).not.toContain("Paystack helps businesses in Africa")
    }
  })
})
