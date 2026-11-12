import { randomUUID } from "node:crypto"

import { type Kysely, sql } from "kysely"
import { Migrator } from "kysely/migration"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import { grantDatabaseAccess } from "../src/db/database-roles.js"
import { migrationsFor } from "../src/db/migrations/index.js"
import { PASTED_DESCRIPTION_MARKER } from "../src/db/migrations/0031-pasted-description.js"
import { SCHEMA_MARKERS } from "../src/db/migrations/schema-markers.js"
import { rolesFor, urlFor } from "./support/postgres-cluster.js"

/**
 * Migration 0031-pasted-description (EPIC-0010 architecture "Data model change", ADR 0013, risk R2).
 * A database built to 0030 as production is (owner role, FORCE RLS binds it), then 0031 up,
 * down (lossless: pasted rows become pasted_link, nothing deleted) and up again. Seeds and
 * reads use the bootstrap superuser; the RLS checks use the runtime role.
 */
const ALL = migrationsFor({ operatorGoogleSub: "google-sub-ada-0031" })
type Db = Kysely<unknown>
let cluster: Db
let admin: Db
let owner: Db
let runtime: Db
let name: string
let operatorId: string
let inviteeId: string

const migrator = () => new Migrator({ db: owner, provider: { getMigrations: async () => ALL } })

beforeAll(async () => {
  cluster = createDatabase(inject("postgresAdminUrl")) as unknown as Db
  name = `ja_pd31_${randomUUID().replaceAll("-", "").slice(0, 16)}`
  await sql`create database ${sql.id(name)}`.execute(cluster)
  const clusterUrl = inject("postgresAdminUrl")
  const roles = rolesFor(name)
  admin = createDatabase(urlFor(clusterUrl, undefined, name)) as unknown as Db
  await grantDatabaseAccess(admin, roles)
  owner = createDatabase(urlFor(clusterUrl, roles.owner, name)) as unknown as Db
  const through0030 = Object.fromEntries(Object.entries(ALL).filter(([key]) => key <= "0030-ats-minimum"))
  const { error } = await new Migrator({ db: owner, provider: { getMigrations: async () => through0030 } }).migrateToLatest()
  if (error) throw error
  operatorId = (await sql<{ id: string }>`select id::text as id from candidate where role = 'operator'`.execute(admin)).rows[0]!.id
  inviteeId = (await sql<{ id: string }>`insert into candidate (email, google_sub, role, state) values ('bola@example.com', 'sub-bola', 'candidate', 'active') returning id::text as id`.execute(admin)).rows[0]!.id
  runtime = createDatabase(urlFor(clusterUrl, roles.runtime, name)) as unknown as Db
})

afterAll(async () => {
  for (const db of [runtime, owner, admin]) await db?.destroy()
  await sql`drop database if exists ${sql.id(name)} with (force)`.execute(cluster)
  await cluster.destroy()
})

async function insertPasted(candidateId: string): Promise<string> {
  const id = randomUUID()
  await sql`insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, company, posting_text, structured, discovered_at, owner_candidate_id, paste_fingerprint)
    values (${id}::uuid, ${`urn:eve:pasted:${id}`}, ${`pasted:${id}`}, ${`urn:eve:pasted:${id}`}, 'none', 'manual', 'pasted_description', 'Engineer', 'Paystack', 'secret text', '{}', now(), ${candidateId}::uuid, ${id})`.execute(admin)
  await sql`insert into candidate_posting (candidate_id, job_posting_id, origin, status, discovered_at) values (${candidateId}::uuid, ${id}::uuid, 'pasted_description', 'ranked', now())`.execute(admin)
  return id
}

/** Rows of job_posting the runtime role sees in `candidateId`'s scope, bound as forCandidate binds it. */
async function visibleTo(candidateId: string): Promise<string[]> {
  return runtime.transaction().execute(async (tx) => {
    await sql`select set_config('eve.candidate_id', ${candidateId}, true), public.bind_candidate(${candidateId}::uuid)`.execute(tx)
    return ids(tx)
  })
}

async function ids(tx: Db): Promise<string[]> {
  return (await sql<{ id: string }>`select id::text as id from job_posting order by id`.execute(tx)).rows.map((row) => row.id)
}

