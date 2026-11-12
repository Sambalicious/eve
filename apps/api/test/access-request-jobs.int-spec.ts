import { randomUUID } from "node:crypto"

import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { AccessRequestRetention } from "../src/worker/access-request-jobs.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"

/** architecture.r1 7.12 and request-access.feature retention scenarios. */
let database: TestDatabase
let retention: AccessRequestRetention
let runtime: ReturnType<typeof createDatabase>
const NOW = new Date("2026-10-21T03:30:00.000Z")
const HOUR = 3_600_000
const DAY = 24 * HOUR
const ago = (ms: number) => new Date(NOW.getTime() - ms)

beforeAll(async () => {
  database = await startMigratedDatabase()
  runtime = createDatabase(database.url)
  retention = new AccessRequestRetention(new TenantDatabase(runtime))
})

beforeEach(async () => {
  await database.truncateAll()
})

afterAll(async () => {
  await runtime?.destroy()
  await database.stop()
})

async function request(createdAt: Date, options: { windowId?: string; outbox?: "pending" | "sending" | "sent" | null } = {}): Promise<string> {
  const id = randomUUID()
  const windowId = options.windowId ?? id
  await sql`insert into access_request (id, email, email_key, note, created_at, ip_hash, window_id)
    values (${id}, 'ada@example.com', 'ada@example.com', 'hi', ${createdAt}, ${"a".repeat(64)}, ${windowId})`.execute(database.db)
  if (options.outbox !== null && windowId === id) {
    await sql`insert into notification_outbox (candidate_id, id, application_id, kind, created_at, status, access_request_window_id)
      values (null, ${randomUUID()}, null, 'access_request', ${createdAt}, ${options.outbox ?? "pending"}, ${id})`.execute(database.db)
  }
  return id
}

const requestIds = async () => (await database.db.selectFrom("access_request").select("id").execute()).map((r) => r.id)
const outboxWindows = async () => (await database.db.selectFrom("notification_outbox").select("access_request_window_id").where("kind", "=", "access_request").execute()).map((r) => r.access_request_window_id)

describe("IP-hash cleanup", () => {
  it("keeps a hash at 23 h 59 min and clears it at exactly 24 h", async () => {
    const kept = await request(ago(24 * HOUR - 60_000))
    const cleared = await request(ago(DAY))
    await retention.clearIpHashes(NOW)
    const rows = await database.db.selectFrom("access_request").select(["id", "ip_hash"]).execute()
    expect(rows.find((r) => r.id === kept)!.ip_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(rows.find((r) => r.id === cleared)!.ip_hash).toBeNull()
  })

  it("deletes drop rows at 24 h and keeps younger ones", async () => {
    for (const at of [ago(DAY), ago(DAY - 1_000)]) {
      await sql`insert into access_request_drop (id, ip_hash, reason, created_at) values (${randomUUID()}, ${"b".repeat(64)}, 'honeypot', ${at})`.execute(database.db)
    }
    await retention.clearIpHashes(NOW)
    const drops = await database.db.selectFrom("access_request_drop").select("created_at").execute()
    expect(drops.map((d) => d.created_at.toISOString())).toEqual([ago(DAY - 1_000).toISOString()])
  })
})

describe("90-day retention", () => {
  it.each([
    ["89 days 23 hours", 89 * DAY + 23 * HOUR, true],
    ["90 days", 90 * DAY, false],
    ["120 days", 120 * DAY, false],
  ])("a request received %s ago is kept=%s with its outbox row", async (_label, age, kept) => {
    const id = await request(ago(age))
    await retention.deleteExpired(NOW)
    expect(await requestIds()).toEqual(kept ? [id] : [])
    expect(await outboxWindows()).toEqual(kept ? [id] : [])
  })

  it("a waiting request at 90 days is deleted unsent with its pending outbox row", async () => {
    await request(ago(90 * DAY), { outbox: "pending" })
    await retention.deleteExpired(NOW)
    expect(await requestIds()).toEqual([])
    expect(await outboxWindows()).toEqual([])
  })

  it("keeps the outbox row while a later request in the window remains", async () => {
    const first = await request(ago(90 * DAY))
    const later = await request(ago(89 * DAY), { windowId: first })
    await retention.deleteExpired(NOW)
    expect(await requestIds()).toEqual([later])
    expect(await outboxWindows()).toEqual([first])
  })

  it("skips an outbox row that is mid-send, and removes it on a later run", async () => {
    const id = await request(ago(90 * DAY), { outbox: "sending" })
    await retention.deleteExpired(NOW)
    expect(await requestIds()).toEqual([])
    expect(await outboxWindows()).toEqual([id])
    await database.db.updateTable("notification_outbox").set({ status: "sent" }).execute()
    await retention.deleteExpired(NOW)
    expect(await outboxWindows()).toEqual([])
  })

  it("deletes cap alerts older than 90 days and keeps other kinds", async () => {
    await sql`insert into notification_outbox (candidate_id, id, application_id, kind, created_at, local_day, status) values
      (null, ${randomUUID()}, null, 'access_request_cap', ${ago(91 * DAY)}, '2026-07-21', 'sent'),
      (null, ${randomUUID()}, null, 'access_request_cap', ${ago(10 * DAY)}, '2026-10-11', 'sent'),
      (${database.operatorId}, ${randomUUID()}, null, 'daily_summary', ${ago(200 * DAY)}, '2026-04-01', 'sent')`.execute(database.db)
    await retention.deleteExpired(NOW)
    const kinds = await database.db.selectFrom("notification_outbox").select(["kind", sql<string>`local_day::text`.as("day")]).orderBy("created_at").execute()
    expect(kinds).toEqual([{ kind: "daily_summary", day: "2026-04-01" }, { kind: "access_request_cap", day: "2026-10-11" }])
  })
})
