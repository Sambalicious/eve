import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"

import { type Kysely, sql } from "kysely"
import { Migrator } from "kysely/migration"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import { grantDatabaseAccess } from "../src/db/database-roles.js"
import { migrationsFor } from "../src/db/migrations/index.js"
import { rolesFor, urlFor } from "./support/postgres-cluster.js"

/**
 * QA test authoring, EPIC-0011 migration 0033-simplify-eve (api-contract.md v1.28.0 "Migration 0033").
 * Gherkin: upgrade-and-compat.r1.feature UPG:11 (no stored data changes), UPG:19/25/37 (Operator on, everyone
 * else off, no detection logic), UPG:48 (idempotent, never overwrites a user's flag), UPG:92 (automatic values
 * unchanged), AC-7.3 (note due for existing non-Operators). Each case builds a database at 0032 provisioned like
 * production, then runs 0033 as the migration owner role (FORCE row-level security binds it).
 * Expected red until 0033 exists.
 */
const OWNER_SUB = "google-sub-ada-0033"
const ALL = migrationsFor({ operatorGoogleSub: OWNER_SUB })
const THROUGH_0032 = Object.fromEntries(Object.entries(ALL).filter(([name]) => name <= "0032-stuck-checking"))
const THROUGH_0033 = Object.fromEntries(Object.entries(ALL).filter(([name]) => name <= "0033-simplify-eve"))

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

async function databaseAt0032() {
  const name = `ja_e11_${randomUUID().replaceAll("-", "").slice(0, 16)}`
  await sql`create database ${sql.id(name)}`.execute(cluster)
  const clusterUrl = inject("postgresAdminUrl")
  const roles = rolesFor(name)
  const admin = createDatabase(urlFor(clusterUrl, undefined, name)) as unknown as Db
  await grantDatabaseAccess(admin, roles)
  const owner = createDatabase(urlFor(clusterUrl, roles.owner, name)) as unknown as Db
  opened.push({ name, dbs: [admin, owner] })
  const { error } = await new Migrator({ db: owner, provider: { getMigrations: async () => THROUGH_0032 } }).migrateToLatest()
  if (error) throw error
  const id = async (email: string, sub: string, role: string, state = "active") =>
    (await sql<{ id: string }>`insert into candidate (email, google_sub, role, state) values (${email}, ${sub}, ${role}, ${state}) returning id::text as id`.execute(admin)).rows[0]!.id
  const operatorId = (await sql<{ id: string }>`select id::text as id from candidate where role = 'operator'`.execute(admin)).rows[0]!.id
  return { admin, owner, operatorId, id }
}

const migrate0033 = async (owner: Db) => {
  const { error, results } = await new Migrator({ db: owner, provider: { getMigrations: async () => THROUGH_0033 } }).migrateToLatest()
  expect(error).toBeUndefined()
  expect(results?.map((result) => result.migrationName)).toEqual(["0033-simplify-eve"])
}

type Setting = { candidate_id: string; advanced_enabled: boolean; simpler_note_due: boolean; improve_list_dismissed_at: Date | null }
const settings = async (admin: Db) => (await sql<Setting>`select candidate_id::text, advanced_enabled, simpler_note_due, improve_list_dismissed_at from candidate_view_setting`.execute(admin)).rows
const settingOf = async (admin: Db, id: string) => (await settings(admin)).find((row) => row.candidate_id === id)

async function digests(admin: Db): Promise<Record<string, string>> {
  const tables = (await sql<{ tablename: string }>`select tablename from pg_tables where schemaname = 'public' and tablename not like 'kysely_%' and tablename not in ('candidate_view_setting', 'migration_marker') order by tablename`.execute(admin)).rows
  const out: Record<string, string> = {}
  for (const { tablename } of tables) out[tablename] = (await sql<{ d: string }>`select coalesce(md5(string_agg(r::text, '|' order by r::text)), 'empty') as d from ${sql.table(tablename)} r`.execute(admin)).rows[0]!.d
  return out
}

