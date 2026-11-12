import { randomUUID } from "node:crypto"

import { type Kysely, sql } from "kysely"
import { Migrator } from "kysely/migration"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import { migrations } from "../src/db/migrations/index.js"

/**
 * Migration 0011 on a database that already holds slice 7 postings (8M.1 to
 * 8M.6): titles get their folded form, stored `other` rows move to the new
 * families from the title alone, and nothing else changes.
 */
const DATABASE = `ja_postings_mig_${Date.now().toString(36)}`
let admin: Kysely<unknown>
let db: Kysely<unknown>

const before0011 = Object.fromEntries(Object.entries(migrations).filter(([name]) => name < "0011"))
const through0011 = Object.fromEntries(Object.entries(migrations).filter(([name]) => name < "0012"))

beforeAll(async () => {
  admin = createDatabase(inject("postgresAdminUrl")) as unknown as Kysely<unknown>
  await sql`create database ${sql.id(DATABASE)}`.execute(admin)
  const url = new URL(inject("postgresAdminUrl"))
  url.pathname = `/${DATABASE}`
  db = createDatabase(url.toString()) as unknown as Kysely<unknown>
  const { error } = await new Migrator({ db, provider: { getMigrations: async () => before0011 } }).migrateToLatest()
  if (error) throw error
})

afterAll(async () => {
  await db?.destroy()
  await sql`drop database if exists ${sql.id(DATABASE)} with (force)`.execute(admin)
  await admin?.destroy()
})

async function posting(title: string | null, family: string | null, status = "ranked"): Promise<string> {
  const id = randomUUID()
  await sql`insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, company, structured, status, skip_reason, role_family, discovered_at, evaluated_at)
    values (${id}, ${`https://x.test/${id}`}, ${id}, ${`https://x.test/${id}`}, 'Greenhouse', 'automatic', 'employer_board', ${title}, 'Co', '{}', ${status}, ${status === "skipped" ? "weak_core_match" : null}, ${family}, now(), now())`.execute(db)
  return id
}

describe("migration 0011 on existing postings", () => {
  it("backfills title_folded, relabels only other rows, changes nothing else, and indexes the keyset orders", async () => {
    const ids = {
      backend: await posting("Senior Backend Engineer", "other"),
      mobile: await posting("Flutter Developer", "other"),
      devops: await posting("Site Reliability Engineer", "other"),
      software: await posting("Software Engineer", "other"),
      frontend: await posting("Backend Engineer (React, Node)", "senior_frontend"),
      unclassified: await posting("DevOps Engineer", null, "checking"),
      accented: await posting("Développeur   BACKEND", null, "skipped"),
      untitled: await posting(null, "other"),
    }
    const before = await sql<Record<string, unknown>>`select * from job_posting order by id`.execute(db)
    // Up to 0011 only: later migrations (0012-job-criteria adds job_posting.technologies) are tested on their own.
    const { error } = await new Migrator({ db, provider: { getMigrations: async () => through0011 } }).migrateToLatest()
    expect(error).toBeUndefined()
    const after = await sql<Record<string, unknown>>`select * from job_posting order by id`.execute(db)
    const byId = new Map(after.rows.map((row) => [row.id as string, row]))
    expect(byId.get(ids.backend)?.role_family).toBe("backend")
    expect(byId.get(ids.mobile)?.role_family).toBe("mobile")
    expect(byId.get(ids.devops)?.role_family).toBe("devops_platform")
    expect(byId.get(ids.software)?.role_family).toBe("other")
    expect(byId.get(ids.frontend)?.role_family).toBe("senior_frontend")
    expect(byId.get(ids.unclassified)?.role_family).toBeNull()
    expect(byId.get(ids.untitled)?.role_family).toBe("other")
    expect(byId.get(ids.accented)?.title_folded).toBe("developpeur backend")
    expect(byId.get(ids.untitled)?.title_folded).toBeNull()
    const strip = (rows: Record<string, unknown>[]) => rows.map((row) => ({ ...row, role_family: undefined, title_folded: undefined }))
    expect(strip(after.rows)).toEqual(strip(before.rows))
    const indexes = await sql<{ indexname: string }>`select indexname from pg_indexes where tablename = 'job_posting'`.execute(db)
    expect(indexes.rows.map((row) => row.indexname)).toEqual(expect.arrayContaining(["job_posting_newest_idx", "job_posting_status_newest_idx"]))
  })
})
