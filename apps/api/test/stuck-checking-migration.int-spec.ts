import { randomUUID } from "node:crypto"

import { type Kysely, sql } from "kysely"
import { type Migration, Migrator } from "kysely/migration"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import { migrationsFor } from "../src/db/migrations/index.js"
import { SCHEMA_MARKERS } from "../src/db/migrations/schema-markers.js"
import { STUCK_AFTER_MS, stuckSql } from "../src/discovery/stuck.js"

/**
 * EPIC-0006 r4, migration 0032-stuck-checking on test databases only
 * (architecture-stuck-checking.md; AC-7.12; stuck-checking-recovery.feature
 * :171, :179, :187). Each test creates its own database at 0031, seeds rows,
 * applies 0032 and reads the result with the real stuck predicate.
 */
const MIGRATION = "0032-stuck-checking"
const ALL = (): Record<string, Migration> => migrationsFor({ operatorGoogleSub: "google-sub-ada-0032" })
const upTo = (lastIncluded: string) => Object.fromEntries(Object.entries(ALL()).filter(([name]) => name <= lastIncluded))

type Db = Kysely<unknown>
const opened: { name: string; db: Db }[] = []
let cluster: Db

beforeAll(() => {
  cluster = createDatabase(inject("postgresAdminUrl")) as unknown as Db
})

afterAll(async () => {
  for (const { name, db } of opened) {
    await db.destroy()
    await sql`drop database if exists ${sql.id(name)} with (force)`.execute(cluster)
  }
  await cluster.destroy()
})

async function databaseAt(lastIncluded: string): Promise<Db> {
  const name = `ja_e6_0032_${randomUUID().replaceAll("-", "").slice(0, 16)}`
  await sql`create database ${sql.id(name)}`.execute(cluster)
  const url = new URL(inject("postgresAdminUrl"))
  url.pathname = `/${name}`
  const db = createDatabase(url.toString()) as unknown as Db
  opened.push({ name, db })
  await migrate(db, upTo(lastIncluded))
  return db
}

async function migrate(db: Db, migrations: Record<string, Migration>): Promise<void> {
  const { error } = await new Migrator({ db, provider: { getMigrations: async () => migrations } }).migrateToLatest()
  if (error) throw error
}

async function addCandidate(db: Db, email: string): Promise<string> {
  const id = (await sql<{ id: string }>`insert into candidate (email, google_sub, role, onboarded_at) values (${email}, ${`sub-${email}`}, 'candidate', now()) returning id`.execute(db)).rows[0]!.id
  await sql`insert into job_criteria (candidate_id, min_core_match_percent) values (${id}, 70)`.execute(db)
  return id
}

/** One shared posting at 0031 shape held by `candidateId` with `status`, "since 2026-10-20". */
async function seedRow(db: Db, candidateId: string, status: string): Promise<string> {
  const id = randomUUID()
  const url = `https://boards.greenhouse.io/acme/jobs/${id}`
  await sql`insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, title_folded, company, structured, role_family, discovered_at, posted_at, posted_date_kind, seniority_marker)
    values (${id}, ${url}, ${id.slice(0, 12)}, ${url}, 'greenhouse', 'automatic', 'employer_board', 'Senior Frontend Engineer', 'senior frontend engineer', 'Acme', '{}', 'senior_frontend', '2026-10-20T08:00:00Z', '2026-10-20T08:00:00Z', 'published', 'mid_plus')`.execute(db)
  await sql`insert into candidate_posting (candidate_id, job_posting_id, origin, status, skip_reason, skip_detail, evaluation_failure, discovered_at, evaluated_at)
    values (${candidateId}, ${id}, 'employer_board', ${status}, null, null, null, '2026-10-20T08:00:00Z', null)`.execute(db)
  return id
}

const operatorId = async (db: Db) => (await sql<{ id: string }>`select id from candidate where role = 'operator'`.execute(db)).rows[0]!.id

async function stuckAt(db: Db, postingId: string, now: Date): Promise<boolean> {
  const { rows } = await sql<{ stuck: boolean }>`select ${stuckSql("cp", now)} as stuck from candidate_posting cp where cp.job_posting_id = ${postingId}::uuid`.execute(db)
  return rows[0]!.stuck
}

