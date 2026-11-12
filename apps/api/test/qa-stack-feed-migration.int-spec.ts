import { randomUUID } from "node:crypto"

import { type Kysely, sql } from "kysely"
import { Migrator } from "kysely/migration"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import { migrateAndGrant } from "../src/db/migrate-and-grant.js"
import { migrationsFor } from "../src/db/migrations/index.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { LEGACY_TABLE, OWN_TABLE, epic8MigrationName } from "./support/qa-stack-feed.js"

/**
 * QA-authored (EPIC-0008, run epic-0008, test authoring).
 * stack-feed-migration.feature r1, database side (AC 5.1, 5.2, 5.5, 5.6, 5.7):
 * migration NNNN-alert-feed-candidate-verification (api-contract.md "Migration
 * 0024"; 0022 before the merge renumber). Each case builds a fresh database, migrates to the migration before
 * EPIC-0008, shapes the Candidates and the legacy row, then runs the EPIC-0008
 * migration through Kysely's Migrator (superuser) or, for the deploy rows,
 * through the real `migrateAndGrant` as the owner role, so the copy runs under
 * forced RLS the way production runs it.
 *
 * The migration is found by name suffix, so a D19 renumber at merge keeps the
 * tests valid. It is targeted by name (Migrator.migrateTo), never "to latest",
 * so migrations merged after it (0025-apply-anyway onward) do not change what
 * these cases apply. Before the migration exists every test here fails on the
 * "migration exists" assertion, which is the expected red.
 */
const OWNER_SUB = "100000000000000000001"
const ALL = migrationsFor({ operatorGoogleSub: OWNER_SUB })
const NAME = epic8MigrationName(Object.keys(ALL))
const BEFORE = Object.fromEntries(Object.entries(ALL).filter(([name]) => NAME !== undefined && name < NAME))
/** Migrations merged after EPIC-0008 (D19: merge order decides), in order. */
const AFTER = Object.keys(ALL)
  .filter((name) => NAME !== undefined && name > NAME)
  .sort()
const LEGACY = { verified_on: "2026-09-30", verification_basis: "Reviewed Google Alerts terms on 30 Sep.", updated_at: new Date("2026-09-30T10:15:00.000Z") }

type Db = Kysely<unknown>
let cluster: Db
const opened: { name: string; db: Db }[] = []

beforeAll(() => {
  cluster = createDatabase(inject("postgresAdminUrl")) as unknown as Db
})

afterAll(async () => {
  for (const { name, db } of opened) {
    await db.destroy()
    await sql`drop database if exists ${sql.id(name)} with (force)`.execute(cluster)
  }
  await cluster?.destroy()
})

/** A fresh database migrated (as superuser) to the migration before EPIC-0008, with the Operator 0016 created. */
async function beforeEpic8(): Promise<{ db: Db; operatorId: string }> {
  expect(NAME, "a migration named NNNN-alert-feed-candidate-verification (api-contract.md Migration 0024)").toBeDefined()
  const name = `ja_qa8_${randomUUID().replaceAll("-", "").slice(0, 16)}`
  await sql`create database ${sql.id(name)}`.execute(cluster)
  const url = new URL(inject("postgresAdminUrl"))
  url.pathname = `/${name}`
  const db = createDatabase(url.toString()) as unknown as Db
  opened.push({ name, db })
  const { error } = await new Migrator({ db, provider: { getMigrations: async () => BEFORE } }).migrateToLatest()
  if (error) throw error
  const operatorId = (await sql<{ id: string }>`select id::text from candidate where role = 'operator'`.execute(db)).rows[0]!.id
  await sql`update candidate set email = 'ada@example.com' where id = ${operatorId}::uuid`.execute(db)
  return { db, operatorId }
}

/** Applies exactly the EPIC-0008 migration, whatever was merged after it. */
async function runEpic8(db: Db): Promise<void> {
  const { error, results } = await new Migrator({ db, provider: { getMigrations: async () => ALL } }).migrateTo(NAME!)
  if (error) throw error
  expect(results?.map((r) => [r.migrationName, r.status])).toEqual([[NAME, "Success"]])
}

