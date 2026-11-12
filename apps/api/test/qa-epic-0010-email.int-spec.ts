import { randomUUID } from "node:crypto"

import { type INestApplicationContext } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { anthropicConfig } from "../src/config/env.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { GmailSmtpMailer } from "../src/notification/mailer.js"
import { type MailerConfig, mailerConfig } from "../src/notification/mailer-config.js"
import { NotificationSender } from "../src/notification/notification-sender.js"
import { NotificationWorkerModule } from "../src/notification/notification.module.js"
import { CLOCK } from "../src/shared/clock.js"
import { FakeSmtp, plainText } from "./support/fake-smtp.js"
import { type PasteStack, descPaystack, startPasteStack } from "./support/qa-epic-0010.js"
import { GOOD_DOCUMENTS, createApplicationFor, generateDocuments, installDocumentProfile, pastedPosting } from "./support/qa-epic-0010-documents.js"
import { PUBLIC_ORIGIN } from "./support/test-app.js"

/**
 * QA test authoring, step [5e], EPIC-0010 (pasted-description-safety.feature r1). The real notification
 * sender against an in-process SMTP server (as notifications.int-spec.ts); nothing reaches a real mail server.
 * Test author: QA author r1, not the independent gate.
 *
 * Covers: SAFE:268.
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

describe("PD-6.5 pasted text appears in no email", () => {
  it("SAFE:268 every notification email due for her is sent and none contains the description's marker", async () => {
    const description = `${descPaystack("QA-SAFE268")}\n${MARKER}\n`
    const postingId = await pastedPosting(s, { marker: "QA-SAFE268", description })
    const applicationId = await createApplicationFor(s, postingId)
    s.anthropic.replyWithObject(GOOD_DOCUMENTS)
    await generateDocuments(s, applicationId)
    expect((await s.database.db.selectFrom("job_posting").select("posting_text").where("id", "=", postingId).executeTakeFirstOrThrow()).posting_text).toContain(MARKER)

    // Everything that can be due for her: the daily summary and per-Application mail for the pasted Application.
    const now = s.clock.now()
    const base = { candidate_id: s.database.operatorId, created_at: now, sent_at: null }
    await s.database.db.insertInto("notification_outbox").values({ ...base, id: randomUUID(), application_id: null, kind: "daily_summary", local_day: "2026-11-02" }).execute()
    for (const kind of ["blocked", "uncertain", "confirmed"] as const) {
      await s.database.db.insertInto("notification_outbox").values({ ...base, id: randomUUID(), application_id: applicationId, kind }).execute()
    }
    await s.database.db.updateTable("application").set({ blocked_reason: "login", blocked_detail: "A login is needed.", blocked_at: now }).where("id", "=", applicationId).execute()

    await sender.get(TenantDatabase).asOperator(() => sender.get(NotificationSender).sendDue())

    expect(smtp.received.length, "at least the daily summary was sent").toBeGreaterThanOrEqual(1)
    for (const email of smtp.received) {
      expect(email.raw).not.toContain(MARKER)
      expect(plainText(email.raw)).not.toContain(MARKER)
      expect(plainText(email.raw)).not.toContain("Paystack helps businesses in Africa")
    }
  })
})
