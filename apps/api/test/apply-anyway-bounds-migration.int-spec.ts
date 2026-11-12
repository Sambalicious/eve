import { randomUUID } from "node:crypto"

import { type Kysely, sql } from "kysely"
import { Migrator } from "kysely/migration"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import { grantDatabaseAccess } from "../src/db/database-roles.js"
import { migrationsFor } from "../src/db/migrations/index.js"
import { rolesFor, urlFor } from "./support/postgres-cluster.js"

/**
 * Migration 0026-apply-anyway-bounds (api-contract.md v1.24.0 "Migration", AA-2.7,
 * AA-7.6, threat model TM-F-01, TM-F-03). Each case builds its own database at
 * 0025, provisioned like production, and runs 0026 as the migration owner role,
 * which FORCE row-level security binds, with Applications of two Candidates.
 * Seeds and assertions use the bootstrap superuser.
 */
const OWNER_SUB = "google-sub-ada-0026"
const ALL = migrationsFor({ operatorGoogleSub: OWNER_SUB })
const THROUGH_0025 = Object.fromEntries(Object.entries(ALL).filter(([name]) => name <= "0025-apply-anyway"))
// EPIC-0002 B1's 0027-preferences-version merged after this migration and has its own test; stop at 0026.
const THROUGH_0026 = Object.fromEntries(Object.entries(ALL).filter(([name]) => name <= "0026-apply-anyway-bounds"))

type Db = Kysely<unknown>
let cluster: Db
const opened: { name: string; dbs: Db[] }[] = []

beforeAll(() => {
  cluster = createDatabase(inject("postgresAdminUrl")) as unknown as Db
})

afterAll(async () => {
  for (const { name, dbs } of opened) {
    for (const db of dbs) await db.destroy()
    await sql`drop database if exists ${sql.id(name)} with (force)`.execute(cluster)
  }
  await cluster.destroy()
})

async function databaseAt0025() {
  const name = `ja_aa26_${randomUUID().replaceAll("-", "").slice(0, 16)}`
  await sql`create database ${sql.id(name)}`.execute(cluster)
  const clusterUrl = inject("postgresAdminUrl")
  const roles = rolesFor(name)
  const admin = createDatabase(urlFor(clusterUrl, undefined, name)) as unknown as Db
  await grantDatabaseAccess(admin, roles)
  const owner = createDatabase(urlFor(clusterUrl, roles.owner, name)) as unknown as Db
  opened.push({ name, dbs: [admin, owner] })
  const { error } = await new Migrator({ db: owner, provider: { getMigrations: async () => THROUGH_0025 } }).migrateToLatest()
  if (error) throw error
  const operatorId = (await sql<{ id: string }>`select id::text as id from candidate where role = 'operator'`.execute(admin)).rows[0]!.id
  const inviteeId = (await sql<{ id: string }>`insert into candidate (email, google_sub, role, state) values ('bola@example.com', 'sub-bola', 'candidate', 'active') returning id::text as id`.execute(admin)).rows[0]!.id
  return { admin, owner, operatorId, inviteeId }
}

/** A posting and an Application for `candidateId`, inserted by the superuser. */
async function application(admin: Db, candidateId: string, overrideAt: Date | null): Promise<string> {
  const postingId = randomUUID()
  const url = `https://boards.greenhouse.io/acme/jobs/${postingId}`
  await sql`insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, company, discovered_at, structured)
    values (${postingId}, ${url}, 'R-1', ${url}, 'greenhouse', 'automatic', 'employer_board', 'Engineer', 'Acme', now(), '{}')`.execute(admin)
  const id = randomUUID()
  await sql`insert into application (id, candidate_id, job_posting_id, application_url, requisition_id, company, role_title, state, created_at, updated_at, candidate_override_at)
    values (${id}, ${candidateId}::uuid, ${postingId}, ${url}, 'R-1', 'Acme', 'Engineer', 'prepared', now(), now(), ${overrideAt})`.execute(admin)
  return id
}

type Row = { candidate_override_at: Date | null; override_created_at: Date | null; override_status: string | null; override_violated_rules: string[] | null }
const rowOf = async (admin: Db, id: string) =>
  (await sql<Row>`select candidate_override_at, override_created_at, override_status, override_violated_rules from application where id = ${id}`.execute(admin)).rows[0]!

const migrate0026 = async (owner: Db) => {
  const { error, results } = await new Migrator({ db: owner, provider: { getMigrations: async () => THROUGH_0026 } }).migrateToLatest()
  expect(error).toBeUndefined()
  expect(results?.map((result) => result.migrationName)).toEqual(["0026-apply-anyway-bounds"])
}

describe("migration 0026 as the owner role (TM-F-01, AA-2.7)", () => {
  it(":517 moves every Candidate's candidate_override_at to override_created_at with no decision; row-level security is forced again after", async () => {
    const { admin, owner, operatorId, inviteeId } = await databaseAt0025()
    const at = new Date("2026-10-28T11:00:00.000Z")
    const ada = await application(admin, operatorId, at)
    const bola = await application(admin, inviteeId, at)
    const plain = await application(admin, operatorId, null)
    await migrate0026(owner)
    for (const id of [ada, bola]) expect(await rowOf(admin, id)).toEqual({ candidate_override_at: null, override_created_at: at, override_status: null, override_violated_rules: null })
    expect(await rowOf(admin, plain)).toEqual({ candidate_override_at: null, override_created_at: null, override_status: null, override_violated_rules: null })
    const forced = await sql<{ relforcerowsecurity: boolean }>`select relforcerowsecurity from pg_class where relname = 'application'`.execute(admin)
    expect(forced.rows[0]!.relforcerowsecurity).toBe(true)
  })

  it("TM-F-03: the database refuses a stored decision that is not overridable; down removes the columns and the marker", async () => {
    const { admin, owner, operatorId } = await databaseAt0025()
    const id = await application(admin, operatorId, null)
    await migrate0026(owner)
    const set = (status: string, reason: string, rules: string) =>
      sql`update application set override_created_at = now(), override_status = ${status}, override_skip_reason = ${reason}, override_violated_rules = ${rules}::text[] where id = ${id}`.execute(admin)
    await expect(set("excluded", "violated_rule", "{location}")).rejects.toThrow(/application_override_decision_overridable/)
    await expect(set("excluded", "violated_rule", "{industry,location}")).rejects.toThrow(/application_override_decision_overridable/)
    await expect(set("skipped", "technology_mismatch", "{}")).rejects.toThrow(/application_override_decision_overridable/)
    await set("excluded", "violated_rule", "{industry}")
    await set("skipped", "uncovered_mandatory_prerequisite", "{}")
    expect((await new Migrator({ db: owner, provider: { getMigrations: async () => THROUGH_0026 } }).migrateDown()).error).toBeUndefined()
    const columns = await sql<{ n: number }>`select count(*)::int as n from information_schema.columns where table_name = 'application' and column_name like 'override_%'`.execute(admin)
    expect(columns.rows[0]!.n).toBe(0)
    const marker = await sql<{ n: number }>`select count(*)::int as n from migration_marker where name = '0026-apply-anyway-bounds'`.execute(admin)
    expect(marker.rows[0]!.n).toBe(0)
    // down never re-arms the v1.23.x marker.
    expect((await sql<{ c: Date | null }>`select candidate_override_at as c from application where id = ${id}`.execute(admin)).rows[0]!.c).toBeNull()
  })
})
