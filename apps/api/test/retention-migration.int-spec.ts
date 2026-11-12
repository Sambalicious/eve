import { randomUUID } from "node:crypto"

import { type Kysely, sql } from "kysely"
import { Migrator } from "kysely/migration"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import { migrations } from "../src/db/migrations/index.js"

/**
 * Migration 0015-retention on a database with slice 7 deletions (PRD E6.1):
 * manually deleted rows are backfilled as 'candidate', live rows stay null;
 * down then up again works; the job's indexes exist (architecture "Statement timeout").
 */
const DATABASE = `ja_retention_mig_${Date.now().toString(36)}`
let admin: Kysely<unknown>
let db: Kysely<unknown>

const before0015 = Object.fromEntries(Object.entries(migrations).filter(([name]) => name < "0015"))
/**
 * The image that shipped 0015-retention as its latest migration. EPIC-0002's
 * tenancy migrations (0016 to 0019) run after it and are tested in their own files.
 */
const through0015 = Object.fromEntries(Object.entries(migrations).filter(([name]) => name < "0016"))
const migrator = (set: typeof migrations) => new Migrator({ db, provider: { getMigrations: async () => set } })

beforeAll(async () => {
  admin = createDatabase(inject("postgresAdminUrl")) as unknown as Kysely<unknown>
  await sql`create database ${sql.id(DATABASE)}`.execute(admin)
  const url = new URL(inject("postgresAdminUrl"))
  url.pathname = `/${DATABASE}`
  db = createDatabase(url.toString()) as unknown as Kysely<unknown>
  const { error } = await migrator(before0015).migrateToLatest()
  if (error) throw error
})

afterAll(async () => {
  await db?.destroy()
  await sql`drop database if exists ${sql.id(DATABASE)} with (force)`.execute(admin)
  await admin?.destroy()
})

async function application(deleted: boolean): Promise<string> {
  const postingId = randomUUID()
  const id = randomUUID()
  await sql`insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, company, structured, status, discovered_at)
    values (${postingId}, ${`https://x.test/${id}`}, ${id.slice(0, 6)}, ${`https://x.test/${id}`}, 'greenhouse', 'automatic', 'employer_board', 'Role', 'Co', '{}', 'ranked', now())`.execute(db)
  await sql`insert into application (id, job_posting_id, application_url, requisition_id, company, role_title, state, created_at, updated_at, details_deleted_at, final_status)
    values (${id}, ${postingId}, ${`https://x.test/${id}`}, ${id.slice(0, 6)}, 'Co', ${deleted ? null : "Role"}, 'documents_ready', now(), now(), ${deleted ? new Date() : null}, ${deleted ? "documents_ready" : null})`.execute(db)
  return id
}

describe("migration 0015-retention", () => {
  it("backfills manual deletions as candidate, adds retention_run and the indexes, and goes down and up again", async () => {
    const gone = await application(true)
    const live = await application(false)
    const up = await migrator(through0015).migrateToLatest()
    if (up.error) throw up.error
    const rows = await sql<{ id: string; details_deleted_by: string | null }>`select id, details_deleted_by from application`.execute(db)
    expect(Object.fromEntries(rows.rows.map((r) => [r.id, r.details_deleted_by]))).toEqual({ [gone]: "candidate", [live]: null })
    await expect(sql`update application set details_deleted_by = 'system' where id = ${live}`.execute(db)).rejects.toThrow()
    const indexes = await sql<{ indexname: string }>`select indexname from pg_indexes where indexname in ('application_live_created_idx', 'submission_event_application_idx', 'retention_run_wat_date_idx', 'application_form_read_pkey') order by indexname`.execute(db)
    expect(indexes.rows.map((r) => r.indexname)).toEqual(["application_form_read_pkey", "application_live_created_idx", "retention_run_wat_date_idx", "submission_event_application_idx"])
    await expect(sql`insert into retention_run (id, wat_date, started_at, outcome) values (${randomUUID()}, '2026-10-20', now(), 'deleted')`.execute(db)).rejects.toThrow()

    const down = await migrator(through0015).migrateDown()
    if (down.error) throw down.error
    const tables = await sql<{ n: number }>`select count(*)::int as n from information_schema.tables where table_name = 'retention_run'`.execute(db)
    expect(tables.rows[0]!.n).toBe(0)
    const again = await migrator(through0015).migrateToLatest()
    if (again.error) throw again.error
    expect((await sql<{ by: string | null }>`select details_deleted_by as by from application where id = ${gone}`.execute(db)).rows[0]!.by).toBe("candidate")
  })
})