const insertLegacy = (db: Db) =>
  sql`insert into alert_feed_verification (verified_on, verification_basis, updated_at) values (${LEGACY.verified_on}::date, ${LEGACY.verification_basis}, ${LEGACY.updated_at})`.execute(db)

const addInvitee = async (db: Db, email: string, state: "active" | "revoked" | "deleting" = "active", role: "candidate" | "operator" = "candidate") =>
  (await sql<{ id: string }>`insert into candidate (email, google_sub, role, state) values (${email}, ${`sub-${randomUUID()}`}, ${role}, ${state}) returning id::text`.execute(db)).rows[0]!.id

const ownRows = async (db: Db) =>
  (await sql<{ candidate_id: string; verified_on: string; verification_basis: string; updated_at: Date }>`
    select candidate_id::text, verified_on::text, verification_basis, updated_at from alert_feed_candidate_verification order by candidate_id`.execute(db)).rows

const legacyRows = async (db: Db) =>
  (await sql<{ verified_on: string; verification_basis: string; updated_at: Date }>`select verified_on::text, verification_basis, updated_at from alert_feed_verification`.execute(db)).rows

const tableExists = async (db: Db, table: string) => (await sql<{ n: number }>`select count(*)::int as n from pg_tables where schemaname = 'public' and tablename = ${table}`.execute(db)).rows[0]!.n === 1

describe("the migration is registered (migration:301, :309; contract 'Registration')", () => {
  it("exists, sits after 0023 and before any later migration, and its marker is required at boot", async () => {
    expect(NAME).toBeDefined()
    const names = Object.keys(ALL).sort()
    const index = names.indexOf(NAME!)
    expect(names[index - 1]).toMatch(/^0023-/)
    expect(names.slice(index + 1)).toEqual(AFTER)
    expect(AFTER.every((name) => name > NAME!)).toBe(true)
    const { SCHEMA_MARKERS } = await import("../src/db/migrations/schema-markers.js")
    expect(SCHEMA_MARKERS).toContain(NAME)
  })
})

describe("copy into the single Operator only (migration:21, :30, :72, :113; AC 5.2)", () => {
  it("migration:21 the legacy row is copied byte-for-byte into the one Operator; the table holds exactly one row", async () => {
    const { db, operatorId } = await beforeEpic8()
    await addInvitee(db, "bola@example.com")
    await addInvitee(db, "chidi@example.com")
    await insertLegacy(db)
    await runEpic8(db)
    expect(await ownRows(db)).toEqual([{ candidate_id: operatorId, ...LEGACY }])
    // Byte-identical: compared in the database, not through JS.
    const same = await sql<{ same: boolean }>`select (o.verified_on, o.verification_basis, o.updated_at) = (l.verified_on, l.verification_basis, l.updated_at) as same
      from alert_feed_candidate_verification o, alert_feed_verification l`.execute(db)
    expect(same.rows).toEqual([{ same: true }])
  })

  it.each([
    ["active", "bola@example.com"],
    ["revoked", "chidi@example.com"],
  ] as const)("migration:30 an invited Candidate in state %s gets no copied record", async (state, email) => {
    const { db } = await beforeEpic8()
    const inviteeId = await addInvitee(db, email, state)
    await insertLegacy(db)
    await runEpic8(db)
    expect((await ownRows(db)).map((r) => r.candidate_id)).not.toContain(inviteeId)
  })

  it("migration:113 an Operator whose identity state is revoked still gets the copy (GH-3)", async () => {
    const { db, operatorId } = await beforeEpic8()
    await sql`update candidate set state = 'revoked' where id = ${operatorId}::uuid`.execute(db)
    await insertLegacy(db)
    await runEpic8(db)
    expect(await ownRows(db)).toEqual([{ candidate_id: operatorId, ...LEGACY }])
  })

  it("migration:72, copy-and-unchanged:171 the migration touches no Hiring table", async () => {
    const { db, operatorId } = await beforeEpic8()
    await insertLegacy(db)
    await sql`insert into hiring_alert_feed (candidate_id, id, url, label, created_at) values (${operatorId}::uuid, gen_random_uuid(), 'https://www.google.com/alerts/feeds/01234567890123456789/5555555555555123456', null, now())`.execute(db)
    const fingerprint = async () =>
      (await sql<{ t: string; h: string }>`select 'hiring_feed_verification' as t, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h from hiring_feed_verification x
        union all select 'hiring_alert_feed', md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from hiring_alert_feed x
        union all select 'hiring_post', md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from hiring_post x
        union all select 'hiring_post_run', md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from hiring_post_run x`.execute(db)).rows
    const before = await fingerprint()
    await runEpic8(db)
    expect(await fingerprint()).toEqual(before)
    expect((await sql<{ n: number }>`select count(*)::int as n from hiring_feed_verification`.execute(db)).rows[0]!.n).toBe(0)
  })
})

