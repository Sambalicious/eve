import { randomUUID } from "node:crypto"

import { type Kysely, sql } from "kysely"
import { Migrator } from "kysely/migration"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import { grantDatabaseAccess } from "../src/db/database-roles.js"
import { migrationsFor } from "../src/db/migrations/index.js"
import { SIMPLIFY_EVE_MARKER } from "../src/db/migrations/0033-simplify-eve.js"
import { SCHEMA_MARKERS } from "../src/db/migrations/schema-markers.js"
import { rolesFor, urlFor } from "./support/postgres-cluster.js"

/**
 * EPIC-0011 migration 0033-simplify-eve (api-contract.md "Migration 0033"; UPG:11, :18, :24, :36, :42, :47, :92).
 * A database built to 0032 as production is (owner role, FORCE RLS binds it), seeded with the Operator,
 * an active invitee, a revoked one and a deleting one, then 0033 up, a rerun, down and up again.
 * Seeds and reads use the bootstrap superuser; the RLS checks use the runtime role.
 */
const ALL = migrationsFor({ operatorGoogleSub: "google-sub-ada-0033" })
type Db = Kysely<unknown>
let cluster: Db
let admin: Db
let owner: Db
let runtime: Db
let name: string
const ids: Record<"operator" | "active" | "revoked" | "deleting" | "automatic", string> = { operator: "", active: "", revoked: "", deleting: "", automatic: "" }

const migrator = (upTo?: string) => new Migrator({ db: owner, provider: { getMigrations: async () => (upTo ? Object.fromEntries(Object.entries(ALL).filter(([key]) => key <= upTo)) : ALL) } })

async function addCandidate(email: string, state: string): Promise<string> {
  return (await sql<{ id: string }>`insert into candidate (email, google_sub, role, state) values (${email}, ${`sub-${email}`}, 'candidate', ${state}) returning id::text as id`.execute(admin)).rows[0]!.id
}

/** Row checksums of every table except those created after 0032 (0033's, 0038's `lead`, 0040's `outreach_message`), for UPG:11. */
async function checksums(): Promise<Record<string, string>> {
  const tables = (await sql<{ t: string }>`select tablename as t from pg_tables where schemaname = 'public' and tablename not in ('candidate_view_setting', 'lead', 'outreach_message', 'kysely_migration', 'migration_marker') order by 1`.execute(admin)).rows
  const out: Record<string, string> = {}
  for (const { t } of tables) out[t] = (await sql<{ h: string }>`select coalesce(md5(string_agg(x::text, '|' order by x::text)), '') as h from ${sql.table(t)} x`.execute(admin)).rows[0]!.h
  return out
}

beforeAll(async () => {
  cluster = createDatabase(inject("postgresAdminUrl")) as unknown as Db
  name = `ja_e11_${randomUUID().replaceAll("-", "").slice(0, 16)}`
  await sql`create database ${sql.id(name)}`.execute(cluster)
  const clusterUrl = inject("postgresAdminUrl")
  const roles = rolesFor(name)
  admin = createDatabase(urlFor(clusterUrl, undefined, name)) as unknown as Db
  await grantDatabaseAccess(admin, roles)
  owner = createDatabase(urlFor(clusterUrl, roles.owner, name)) as unknown as Db
  const { error } = await migrator("0032-stuck-checking").migrateToLatest()
  if (error) throw error
  ids.operator = (await sql<{ id: string }>`select id::text as id from candidate where role = 'operator'`.execute(admin)).rows[0]!.id
  ids.active = await addCandidate("active@example.test", "active")
  ids.revoked = await addCandidate("revoked@example.test", "revoked")
  ids.deleting = await addCandidate("deleting@example.test", "deleting")
  ids.automatic = await addCandidate("automatic@example.test", "active")
  runtime = createDatabase(urlFor(clusterUrl, roles.runtime, name)) as unknown as Db
})

afterAll(async () => {
  for (const db of [runtime, owner, admin]) await db?.destroy()
  await sql`drop database if exists ${sql.id(name)} with (force)`.execute(cluster)
  await cluster.destroy()
})

const settings = async () => (await sql<{ id: string; advanced_enabled: boolean; simpler_note_due: boolean; improve_list_dismissed_at: Date | null }>`select candidate_id::text as id, advanced_enabled, simpler_note_due, improve_list_dismissed_at from candidate_view_setting order by 1`.execute(admin)).rows