/** Unbound variant: only the setting, no bind_candidate. */
async function visibleUnbound(candidateId: string): Promise<string[]> {
  return runtime.transaction().execute(async (tx) => {
    await sql`select set_config('eve.candidate_id', ${candidateId}, true)`.execute(tx)
    return ids(tx)
  })
}

async function insertPrivateAs(tx: Db, candidateId: string): Promise<void> {
  const id = randomUUID()
  await sql`insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, company, posting_text, structured, discovered_at, owner_candidate_id, paste_fingerprint)
    values (${id}::uuid, ${`urn:eve:pasted:${id}`}, ${`pasted:${id}`}, ${`urn:eve:pasted:${id}`}, 'none', 'manual', 'pasted_description', 'Engineer', 'Paystack', 'text', '{}', now(), ${candidateId}::uuid, ${id})`.execute(tx)
}

describe("migration 0031: pasted descriptions", () => {
  it("up adds the columns, constraints, indexes, forced RLS and marker", async () => {
    const { error } = await migrator().migrateToLatest()
    expect(error).toBeUndefined()
    expect(SCHEMA_MARKERS).toContain(PASTED_DESCRIPTION_MARKER)
    expect((await sql`select name from migration_marker where name = ${PASTED_DESCRIPTION_MARKER}`.execute(admin)).rows).toHaveLength(1)
    const checks = await sql<{ conname: string; def: string }>`select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid in ('job_posting'::regclass, 'candidate_posting'::regclass) and conname like '%origin_check' or conname like 'job_posting_pasted_%' order by conname`.execute(admin)
    expect(checks.rows.map((row) => row.conname)).toEqual(["candidate_posting_origin_check", "job_posting_origin_check", "job_posting_pasted_fingerprint_check", "job_posting_pasted_manual_check", "job_posting_pasted_owner_check"])
    expect(checks.rows[0]!.def).toContain("'pasted_description'::text")
    const rls = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>`select relrowsecurity, relforcerowsecurity from pg_class where relname = 'job_posting'`.execute(admin)
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true })
    const indexes = await sql<{ indexname: string }>`select indexname from pg_indexes where indexname like 'job_posting_pasted_%' order by indexname`.execute(admin)
    expect(indexes.rows.map((row) => row.indexname)).toEqual(["job_posting_pasted_link_uq", "job_posting_pasted_text_uq"])
  })

  it("CHECKs tie pasted to an owner and to manual; RLS shows a private row to its owner only, shared rows to all", async () => {
    const shared = randomUUID()
    await sql`insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, posting_text, structured, discovered_at)
      values (${shared}::uuid, 'https://x.test/1', 'r1', 'https://x.test/1', 'x.test', 'manual', 'pasted_link', '', '{}', now())`.execute(admin)
    const ada = await insertPasted(operatorId)
    expect(await visibleTo(operatorId)).toEqual([ada, shared].sort())
    expect(await visibleTo(inviteeId)).toEqual([shared])
    await expect(sql`update job_posting set apply_mode = 'automatic' where id = ${ada}::uuid`.execute(admin)).rejects.toThrow(/job_posting_pasted_manual_check/)
    await expect(sql`update job_posting set owner_candidate_id = null where id = ${ada}::uuid`.execute(admin)).rejects.toThrow(/job_posting_pasted_owner_check/)
    await expect(sql`update job_posting set paste_fingerprint = 'x' where id = ${shared}::uuid`.execute(admin)).rejects.toThrow(/job_posting_pasted_fingerprint_check/)
  })

  it("r2 binding: the policy names bound_candidate() and the setting in both clauses", async () => {
    const def = await sql<{ qual: string; with_check: string }>`select qual, with_check from pg_policies where tablename = 'job_posting' and policyname = 'job_posting_owner'`.execute(admin)
    for (const text of [def.rows[0]!.qual, def.rows[0]!.with_check]) {
      expect(text).toContain("bound_candidate()")
      expect(text).toContain("eve.candidate_id")
    }
  })

  it("an honest bound scope sees its own private row and the shared row", async () => {
    const own = await insertPasted(inviteeId)
    const seen = await visibleTo(inviteeId)
    expect(seen).toContain(own)
    expect(seen).toHaveLength(2)
    await sql`delete from candidate_posting where job_posting_id = ${own}::uuid`.execute(admin)
    await sql`delete from job_posting where id = ${own}::uuid`.execute(admin)
  })

  it("re-pointing eve.candidate_id inside a bound transaction sees no private rows and refuses a private insert", async () => {
    const [shared] = (await sql<{ id: string }>`select id::text as id from job_posting where owner_candidate_id is null`.execute(admin)).rows
    for (const repoint of [(tx: Db) => sql`select set_config('eve.candidate_id', ${operatorId}, true)`.execute(tx), (tx: Db) => sql.raw(`set local eve.candidate_id = '${operatorId}'`).execute(tx)]) {
      await runtime.transaction().execute(async (tx) => {
        await sql`select set_config('eve.candidate_id', ${inviteeId}, true), public.bind_candidate(${inviteeId}::uuid)`.execute(tx)
        await repoint(tx)
        expect(await ids(tx)).toEqual([shared!.id])
      })
      await expect(
        runtime.transaction().execute(async (tx) => {
          await sql`select set_config('eve.candidate_id', ${inviteeId}, true), public.bind_candidate(${inviteeId}::uuid)`.execute(tx)
          await repoint(tx)
          await insertPrivateAs(tx, operatorId)
        }),
      ).rejects.toThrow(/row-level security/)
    }
  })

  it("setting eve.candidate_id on an unbound connection sees no private rows and refuses a private insert", async () => {
    expect(await visibleUnbound(operatorId)).toHaveLength(1)
    await expect(
      runtime.transaction().execute(async (tx) => {
        await sql`select set_config('eve.candidate_id', ${operatorId}, true)`.execute(tx)
        await insertPrivateAs(tx, operatorId)
      }),
    ).rejects.toThrow(/row-level security/)
  })

  it("clearing the setting in a bound transaction sees no private rows", async () => {
    await runtime.transaction().execute(async (tx) => {
      await sql`select set_config('eve.candidate_id', ${operatorId}, true), public.bind_candidate(${operatorId}::uuid)`.execute(tx)
      expect(await ids(tx)).toHaveLength(2)
      await sql`select set_config('eve.candidate_id', '', true)`.execute(tx)
      expect(await ids(tx)).toHaveLength(1)
    })
  })

  it("down keeps every row (pasted become pasted_link, still manual), then up runs again", async () => {
    const before = (await sql<{ n: number }>`select count(*)::int as n from job_posting`.execute(admin)).rows[0]!.n
    // 0032 to 0041 follow it: step off all ten first, then down 0031.
    expect((await migrator().migrateDown()).error).toBeUndefined()
    expect((await migrator().migrateDown()).error).toBeUndefined()
    expect((await migrator().migrateDown()).error).toBeUndefined()
    expect((await migrator().migrateDown()).error).toBeUndefined()
    expect((await migrator().migrateDown()).error).toBeUndefined()
    expect((await migrator().migrateDown()).error).toBeUndefined()
    expect((await migrator().migrateDown()).error).toBeUndefined()
    expect((await migrator().migrateDown()).error).toBeUndefined()
    expect((await migrator().migrateDown()).error).toBeUndefined()
    expect((await migrator().migrateDown()).error).toBeUndefined()
    const { error } = await migrator().migrateDown()
    expect(error).toBeUndefined()
    const rows = await sql<{ origin: string; apply_mode: string }>`select origin, apply_mode from job_posting where requisition_id like 'pasted:%'`.execute(admin)
    expect(rows.rows).toEqual([{ origin: "pasted_link", apply_mode: "manual" }])
    expect((await sql<{ n: number }>`select count(*)::int as n from job_posting`.execute(admin)).rows[0]!.n).toBe(before)
    expect((await sql`select 1 from information_schema.columns where table_name = 'job_posting' and column_name in ('owner_candidate_id', 'paste_fingerprint')`.execute(admin)).rows).toEqual([])
    expect((await sql<{ relrowsecurity: boolean }>`select relrowsecurity from pg_class where relname = 'job_posting'`.execute(admin)).rows[0]).toEqual({ relrowsecurity: false })
    expect((await sql`select name from migration_marker where name = ${PASTED_DESCRIPTION_MARKER}`.execute(admin)).rows).toEqual([])
    const again = await migrator().migrateToLatest()
    expect(again.error).toBeUndefined()
  })
})