describe("nothing to copy (migration:82, :90; AC 5.2, 5.7)", () => {
  it("migration:82 no legacy row: the table is empty and the migration succeeds", async () => {
    const { db } = await beforeEpic8()
    await runEpic8(db)
    expect(await ownRows(db)).toEqual([])
  })

  it("migration:90 row 1: no Candidate has role operator → nothing copied, no error", async () => {
    const { db, operatorId } = await beforeEpic8()
    await sql`update candidate set role = 'candidate' where id = ${operatorId}::uuid`.execute(db)
    await insertLegacy(db)
    await runEpic8(db)
    expect(await ownRows(db)).toEqual([])
  })

  it("migration:90 row 2: two Candidates have role operator → nothing copied, no error", async () => {
    const { db } = await beforeEpic8()
    // Fixture only: the one-Operator index forbids this state; drop it to reach the guarded branch.
    await sql`drop index if exists candidate_one_operator`.execute(db)
    await addInvitee(db, "bola@example.com", "active", "operator")
    await insertLegacy(db)
    await runEpic8(db)
    expect(await ownRows(db)).toEqual([])
  })

  it("migration:90 row 3: no Candidate exists → nothing copied, no error", async () => {
    const { db } = await beforeEpic8()
    await sql`delete from candidate`.execute(db)
    await insertLegacy(db)
    await runEpic8(db)
    expect(await ownRows(db)).toEqual([])
  })
})

describe("deletes nothing, leaves the legacy row (migration:201, :211; AC 5.4, 5.5)", () => {
  it("migration:201 every Alert feed, Stack post and read run is unchanged; migration:211 the legacy row is unchanged", async () => {
    const { db, operatorId } = await beforeEpic8()
    const bolaId = await addInvitee(db, "bola@example.com")
    await insertLegacy(db)
    for (const [id, feeds, posts] of [
      [operatorId, 3, 40],
      [bolaId, 2, 5],
    ] as const) {
      for (let i = 0; i < feeds; i += 1) {
        await sql`insert into alert_feed (candidate_id, id, url, label, created_at) values (${id}::uuid, gen_random_uuid(), ${`https://www.google.com/alerts/feeds/04444444444444444444/${900000000 + i}`}, null, now())`.execute(db)
      }
      for (let i = 0; i < posts; i += 1) {
        await sql`insert into stack_post (candidate_id, id, canonical_url, kind, first_seen_at) values (${id}::uuid, gen_random_uuid(), ${`https://www.linkedin.com/posts/m-${id}-${i}`}, 'post', now())`.execute(db)
      }
      await sql`insert into stack_post_run (candidate_id, id, started_at, finished_at, outcome) values (${id}::uuid, gen_random_uuid(), now(), now(), 'completed')`.execute(db)
    }
    const snapshot = async () =>
      (await sql<{ t: string; h: string }>`select 'alert_feed' as t, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h from alert_feed x
        union all select 'stack_post', md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from stack_post x
        union all select 'stack_post_run', md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from stack_post_run x
        union all select 'alert_feed_verification', md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from alert_feed_verification x`.execute(db)).rows
    const before = await snapshot()
    await runEpic8(db)
    expect(await snapshot()).toEqual(before)
    expect(await legacyRows(db)).toEqual([LEGACY])
  })
})