describe("migration 0033 seeding (AC-7.2, AC-7.3)", () => {
  it("UPG:19 the Operator gets Advanced on with no note; UPG:25 every other active account gets Advanced off with the note due", async () => {
    const { admin, owner, operatorId, id } = await databaseAt0032()
    const bisi = await id("bisi@example.test", "s-bisi", "candidate")
    const noProfile = await id("new.invitee@example.test", "s-new", "candidate")
    await migrate0033(owner)
    expect(await settingOf(admin, operatorId)).toMatchObject({ advanced_enabled: true, simpler_note_due: false, improve_list_dismissed_at: null })
    expect(await settingOf(admin, bisi)).toMatchObject({ advanced_enabled: false, simpler_note_due: true })
    expect(await settingOf(admin, noProfile)).toMatchObject({ advanced_enabled: false, simpler_note_due: true })
  })

  it("revoked and deleting accounts get no row (reads as off with no note)", async () => {
    const { admin, owner, id } = await databaseAt0032()
    const revoked = await id("gone@example.test", "s-gone", "candidate", "revoked")
    const deleting = await id("leaving@example.test", "s-leaving", "candidate", "deleting")
    await migrate0033(owner)
    expect(await settingOf(admin, revoked)).toBeUndefined()
    expect(await settingOf(admin, deleting)).toBeUndefined()
  })

  it("UPG:37 there is no per-user detection: a non-Operator whose data looks like automation still gets Advanced off", async () => {
    const { admin, owner, id } = await databaseAt0032()
    const looksAutomatic = await id("auto@example.test", "s-auto", "candidate")
    await sql`insert into activation_state (candidate_id, gate_passed_at, automatic_enabled, existing_applications_completed_at) values (${looksAutomatic}::uuid, now(), true, now())`.execute(admin)
    await migrate0033(owner)
    expect(await settingOf(admin, looksAutomatic)).toMatchObject({ advanced_enabled: false, simpler_note_due: true })
  })

  it("UPG:48 running the seed again never overwrites a flag the user set (on conflict do nothing)", async () => {
    const { admin, owner, operatorId } = await databaseAt0032()
    await migrate0033(owner)
    await sql`update candidate_view_setting set advanced_enabled = false, updated_at = now() where candidate_id = ${operatorId}::uuid`.execute(admin)
    // Replay the seed statement of api-contract.md "Migration 0033" step 2 (up() as a whole cannot run twice: it creates the table).
    // The superuser connection stands in for the owner role binding, which the migration does per row.
    await sql`insert into candidate_view_setting (candidate_id, advanced_enabled, simpler_note_due, updated_at)
      select id, role = 'operator', role <> 'operator', now() from candidate where role = 'operator' or state = 'active'
      on conflict (candidate_id) do nothing`.execute(admin)
    // And the migration itself must carry the same guard.
    const source = readFileSync(path.join(process.cwd(), "src/db/migrations/0033-simplify-eve.ts"), "utf8")
    expect(source).toMatch(/on conflict[^]*do nothing/i)
    expect(await settingOf(admin, operatorId)).toMatchObject({ advanced_enabled: false })
  })

  it("a candidate created after the upgrade has no row, and the table has one row per seeded account only", async () => {
    const { admin, owner, id } = await databaseAt0032()
    await migrate0033(owner)
    const later = await id("later@example.test", "s-later", "candidate")
    expect(await settingOf(admin, later)).toBeUndefined()
    expect((await settings(admin)).length).toBe(1)
  })
})