describe("migration 0032-stuck-checking (AC-7.12)", () => {
  it("is registered after 0031 with its schema marker", () => {
    const names = Object.keys(ALL())
    expect(names.at(-10)).toBe(MIGRATION)
    expect(names.at(-11)).toBe("0031-pasted-description")
    expect(SCHEMA_MARKERS.at(-10)).toBe(MIGRATION)
  })

  it("stuck:171 / :187 existing checking rows get checking_since = the migration's now(), keep their status, and become stuck 15 minutes after ship", async () => {
    const db = await databaseAt("0031-pasted-description")
    const ada = await operatorId(db)
    const kofi = await addCandidate(db, "kofi.0032@example.test")
    const rows = [
      ...(await Promise.all([1, 2, 3].map(() => seedRow(db, ada, "checking")))),
      ...(await Promise.all([1, 2].map(() => seedRow(db, kofi, "checking")))),
    ]
    const ranked = await seedRow(db, ada, "ranked")
    // The migration path installs no pg-boss schema here, so a job could only appear if 0032 created one.
    const jobTable = async () => (await sql<{ present: boolean }>`select to_regclass('pgboss.job') is not null as present`.execute(db)).rows[0]!.present
    expect(await jobTable()).toBe(false)
    const before = (await sql<{ t: Date }>`select now() as t`.execute(db)).rows[0]!.t
    await migrate(db, upTo(MIGRATION))
    const after = (await sql<{ t: Date }>`select now() as t`.execute(db)).rows[0]!.t

    const stored = (await sql<{ job_posting_id: string; status: string; checking_since: Date }>`select job_posting_id, status, checking_since from candidate_posting order by job_posting_id`.execute(db)).rows
    expect(stored).toHaveLength(6)
    const shipped = stored[0]!.checking_since
    // One value for every row: the migration transaction's start.
    expect(new Set(stored.map((row) => row.checking_since.getTime()))).toEqual(new Set([shipped.getTime()]))
    expect(shipped.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(shipped.getTime()).toBeLessThanOrEqual(after.getTime())
    for (const id of rows) expect(stored.find((row) => row.job_posting_id === id)?.status).toBe("checking")
    expect(stored.find((row) => row.job_posting_id === ranked)?.status).toBe("ranked")
    // No job queued and no model call: the migration writes no job and no ai_call or spend row.
    expect(await jobTable()).toBe(false)
    expect((await sql<{ n: number }>`select count(*)::int as n from ai_call`.execute(db)).rows[0]!.n).toBe(0)
    expect((await sql<{ n: number }>`select count(*)::int as n from spend_entry where category = 'ai'`.execute(db)).rows[0]!.n).toBe(0)

    const atShip = (ms: number) => new Date(shipped.getTime() + ms)
    for (const id of rows) {
      expect(await stuckAt(db, id, atShip(STUCK_AFTER_MS))).toBe(false)
      expect(await stuckAt(db, id, atShip(STUCK_AFTER_MS + 1_000))).toBe(true)
    }
    expect(await stuckAt(db, ranked, atShip(STUCK_AFTER_MS + 1_000))).toBe(false)
    expect((await sql<{ name: string }>`select name from migration_marker where name = ${MIGRATION}`.execute(db)).rows).toEqual([{ name: MIGRATION }])
  })

  it("stuck:179 a row checking at ship whose evaluation holds the lock does not become stuck", async () => {
    const db = await databaseAt("0031-pasted-description")
    const ada = await operatorId(db)
    const id = await seedRow(db, ada, "checking")
    await migrate(db, upTo(MIGRATION))
    const shipped = (await sql<{ t: Date }>`select checking_since as t from candidate_posting where job_posting_id = ${id}::uuid`.execute(db)).rows[0]!.t
    const key = (await sql<{ k: string }>`select (('x' || left(encode(sha256(convert_to('eve/evaluate/' || ${ada}::text || '/' || ${id}::text, 'UTF8')), 'hex'), 12))::bit(48)::bigint)::text as k`.execute(db)).rows[0]!.k
    const url = new URL(inject("postgresAdminUrl"))
    url.pathname = `/${opened.at(-1)!.name}`
    const locker = createDatabase(url.toString())
    try {
      await locker.connection().execute(async (connection) => {
        await sql`select pg_advisory_lock(${key}::bigint)`.execute(connection)
        expect(await stuckAt(db, id, new Date(shipped.getTime() + 20 * 60_000))).toBe(false)
        await sql`select pg_advisory_unlock(${key}::bigint)`.execute(connection)
      })
    } finally {
      await locker.destroy()
    }
    expect(await stuckAt(db, id, new Date(shipped.getTime() + 20 * 60_000))).toBe(true)
  })

  it("down drops the column and the marker; up again restores both", async () => {
    const db = await databaseAt(MIGRATION)
    const migrator = new Migrator({ db, provider: { getMigrations: async () => upTo(MIGRATION) } })
    const down = await migrator.migrateDown()
    expect(down.error).toBeUndefined()
    const column = async () => (await sql<{ n: number }>`select count(*)::int as n from information_schema.columns where table_name = 'candidate_posting' and column_name = 'checking_since'`.execute(db)).rows[0]!.n
    expect(await column()).toBe(0)
    await migrate(db, upTo(MIGRATION))
    expect(await column()).toBe(1)
  })
})
