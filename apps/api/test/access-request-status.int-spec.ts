import { randomUUID } from "node:crypto"

import type { INestApplication } from "@nestjs/common"
import { NOTIFICATION_STATUS_PATH, notificationStatusSchema } from "@eve/contracts"
import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/** architecture.r1 7.11: `accessRequests` in GET /v1/notifications/status, excluded from C-NOTIFY-1. */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let candidate: SignedInCandidate

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock: new TestClock(new Date()) })
  candidate = await signInCandidate(new Browser(app, google))
})

beforeEach(async () => {
  await database.db.deleteFrom("notification_outbox").execute()
  await database.db.deleteFrom("notification_sender_state").execute()
  await database.db.deleteFrom("access_request").execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

async function configured(value: boolean) {
  await database.db.insertInto("notification_sender_state").values({ singleton: true, configured: value, updated_at: new Date() }).execute()
}

async function windowRow(status: "pending" | "sending" | "sent" | "failed", email = `v${randomUUID().slice(0, 6)}@example.com`) {
  const id = randomUUID()
  await sql`insert into access_request (id, email, email_key, note, created_at, ip_hash, window_id) values (${id}, ${email}, ${email}, 'secret note', now(), null, ${id})`.execute(database.db)
  await sql`insert into notification_outbox (candidate_id, id, application_id, kind, created_at, status, access_request_window_id, last_failed_at)
    values (null, ${randomUUID()}, null, 'access_request', now(), ${status}, ${id}, ${status === "failed" ? new Date() : null})`.execute(database.db)
}

async function status() {
  const response = await candidate.get(NOTIFICATION_STATUS_PATH).expect(200)
  return notificationStatusSchema.parse(response.body)
}

describe("accessRequests in the notification status", () => {
  it("counts waiting windows when the sender is unconfigured and keeps them out of pendingCount", async () => {
    await configured(false)
    await windowRow("pending")
    await windowRow("pending")
    const body = await status()
    expect(body.accessRequests).toEqual({ waiting: 2, failed: 0 })
    expect(body.pendingCount).toBe(0)
    expect(body.latestFailure).toBeNull()
  })

  it("waiting is 0 when the sender is configured", async () => {
    await configured(true)
    await windowRow("pending")
    expect((await status()).accessRequests).toEqual({ waiting: 0, failed: 0 })
  })

  it("counts failed access-request and cap emails, never as C-NOTIFY-1", async () => {
    await configured(true)
    await windowRow("failed")
    await sql`insert into notification_outbox (candidate_id, id, application_id, kind, created_at, local_day, status, last_failed_at) values (null, ${randomUUID()}, null, 'access_request_cap', now(), '2026-10-21', 'failed', now())`.execute(database.db)
    const body = await status()
    expect(body.accessRequests).toEqual({ waiting: 0, failed: 2 })
    expect(body.latestFailure).toBeNull()
  })

  it("clears once the window is sent", async () => {
    await configured(true)
    await windowRow("sent")
    expect((await status()).accessRequests).toEqual({ waiting: 0, failed: 0 })
  })

  it("never returns a visitor email or note", async () => {
    await configured(false)
    await windowRow("pending", "ada@example.com")
    const response = await candidate.get(NOTIFICATION_STATUS_PATH).expect(200)
    expect(JSON.stringify(response.body)).not.toContain("ada@example.com")
    expect(JSON.stringify(response.body)).not.toContain("secret note")
  })

  it("is not available without a session", async () => {
    const response = await new Browser(app, google).http().get(NOTIFICATION_STATUS_PATH)
    expect(response.status).toBe(401)
  })
})
