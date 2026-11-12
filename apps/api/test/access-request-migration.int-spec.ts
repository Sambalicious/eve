import { randomUUID } from "node:crypto"

import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"

/** Migration 0014 (architecture.r1 7.7): tables, checks and the outbox kinds. */
let database: TestDatabase

beforeAll(async () => {
  database = await startMigratedDatabase()
})
beforeEach(async () => {
  await database.truncateAll()
})
afterAll(async () => {
  await database.stop()
})

const HASH = "a".repeat(64)

async function insertRequest(values: Partial<{ id: string; email: string; email_key: string; note: string; ip_hash: string | null; window_id: string; status: string }> = {}) {
  const id = values.id ?? randomUUID()
  const email = values.email ?? "ada@example.com"
  await sql`insert into access_request (id, email, email_key, note, created_at, ip_hash, window_id, status)
    values (${id}, ${email}, ${values.email_key ?? email.toLowerCase()}, ${values.note ?? ""}, now(), ${values.ip_hash === undefined ? HASH : values.ip_hash}, ${values.window_id ?? id}, ${values.status ?? "waiting"})`.execute(database.db)
  return id
}

const rejects = (promise: Promise<unknown>) => expect(promise).rejects.toThrow()

describe("access_request table", () => {
  it("stores a request with a hash, and with the hash cleared", async () => {
    await insertRequest()
    await insertRequest({ ip_hash: null })
    const { rows } = await sql<{ n: number }>`select count(*)::int as n from access_request`.execute(database.db)
    expect(rows[0]!.n).toBe(2)
  })

  it("refuses a key that isn't the lower-cased email, a bad hash, a long note or status", async () => {
    await rejects(insertRequest({ email: "Ada@example.com", email_key: "Ada@example.com" }))
    await rejects(insertRequest({ ip_hash: "203.0.113.7" }))
    await rejects(insertRequest({ note: "x".repeat(501) }))
    await rejects(insertRequest({ status: "pending" }))
    await rejects(insertRequest({ email: "a@" + "b".repeat(253) }))
  })

  it("holds no column for a raw IP, a name or a user agent", async () => {
    const { rows } = await sql<{ column_name: string }>`
      select column_name from information_schema.columns where table_name = 'access_request' order by ordinal_position`.execute(database.db)
    expect(rows.map((r) => r.column_name)).toEqual(["id", "email", "email_key", "note", "created_at", "ip_hash", "window_id", "status"])
  })
})

describe("access_request_drop table", () => {
  it("stores a hash, a reason and a time only", async () => {
    await sql`insert into access_request_drop (id, ip_hash, reason, created_at) values (${randomUUID()}, ${HASH}, 'honeypot', now())`.execute(database.db)
    await rejects(sql`insert into access_request_drop (id, ip_hash, reason, created_at) values (${randomUUID()}, ${HASH}, 'other', now())`.execute(database.db))
    const { rows } = await sql<{ column_name: string }>`
      select column_name from information_schema.columns where table_name = 'access_request_drop' order by ordinal_position`.execute(database.db)
    expect(rows.map((r) => r.column_name)).toEqual(["id", "ip_hash", "reason", "created_at"])
  })
})

describe("outbox kinds", () => {
  const outbox = (kind: string, windowId: string | null, watDay: string | null) =>
    sql`insert into notification_outbox (candidate_id, id, application_id, kind, created_at, local_day, access_request_window_id)
      values (${kind.startsWith("access_request") ? null : database.operatorId}, ${randomUUID()}, null, ${kind}, now(), ${watDay}, ${windowId})`.execute(database.db)

  it("an access_request row needs a window id, once per window", async () => {
    const windowId = randomUUID()
    await outbox("access_request", windowId, null)
    await rejects(outbox("access_request", windowId, null))
    await rejects(outbox("access_request", null, null))
    await rejects(outbox("blocked", randomUUID(), null))
  })

  it("an access_request_cap row needs a day, once per day", async () => {
    await outbox("access_request_cap", null, "2026-10-21")
    await rejects(outbox("access_request_cap", null, "2026-10-21"))
    await rejects(outbox("access_request_cap", null, null))
    await outbox("access_request_cap", null, "2026-10-22")
  })

  it("daily_summary still needs a day and other kinds still refuse one", async () => {
    await outbox("daily_summary", null, "2026-10-21")
    await rejects(outbox("daily_summary", null, null))
    await rejects(outbox("access_request", randomUUID(), "2026-10-21"))
  })

  it("the runtime role can read and write the new tables in the installation scope (C36)", async () => {
    const { createDatabase } = await import("../src/db/create-database.js")
    const { TenantDatabase } = await import("../src/db/tenant-database.js")
    const runtime = createDatabase(database.url)
    try {
      await new TenantDatabase(runtime).forInstallation(async (tx) => {
        await sql`insert into access_request_drop (id, ip_hash, reason, created_at) values (${randomUUID()}, ${HASH}, 'fill_time', now())`.execute(tx)
        await sql`select count(*) from access_request`.execute(tx)
        await sql`delete from access_request_drop`.execute(tx)
      })
    } finally {
      await runtime.destroy()
    }
  })
})