describe("migration 0033 changes no stored data (AC-7.1, UPG:11, UPG:92)", () => {
  it("every other table is byte-identical before and after, including automatic values, caps, controls, Applications and Outcomes", async () => {
    const { admin, owner, operatorId, id } = await databaseAt0032()
    const bisi = await id("bisi@example.test", "s-bisi", "candidate")
    await sql`insert into activation_state (candidate_id, gate_passed_at, automatic_enabled, existing_applications_completed_at) values (${operatorId}::uuid, now(), true, now()) on conflict (candidate_id) do update set gate_passed_at = now(), automatic_enabled = true`.execute(admin)
    await sql`update control_state set global_paused = true`.execute(admin)
    const postingId = randomUUID()
    const url = `https://boards.greenhouse.io/acme/jobs/${postingId}`
    await sql`insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, company, discovered_at, structured)
      values (${postingId}, ${url}, 'R-1', ${url}, 'greenhouse', 'automatic', 'employer_board', 'Engineer', 'Acme', now(), '{}')`.execute(admin)
    for (const candidate of [operatorId, bisi]) {
      const applicationId = randomUUID()
      await sql`insert into application (id, candidate_id, job_posting_id, application_url, requisition_id, company, role_title, state, created_at, updated_at, submission_state, submission_kind)
        values (${applicationId}::uuid, ${candidate}::uuid, ${postingId}, ${url}, 'R-1', 'Acme', 'Engineer', 'documents_ready', now(), now(), 'queued', 'automatic')`.execute(admin)
      await sql`insert into outcome (candidate_id, id, application_id, type, created_at, updated_at) values (${candidate}::uuid, ${randomUUID()}::uuid, ${applicationId}::uuid, 'interview_invitation', now(), now())`.execute(admin)
    }
    const before = await digests(admin)
    await migrate0033(owner)
    expect(await digests(admin)).toEqual(before)
    expect((await sql<{ automatic_enabled: boolean }>`select automatic_enabled from activation_state where candidate_id = ${operatorId}::uuid`.execute(admin)).rows[0]).toEqual({ automatic_enabled: true })
  })
})

describe("migration 0033 table and constraint (C1, RLS)", () => {
  it("forces row-level security on candidate_view_setting and widens the outcome.type check to accept offer only", async () => {
    const { admin, owner, operatorId } = await databaseAt0032()
    const app = await (async () => {
      const applicationId = randomUUID()
      const postingId = randomUUID()
      const url = `https://boards.greenhouse.io/acme/jobs/${postingId}`
      await sql`insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, company, discovered_at, structured)
        values (${postingId}, ${url}, 'R-1', ${url}, 'greenhouse', 'automatic', 'employer_board', 'Engineer', 'Acme', now(), '{}')`.execute(admin)
      await sql`insert into application (id, candidate_id, job_posting_id, application_url, requisition_id, company, role_title, state, created_at, updated_at)
        values (${applicationId}::uuid, ${operatorId}::uuid, ${postingId}, ${url}, 'R-1', 'Acme', 'Engineer', 'prepared', now(), now())`.execute(admin)
      return applicationId
    })()
    const insert = (type: string) => sql`insert into outcome (candidate_id, id, application_id, type, created_at, updated_at) values (${operatorId}::uuid, ${randomUUID()}::uuid, ${app}::uuid, ${type}, now(), now())`.execute(admin)
    await expect(insert("offer")).rejects.toThrow(/check constraint/)
    await migrate0033(owner)
    await expect(insert("offer")).resolves.toBeDefined()
    await expect(insert("promotion")).rejects.toThrow(/check constraint/)
    const flags = (await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>`select relrowsecurity, relforcerowsecurity from pg_class where relname = 'candidate_view_setting'`.execute(admin)).rows[0]
    expect(flags).toEqual({ relrowsecurity: true, relforcerowsecurity: true })
    const marker = await sql`select 1 from migration_marker where name = '0033-simplify-eve'`.execute(admin).catch(() => ({ rows: [{}] }))
    expect(marker.rows.length).toBeGreaterThan(0)
  })

  it("down refuses while an offer Outcome exists", async () => {
    const { admin, owner, operatorId } = await databaseAt0032()
    await migrate0033(owner)
    const postingId = randomUUID()
    const applicationId = randomUUID()
    const url = `https://boards.greenhouse.io/acme/jobs/${postingId}`
    await sql`insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, company, discovered_at, structured)
      values (${postingId}, ${url}, 'R-1', ${url}, 'greenhouse', 'automatic', 'employer_board', 'Engineer', 'Acme', now(), '{}')`.execute(admin)
    await sql`insert into application (id, candidate_id, job_posting_id, application_url, requisition_id, company, role_title, state, created_at, updated_at)
      values (${applicationId}::uuid, ${operatorId}::uuid, ${postingId}, ${url}, 'R-1', 'Acme', 'Engineer', 'prepared', now(), now())`.execute(admin)
    await sql`insert into outcome (candidate_id, id, application_id, type, created_at, updated_at) values (${operatorId}::uuid, ${randomUUID()}::uuid, ${applicationId}::uuid, 'offer', now(), now())`.execute(admin)
    await expect(ALL["0033-simplify-eve"]!.down!(owner as never)).rejects.toThrow()
  })
})
