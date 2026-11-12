import { randomUUID } from "node:crypto"

import { type Kysely, sql } from "kysely"
import { Migrator } from "kysely/migration"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import { migrationsFor } from "../src/db/migrations/index.js"

const migrations = migrationsFor({ operatorGoogleSub: "google-sub-owner" })

/**
 * Migration 0009 on a database that already has slice 5 outbox rows: pending
 * rows stay pending, sent rows are `sent`, `uncertain` rows become `skipped`
 * (they are never emailed alone), and a duplicate `confirmed` row for one
 * Application is collapsed to the earliest, so the upgrade sends one E1.
 */
const DATABASE = `ja_notify_mig_${Date.now().toString(36)}`
let admin: Kysely<unknown>
let db: Kysely<unknown>

const before0009 = Object.fromEntries(Object.entries(migrations).filter(([name]) => name < "0009"))

beforeAll(async () => {
  admin = createDatabase(inject("postgresAdminUrl")) as unknown as Kysely<unknown>
  await sql`create database ${sql.id(DATABASE)}`.execute(admin)
  const url = new URL(inject("postgresAdminUrl"))
  url.pathname = `/${DATABASE}`
  db = createDatabase(url.toString()) as unknown as Kysely<unknown>
  const { error } = await new Migrator({ db, provider: { getMigrations: async () => before0009 } }).migrateToLatest()
  if (error) throw error
})

afterAll(async () => {
  await db?.destroy()
  await sql`drop database if exists ${sql.id(DATABASE)} with (force)`.execute(admin)
  await admin?.destroy()
})

async function application(): Promise<string> {
  const postingId = randomUUID()
  const id = randomUUID()
  await sql`insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, company, structured, status, discovered_at)
    values (${postingId}, ${`https://x.test/${id}`}, ${id.slice(0, 6)}, ${`https://x.test/${id}`}, 'greenhouse', 'automatic', 'employer_board', 'Role', 'Co', '{}', 'ranked', now())`.execute(db)
  await sql`insert into application (id, job_posting_id, application_url, requisition_id, company, role_title, state, created_at, updated_at)
    values (${id}, ${postingId}, ${`https://x.test/${id}`}, ${id.slice(0, 6)}, 'Co', 'Role', 'documents_ready', now(), now())`.execute(db)
  return id
}

describe("migration 0009 on existing outbox rows", () => {
  it("keeps pending and sent, skips uncertain, and collapses a duplicate confirmed row to the earliest", async () => {
    const [a, b, c] = [await application(), await application(), await application()]
    const rows = [
      { id: randomUUID(), app: a, kind: "confirmed", at: "2026-10-20T09:00:00Z", sent: null },
      { id: randomUUID(), app: a, kind: "confirmed", at: "2026-10-20T09:05:00Z", sent: null },
      { id: randomUUID(), app: b, kind: "blocked", at: "2026-10-20T09:00:00Z", sent: "2026-10-20T09:01:00Z" },
      { id: randomUUID(), app: c, kind: "uncertain", at: "2026-10-20T09:00:00Z", sent: null },
    ]
    for (const row of rows) {
      await sql`insert into notification_outbox (id, application_id, kind, created_at, sent_at) values (${row.id}, ${row.app}, ${row.kind}, ${row.at}, ${row.sent})`.execute(db)
    }
    const { error } = await new Migrator({ db, provider: { getMigrations: async () => migrations } }).migrateToLatest()
    expect(error).toBeUndefined()

    const after = await sql<{ id: string; status: string; attempts: number }>`select id, status, attempts from notification_outbox order by created_at, id`.execute(db)
    const byId = new Map(after.rows.map((row) => [row.id, row]))
    expect(byId.get(rows[0]!.id)).toEqual({ id: rows[0]!.id, status: "pending", attempts: 0 })
    expect(byId.has(rows[1]!.id)).toBe(false)
    expect(byId.get(rows[2]!.id)?.status).toBe("sent")
    expect(byId.get(rows[3]!.id)?.status).toBe("skipped")
    await expect(sql`insert into notification_outbox (candidate_id, id, application_id, kind, created_at) values ((select id from candidate where role = 'operator'), ${randomUUID()}, ${a}, 'confirmed', now())`.execute(db)).rejects.toThrow(/notification_outbox_confirmed_once/)
    await expect(sql`insert into notification_outbox (candidate_id, id, application_id, kind, created_at) values ((select id from candidate where role = 'operator'), ${randomUUID()}, null, 'daily_summary', now())`.execute(db)).rejects.toThrow(/notification_outbox_summary_day/)
  })
})