describe("down and up again (migration:244, :252; AC 5.6)", () => {
  it("migration:244 down drops the new table only and leaves the legacy row; :252 up again copies the same row", async () => {
    const { db, operatorId } = await beforeEpic8()
    const bolaId = await addInvitee(db, "bola@example.com")
    await insertLegacy(db)
    const migrator = new Migrator({ db, provider: { getMigrations: async () => ALL } })
    await runEpic8(db)
    await sql`insert into alert_feed_candidate_verification (candidate_id, verified_on, verification_basis, updated_at) values (${bolaId}::uuid, '2026-10-21', 'Bola saved later', now())`.execute(db)
    const down = await migrator.migrateDown()
    expect(down.error).toBeUndefined()
    expect(down.results?.map((r) => r.migrationName)).toEqual([NAME])
    expect(await tableExists(db, OWN_TABLE)).toBe(false)
    expect(await tableExists(db, LEGACY_TABLE)).toBe(true)
    expect(await legacyRows(db)).toEqual([LEGACY])
    expect((await sql<{ n: number }>`select count(*)::int as n from migration_marker where name = ${NAME!}`.execute(db)).rows[0]!.n).toBe(0)
    await runEpic8(db)
    expect(await ownRows(db)).toEqual([{ candidate_id: operatorId, ...LEGACY }])
  })
})

describe("table rules (migration:261, :276; AC 5.1)", () => {
  let db: Db
  let bolaId: string

  beforeAll(async () => {
    ;({ db } = await beforeEpic8())
    bolaId = await addInvitee(db, "bola@example.com")
    await runEpic8(db)
  })

  it.each([
    ["no verified_on", "insert into alert_feed_candidate_verification (candidate_id, verification_basis, updated_at) values ($1, 'x', now())"],
    ["no verification_basis", "insert into alert_feed_candidate_verification (candidate_id, verified_on, updated_at) values ($1, '2026-10-21', now())"],
    ["a verification_basis of '' (contract N-2)", "insert into alert_feed_candidate_verification (candidate_id, verified_on, verification_basis, updated_at) values ($1, '2026-10-21', '', now())"],
    ["a verification_basis of 501 code points", "insert into alert_feed_candidate_verification (candidate_id, verified_on, verification_basis, updated_at) values ($1, '2026-10-21', repeat('😀', 501), now())"],
    ["no updated_at (no default)", "insert into alert_feed_candidate_verification (candidate_id, verified_on, verification_basis) values ($1, '2026-10-21', 'x')"],
  ] as const)("migration:261 %s is refused; she has no record", async (_name, statement) => {
    const client = new pg.Client({ connectionString: urlOf(db) })
    await client.connect()
    try {
      await expect(client.query(statement, [bolaId])).rejects.toThrow()
    } finally {
      await client.end()
    }
    expect((await ownRows(db)).filter((r) => r.candidate_id === bolaId)).toEqual([])
  })

  it("migration:261 a candidate_id that matches no Candidate is refused (foreign key)", async () => {
    await expect(sql`insert into alert_feed_candidate_verification (candidate_id, verified_on, verification_basis, updated_at) values (${randomUUID()}::uuid, '2026-10-21', 'x', now())`.execute(db)).rejects.toThrow(/foreign key/)
  })

  it("migration:261 500 code points are accepted", async () => {
    const id = await addInvitee(db, `ok-${randomUUID()}@example.test`)
    await sql`insert into alert_feed_candidate_verification (candidate_id, verified_on, verification_basis, updated_at) values (${id}::uuid, '2026-10-21', repeat('😀', 500), now())`.execute(db)
  })

  it("migration:276 a second row for the same Candidate is refused by the primary key on candidate_id", async () => {
    await sql`insert into alert_feed_candidate_verification (candidate_id, verified_on, verification_basis, updated_at) values (${bolaId}::uuid, '2026-10-21', 'first', now())`.execute(db)
    await expect(sql`insert into alert_feed_candidate_verification (candidate_id, verified_on, verification_basis, updated_at) values (${bolaId}::uuid, '2026-10-22', 'second', now())`.execute(db)).rejects.toThrow(/duplicate key|alert_feed_candidate_verification_pkey/)
    expect((await ownRows(db)).filter((r) => r.candidate_id === bolaId)).toHaveLength(1)
    const pk = await sql<{ def: string }>`select pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_class t on t.oid = c.conrelid where t.relname = ${OWN_TABLE} and c.contype = 'p'`.execute(db)
    expect(pk.rows).toEqual([{ def: "PRIMARY KEY (candidate_id)" }])
  })
})

