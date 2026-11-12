import { sql } from "kysely"
import { PgBoss } from "pg-boss"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import { migrateToLatest } from "../src/db/migrator.js"
import { SessionRepository } from "../src/auth/session.repository.js"
import { SessionService } from "../src/auth/session.service.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { TestClock } from "./support/test-clock.js"

let database: TestDatabase

beforeAll(async () => {
  database = await startMigratedDatabase()
})

afterAll(async () => {
  await database?.stop()
})

describe("migrations", () => {
  it("creates the session and sign-in attempt tables on a fresh database", async () => {
    const tables = await sql<{ table_name: string }>`
      select table_name from information_schema.tables
      where table_schema = 'public' order by table_name`.execute(database.db)
    expect(tables.rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining(["dashboard_session", "sign_in_attempt", "kysely_migration"])
    )
  })

  it("is idempotent: a second run applies nothing", async () => {
    expect(await migrateToLatest(database.db)).toEqual([])
  })

  it("indexes last_active_at for the expiry cutoff", async () => {
    const indexes = await sql<{ indexname: string }>`
      select indexname from pg_indexes where tablename = 'dashboard_session'`.execute(database.db)
    expect(indexes.rows.map((row) => row.indexname)).toContain(
      "dashboard_session_last_active_at_idx"
    )
  })
})

// dashboard.feature @duplicate "A signed-in Candidate opening the sign-in page goes to Home"
// ("no second session is created") and the brief's concurrent sign-in requirement.
describe("concurrency", () => {
  it("concurrent sign-ins each get their own session and none collide", async () => {
    await sql`truncate dashboard_session`.execute(database.db)
    const service = new SessionService(new SessionRepository(database.db), new TestClock(new Date()))
    const ids = await Promise.all(Array.from({ length: 20 }, () => service.start(database.operatorId, "sub-1")))
    expect(new Set(ids).size).toBe(20)
    const rows = await database.db.selectFrom("dashboard_session").select("id_hash").execute()
    expect(rows).toHaveLength(20)
  })

  it("concurrent requests on an expired session cannot revive it", async () => {
    await sql`truncate dashboard_session`.execute(database.db)
    const clock = new TestClock("2026-10-01T08:00:00Z")
    const service = new SessionService(new SessionRepository(database.db), clock)
    const id = await service.start(database.operatorId, "sub-1")
    clock.set("2026-10-15T08:00:01Z")

    const results = await Promise.all(Array.from({ length: 10 }, () => service.resume(id)))
    expect(results.every((result) => result.kind === "expired")).toBe(true)
    const rows = await database.db.selectFrom("dashboard_session").selectAll().execute()
    expect(rows).toHaveLength(0)
  })

  it("concurrent requests on an active session all succeed and keep one row", async () => {
    await sql`truncate dashboard_session`.execute(database.db)
    const clock = new TestClock("2026-10-01T08:00:00Z")
    const service = new SessionService(new SessionRepository(database.db), clock)
    const id = await service.start(database.operatorId, "sub-1")
    clock.set("2026-10-10T08:00:00Z")

    const results = await Promise.all(Array.from({ length: 10 }, () => service.resume(id)))
    expect(results.every((result) => result.kind === "active")).toBe(true)
    const rows = await database.db.selectFrom("dashboard_session").selectAll().execute()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.last_active_at.toISOString()).toBe("2026-10-10T08:00:00.000Z")
  })
})

describe("worker queue", () => {
  it("pg-boss starts as the runtime role against the schema the owner installed", async () => {
    const errors: Error[] = []
    // Runtime role, migrate: false, exactly as the worker starts it (SEC-001).
    const boss = new PgBoss({ connectionString: database.url, migrate: false })
    boss.on("error", (error: Error) => errors.push(error))
    await boss.start()
    await boss.stop({ graceful: true, close: true })
    expect(errors).toEqual([])
    const schema = await sql<{ n: string }>`
      select count(*)::text as n from information_schema.schemata where schema_name = 'pgboss'`.execute(
      database.db
    )
    expect(schema.rows[0]?.n).toBe("1")
  })
})

describe("migrate CLI", () => {
  it("applies migrations to an empty database via the shared migrator", async () => {
    const target = `cli_target_${Date.now()}`
    const admin = createDatabase(database.adminUrl)
    await sql`create database ${sql.id(target)}`.execute(admin)
    const url = new URL(database.adminUrl)
    url.pathname = `/${target}`
    const targetDb = createDatabase(url.toString())
    try {
      expect(await migrateToLatest(targetDb)).toEqual(["0001-dashboard-auth", "0002-career-profile", "0003-salary-amount-max", "0004-discovery", "0005-applications-documents", "0006-submission", "0007-submission-review", "0008-submission-repair", "0009-notification-sender", "0010-cost-ceiling", "0011-postings-paging-filter", "0012-job-criteria", "0013-stack-posts", "0014-access-request", "0015-retention", "0016-multi-candidate", "0017-row-level-security", "0018-owner-preferences", "0019-candidate-posting", "0020-role-relevance", "0021-hiring-posts", "0022-candidate-binding", "0023-runtime-no-temporary", "0024-alert-feed-candidate-verification", "0025-apply-anyway", "0026-apply-anyway-bounds", "0027-preferences-version", "0028-ats-skills", "0029-ats-fit", "0030-ats-minimum", "0031-pasted-description", "0032-stuck-checking", "0033-simplify-eve", "0034-forward-statements", "0035-manual-apply-lane", "0036-retry-failed-checks", "0037-retry-backfill", "0038-lead-pipeline", "0039-blocked-claim-cause", "0040-outreach-messages", "0041-lead-policy-binding"])
    } finally {
      await targetDb.destroy()
      await sql`drop database ${sql.id(target)}`.execute(admin)
      await admin.destroy()
    }
  })
})
