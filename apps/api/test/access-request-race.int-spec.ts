import { randomUUID } from "node:crypto"

import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { AccessRequestRepository, type SubmissionInput } from "../src/access-request/access-request.repository.js"
import { createDatabase } from "../src/db/create-database.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"

/**
 * architecture.r1 7.5 and 7.8: two repositories on two separate pools submit at
 * the same instant. The advisory lock must decide the 50th slot and the
 * same-email window exactly once.
 */
let database: TestDatabase
let first: ReturnType<typeof createDatabase>
let second: ReturnType<typeof createDatabase>
const NOW = new Date("2026-10-21T10:00:00.000Z")
const limits = { perIpHour: 3, perIpDay: 10, globalDay: 50, perIpEnabled: true }

const input = (overrides: Partial<SubmissionInput>): SubmissionInput => ({
  now: NOW,
  ipHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
  limits,
  drop: null,
  email: "ada@example.com",
  emailKey: "ada@example.com",
  note: "",
  ...overrides,
})

beforeAll(async () => {
  database = await startMigratedDatabase()
  first = createDatabase(database.url)
  second = createDatabase(database.url)
})

beforeEach(async () => {
  await database.truncateAll()
})

afterAll(async () => {
  await first?.destroy()
  await second?.destroy()
  await database?.stop()
})

describe("concurrency", () => {
  it("two requests racing for the 50th global slot accept exactly one", async () => {
    for (let i = 0; i < 49; i++) {
      const id = randomUUID()
      await sql`insert into access_request (id, email, email_key, note, created_at, ip_hash, window_id)
        values (${id}, ${`s${i}@example.com`}, ${`s${i}@example.com`}, '', ${NOW}, ${"c".repeat(64)}, ${id})`.execute(database.db)
    }
    for (let round = 0; round < 5; round++) {
      await database.db.deleteFrom("access_request").where("email", "like", "racer%").execute()
      await database.db.deleteFrom("notification_outbox").execute()
      const outcomes = await Promise.all([
        new AccessRequestRepository(new TenantDatabase(first)).submit(input({ email: "racer1@example.com", emailKey: "racer1@example.com" })),
        new AccessRequestRepository(new TenantDatabase(second)).submit(input({ email: "racer2@example.com", emailKey: "racer2@example.com" })),
      ])
      expect(outcomes.map((o) => o.kind).sort()).toEqual(["accepted", "rate_limited_global"])
      const { rows } = await sql<{ n: number }>`select count(*)::int as n from access_request`.execute(database.db)
      expect(rows[0]!.n).toBe(50)
    }
  })

  it("two simultaneous requests from the same email produce one window and one outbox row", async () => {
    for (let round = 0; round < 5; round++) {
      await database.truncateAll()
      const outcomes = await Promise.all([
        new AccessRequestRepository(new TenantDatabase(first)).submit(input({ note: "one" })),
        new AccessRequestRepository(new TenantDatabase(second)).submit(input({ email: "Ada@example.com", note: "two" })),
      ])
      expect(outcomes.map((o) => o.kind)).toEqual(["accepted", "accepted"])
      const rows = await database.db.selectFrom("access_request").select(["id", "window_id"]).execute()
      expect(new Set(rows.map((r) => r.window_id)).size).toBe(1)
      const outbox = await database.db.selectFrom("notification_outbox").select("access_request_window_id").where("kind", "=", "access_request").execute()
      expect(outbox).toHaveLength(1)
      expect(outbox[0]!.access_request_window_id).toBe(rows[0]!.window_id)
    }
  })

  it("a failure while writing the outbox row stores nothing", async () => {
    // A row already holding the next window id is impossible in practice; a trigger forces the failure.
    await sql`create function fail_access_outbox() returns trigger language plpgsql as $$ begin raise exception 'outbox down'; end $$`.execute(database.db)
    await sql`create trigger fail_access_outbox before insert on notification_outbox for each row when (new.kind = 'access_request') execute function fail_access_outbox()`.execute(database.db)
    try {
      await expect(new AccessRequestRepository(new TenantDatabase(first)).submit(input({}))).rejects.toThrow(/outbox down/)
      const { rows } = await sql<{ n: number }>`select count(*)::int as n from access_request`.execute(database.db)
      expect(rows[0]!.n).toBe(0)
    } finally {
      await sql`drop trigger fail_access_outbox on notification_outbox`.execute(database.db)
      await sql`drop function fail_access_outbox()`.execute(database.db)
    }
  })

  it("a lock wait over 2 s fails with lock_not_available instead of hanging", async () => {
    await database.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtext('eve.access_request'))`.execute(trx)
      const started = Date.now()
      await expect(new AccessRequestRepository(new TenantDatabase(first)).submit(input({}))).rejects.toMatchObject({ code: "55P03" })
      expect(Date.now() - started).toBeLessThan(5_000)
    })
  })
})