function urlOf(db: Db): string {
  const entry = opened.find((o) => o.db === db)!
  const url = new URL(inject("postgresAdminUrl"))
  url.pathname = `/${entry.name}`
  return url.toString()
}

describe("the normal deploy (migration:301, :309; AC 5.7), through migrateAndGrant as the owner role under forced RLS", () => {
  let database: TestDatabase

  beforeAll(async () => {
    database = await startMigratedDatabase()
  })

  afterAll(async () => {
    await database?.stop()
  })

  it("rolled back to before EPIC-0008 (path A + drop), the deploy command applies it and copies the legacy row to the Operator; running again changes nothing", async () => {
    expect(NAME).toBeDefined()
    const admin = createDatabase(database.adminUrl) as unknown as Db
    try {
      // The template database already has the migration and any merged after it: return this
      // copy to the state before it. Later migrations are reverted through their own down().
      const back = await new Migrator({ db: admin, provider: { getMigrations: async () => ALL } }).migrateTo(NAME!)
      expect(back.error).toBeUndefined()
      expect(back.results?.map((r) => r.migrationName)).toEqual([...AFTER].reverse())
      await sql`drop table if exists alert_feed_candidate_verification`.execute(admin)
      await sql`delete from kysely_migration where name = ${NAME!}`.execute(admin)
      await sql`delete from migration_marker where name = ${NAME!}`.execute(admin)
      await sql`delete from alert_feed_verification`.execute(admin)
      await insertLegacy(admin)

      const applied = await migrateAndGrant(database.ownerUrl, database.roles.runtime.name, { operatorGoogleSub: OWNER_SUB })
      expect(applied).toEqual([NAME, ...AFTER])
      expect(await ownRows(admin)).toEqual([{ candidate_id: database.operatorId, ...LEGACY }])
      const grants = await sql<{ p: string }>`select privilege_type as p from information_schema.role_table_grants where table_name = ${OWN_TABLE} and grantee = ${database.roles.runtime.name} order by 1`.execute(admin)
      expect(grants.rows.map((r) => r.p)).toEqual(expect.arrayContaining(["DELETE", "INSERT", "SELECT", "UPDATE"]))

      // migration:309 she updates, then migrate-and-grant runs again: nothing changes.
      await sql`update alert_feed_candidate_verification set verified_on = '2026-10-28' where candidate_id = ${database.operatorId}::uuid`.execute(admin)
      expect(await migrateAndGrant(database.ownerUrl, database.roles.runtime.name, { operatorGoogleSub: OWNER_SUB })).toEqual([])
      const rows = await ownRows(admin)
      expect(rows.map((r) => [r.candidate_id, r.verified_on])).toEqual([[database.operatorId, "2026-10-28"]])
    } finally {
      await admin.destroy()
    }
  })
})