describe("migration 0033-simplify-eve", () => {
  let before: Record<string, string>

  it("is registered ninth to last (0034 to 0041 follow it) with its schema marker", () => {
    expect(Object.keys(ALL).at(-9)).toBe(SIMPLIFY_EVE_MARKER)
    expect(SCHEMA_MARKERS.at(-9)).toBe(SIMPLIFY_EVE_MARKER)
  })

  it("UPG:18, :24, :36 seeds the Operator on with no note and every other active Candidate off with the note due; UPG:11 changes no other table", async () => {
    // A non-Operator with automatic on (impossible via the API today): the invariant check only logs, it changes nothing.
    await sql`insert into activation_state (candidate_id, existing_applications_completed_at, gate_passed_at, automatic_enabled) values (${ids.automatic}::uuid, now(), now(), true)`.execute(admin)
    before = await checksums()
    const { error } = await migrator().migrateToLatest()
    expect(error).toBeUndefined()
    const rows = await settings()
    const byId = new Map(rows.map((row) => [row.id, row]))
    expect(byId.get(ids.operator)).toMatchObject({ advanced_enabled: true, simpler_note_due: false, improve_list_dismissed_at: null })
    for (const id of [ids.active, ids.automatic]) expect(byId.get(id)).toMatchObject({ advanced_enabled: false, simpler_note_due: true, improve_list_dismissed_at: null })
    // UPG:36: revoked and deleting Candidates get no row (they read as the defaults).
    expect(byId.has(ids.revoked)).toBe(false)
    expect(byId.has(ids.deleting)).toBe(false)
    expect(await checksums()).toEqual(before)
    expect((await sql<{ automatic_enabled: boolean }>`select automatic_enabled from activation_state where candidate_id = ${ids.automatic}::uuid`.execute(admin)).rows[0]).toEqual({ automatic_enabled: true })
    expect((await sql`select 1 from migration_marker where name = ${SIMPLIFY_EVE_MARKER}`.execute(admin)).rows).toHaveLength(1)
  })

  it("forces RLS with one policy that names bound_candidate() and the setting; the runtime role sees only the bound Candidate's row", async () => {
    const flags = (await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>`select relrowsecurity, relforcerowsecurity from pg_class where relname = 'candidate_view_setting'`.execute(admin)).rows[0]
    expect(flags).toEqual({ relrowsecurity: true, relforcerowsecurity: true })
    const policies = (await sql<{ policyname: string; qual: string; with_check: string }>`select policyname, qual, with_check from pg_policies where tablename = 'candidate_view_setting'`.execute(admin)).rows
    expect(policies.map((p) => p.policyname)).toEqual(["candidate_view_setting_candidate"])
    for (const text of [policies[0]!.qual, policies[0]!.with_check]) expect(text).toMatch(/bound_candidate/)
    const visible = async (id: string) =>
      runtime.transaction().execute(async (tx) => {
        await sql`select set_config('eve.candidate_id', ${id}, true), public.bind_candidate(${id}::uuid)`.execute(tx)
        return (await sql<{ id: string }>`select candidate_id::text as id from candidate_view_setting`.execute(tx)).rows.map((row) => row.id)
      })
    expect(await visible(ids.active)).toEqual([ids.active])
    expect(await visible(ids.operator)).toEqual([ids.operator])
    // Unbound: nothing. Re-pointing the setting inside a bound transaction: nothing.
    expect((await runtime.transaction().execute((tx) => sql`select 1 from candidate_view_setting`.execute(tx))).rows).toEqual([])
    const repointed = await runtime.transaction().execute(async (tx) => {
      await sql`select set_config('eve.candidate_id', ${ids.active}, true), public.bind_candidate(${ids.active}::uuid)`.execute(tx)
      await sql`select set_config('eve.candidate_id', ${ids.operator}, true)`.execute(tx)
      return (await sql`select 1 from candidate_view_setting`.execute(tx)).rows
    })
    expect(repointed).toEqual([])
  })

  it("the runtime role can insert and update its own row (grants as every Candidate table)", async () => {
    await runtime.transaction().execute(async (tx) => {
      await sql`select set_config('eve.candidate_id', ${ids.revoked}, true), public.bind_candidate(${ids.revoked}::uuid)`.execute(tx)
      await sql`insert into candidate_view_setting (candidate_id, updated_at) values (${ids.revoked}::uuid, now())`.execute(tx)
      await sql`update candidate_view_setting set advanced_enabled = true where candidate_id = ${ids.revoked}::uuid`.execute(tx)
    })
    await sql`delete from candidate_view_setting where candidate_id = ${ids.revoked}::uuid`.execute(admin)
  })

  it("outcome.type accepts offer and still refuses an unknown type", async () => {
    const check = (await sql<{ def: string }>`select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'outcome'::regclass and contype = 'c' and conname = 'outcome_type_check'`.execute(admin)).rows
    expect(check).toHaveLength(1)
    expect(check[0]!.def).toContain("'offer'")
    const application = await seedApplication(ids.operator)
    await sql`insert into outcome (id, candidate_id, application_id, type, created_at, updated_at) values (${randomUUID()}::uuid, ${ids.operator}::uuid, ${application}::uuid, 'offer', now(), now())`.execute(admin)
    await expect(sql`insert into outcome (id, candidate_id, application_id, type, created_at, updated_at) values (${randomUUID()}::uuid, ${ids.operator}::uuid, ${application}::uuid, 'promotion', now(), now())`.execute(admin)).rejects.toThrow(/outcome_type_check/)
  })

  it("UPG:47 a rerun (up after down) never overwrites a flag a user set; the marker is recorded once", async () => {
    await sql`update candidate_view_setting set advanced_enabled = true, simpler_note_due = false where candidate_id = ${ids.active}::uuid`.execute(admin)
    // Step off the later 0034 to 0041 first, then down 0033 refuses while an offer Outcome exists.
    expect((await migrator().migrateDown()).error).toBeUndefined()
    expect((await migrator().migrateDown()).error).toBeUndefined()
    expect((await migrator().migrateDown()).error).toBeUndefined()
    expect((await migrator().migrateDown()).error).toBeUndefined()
    expect((await migrator().migrateDown()).error).toBeUndefined()
    expect((await migrator().migrateDown()).error).toBeUndefined()
    expect((await migrator().migrateDown()).error).toBeUndefined()
    expect((await migrator().migrateDown()).error).toBeUndefined()
    const refused = await migrator().migrateDown()
    expect((refused.error as Error | undefined)?.message).toMatch(/offer/)
    await sql`delete from outcome where type = 'offer'`.execute(admin)
    expect((await sql`select 1 from migration_marker where name = ${SIMPLIFY_EVE_MARKER}`.execute(admin)).rows).toHaveLength(1)
    const down = await migrator().migrateDown()
    expect(down.error).toBeUndefined()
    expect((await sql`select 1 from pg_tables where tablename = 'candidate_view_setting'`.execute(admin)).rows).toEqual([])
    expect((await sql`select 1 from migration_marker where name = ${SIMPLIFY_EVE_MARKER}`.execute(admin)).rows).toEqual([])
    const def = (await sql<{ def: string }>`select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'outcome'::regclass and contype = 'c' and conname = 'outcome_type_check'`.execute(admin)).rows[0]!.def
    expect(def).not.toContain("'offer'")
    expect((await migrator().migrateToLatest()).error).toBeUndefined()
    expect((await sql`select 1 from migration_marker where name = ${SIMPLIFY_EVE_MARKER}`.execute(admin)).rows).toHaveLength(1)
    // down + up re-seeds from scratch (the table was dropped), so the invitee is back to the seed values.
    expect((await settings()).find((row) => row.id === ids.active)).toMatchObject({ advanced_enabled: false, simpler_note_due: true })
  })
})

async function seedApplication(candidateId: string): Promise<string> {
  const posting = randomUUID()
  const url = `https://boards.greenhouse.io/acme/jobs/${posting}`
  await sql`insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, title_folded, company, structured, role_family, discovered_at)
    values (${posting}::uuid, ${url}, ${posting.slice(0, 12)}, ${url}, 'greenhouse', 'automatic', 'employer_board', 'Engineer', 'engineer', 'Acme', '{}', 'senior_frontend', now())`.execute(admin)
  const id = randomUUID()
  await sql`insert into application (candidate_id, id, job_posting_id, application_url, requisition_id, company, role_title, state, career_profile_version, created_at, updated_at)
    values (${candidateId}::uuid, ${id}::uuid, ${posting}::uuid, ${url}, ${posting.slice(0, 12)}, 'Acme', 'Engineer', 'documents_ready', 1, now(), now())`.execute(admin)
  return id
}
