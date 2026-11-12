import type { INestApplication } from "@nestjs/common"
import { NOTIFICATION_STATUS_PATH, notificationStatusSchema } from "@eve/contracts"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { MissingCandidateScopeError } from "../src/db/candidate-scope.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import type { RenderedEmail } from "../src/notification/email-content.js"
import { AccessRequestOutboxRepository } from "../src/notification/access-request-outbox.repository.js"
import { NotificationRepository } from "../src/notification/notification.repository.js"
import { NotificationSender } from "../src/notification/notification-sender.js"
import { StackPostsSummaryReader } from "../src/stack-posts/stack-posts-summary.js"
import { NotificationStatusService } from "../src/notification/notification-status.service.js"
import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { insertSecondCandidate } from "./support/second-candidate.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { PUBLIC_ORIGIN, TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0002 A1 unit 2 (notifications group): the outbox belongs to one
 * Candidate. The status route counts only the session Candidate's rows, and the
 * worker's Operator-scoped sender never claims, sends or fails another
 * Candidate's row (Operator only until slice F). No mail server is involved: a
 * recording Mailer stands in, so nothing leaves the process.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let owner: SignedInCandidate
let otherId: string
const clock = new TestClock("2026-10-20T09:00:00.000Z")
const OTHER_PENDING = "00000000-0000-4000-8000-0000000000e1"
const OTHER_FAILED = "00000000-0000-4000-8000-0000000000e2"
const OTHER_SENDING = "00000000-0000-4000-8000-0000000000e3"
const sent: RenderedEmail[] = []

function recordingSender(): NotificationSender {
  const mailer = { send: async (email: RenderedEmail) => void sent.push(email) }
  const config = { user: "sender@example.test", to: "owner@example.test", dashboardOrigin: PUBLIC_ORIGIN } as never
  return new NotificationSender(app.get(NotificationRepository), mailer, config, clock, { recordEmail: async () => undefined } as never, new StackPostsSummaryReader(app.get(TenantDatabase)), app.get(AccessRequestOutboxRepository))
}

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  owner = await signInCandidate(new Browser(app, google))
  otherId = await insertSecondCandidate(database.db)
})

beforeEach(async () => {
  sent.length = 0
  await database.db.deleteFrom("notification_outbox").execute()
  await database.db.deleteFrom("notification_sender_state").execute()
  const at = new Date("2026-10-19T20:00:00.000Z")
  await database.db
    .insertInto("notification_outbox")
    .values([
      { candidate_id: otherId, id: OTHER_PENDING, application_id: null, kind: "daily_summary", local_day: "2026-10-19", created_at: at, sent_at: null },
      { candidate_id: otherId, id: OTHER_FAILED, application_id: null, kind: "daily_summary", local_day: "2026-10-18", created_at: at, sent_at: null, status: "failed", last_error: "auth_failed", last_failed_at: at, attempts: 5 },
      { candidate_id: otherId, id: OTHER_SENDING, application_id: null, kind: "daily_summary", local_day: "2026-10-17", created_at: at, sent_at: null, status: "sending", attempts: 1 },
    ])
    .execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

const otherRows = () => database.db.selectFrom("notification_outbox").select(["id", "status", "attempts"]).where("candidate_id", "=", otherId).orderBy("id").execute()
const UNTOUCHED = [
  { id: OTHER_PENDING, status: "pending", attempts: 0 },
  { id: OTHER_FAILED, status: "failed", attempts: 5 },
  { id: OTHER_SENDING, status: "sending", attempts: 1 },
]

describe("notifications group is scoped to one Candidate", () => {
  it("the status route counts none of the other Candidate's pending or failed rows", async () => {
    const status = notificationStatusSchema.parse((await owner.get(NOTIFICATION_STATUS_PATH).expect(200)).body)
    expect(status).toMatchObject({ pendingCount: 0, latestFailure: null })
  })

  it("the Operator-scoped sender claims and sends none of the other Candidate's rows", async () => {
    const result = await app.get(TenantDatabase).asOperator(() => recordingSender().sendDue())
    expect(result).toEqual({ sent: 0, retrying: 0, failed: 0, skipped: null })
    expect(sent).toEqual([])
    expect(await otherRows()).toEqual(UNTOUCHED)
  })

  it("the Operator's daily summary is its own row and leaves the other Candidate's summary for the same day alone", async () => {
    const created = await app.get(TenantDatabase).asOperator(() => app.get(NotificationRepository).enqueueDailySummary("2026-10-19", clock.now()))
    expect(created).toBe(true)
    expect(await otherRows()).toEqual(UNTOUCHED)
  })

  it("boot recovery fails each Candidate's interrupted row in that Candidate's scope", async () => {
    const counts = await app.get(TenantDatabase).eachCandidate(() => app.get(NotificationRepository).failInterrupted(clock.now()))
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(1)
    expect(await otherRows()).toEqual([UNTOUCHED[0], UNTOUCHED[1], { id: OTHER_SENDING, status: "failed", attempts: 1 }])
  })

  it("refuses a notifications call outside any Candidate scope", async () => {
    await expect(app.get(NotificationStatusService).status()).rejects.toBeInstanceOf(MissingCandidateScopeError)
  })
})
