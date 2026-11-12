import { randomUUID } from "node:crypto"

import { preferencesValuesSchema } from "@eve/contracts"
import { type Kysely, sql } from "kysely"
import { Migrator } from "kysely/migration"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import { grantDatabaseAccess } from "../src/db/database-roles.js"
import { PREFERENCES_VERSION_MARKER } from "../src/db/migrations/0027-preferences-version.js"
import { migrationsFor } from "../src/db/migrations/index.js"
import { SCHEMA_MARKERS } from "../src/db/migrations/schema-markers.js"
import { rolesFor, urlFor } from "./support/postgres-cluster.js"

/**
 * EPIC-0002 B1 migration 0027-preferences-version, renumbered from 0026 after apply anyway bounds (architecture.r6 "B1
 * amendment (threat model F-TM-04)"; threat model TM-B1-15; api-contract-b1
 * "Owner migration value shape"). Each case builds its own database at 0026 (apply anyway bounds),
 * provisioned like production, and runs 0027 as the owner role, which FORCE
 * RLS binds, so the migration's `eve.candidate_id` handling is exercised for
 * real. Seeds and assertions use the bootstrap superuser.
 */
const OWNER_SUB = "google-sub-ada-0026"
const ALL = migrationsFor({ operatorGoogleSub: OWNER_SUB })
const NAME = "0027-preferences-version"
const BEFORE_0027 = Object.fromEntries(Object.entries(ALL).filter(([name]) => name < NAME))
/** Migrations up to and including 0027: later ones (0028 ATS skills) are not this test's subject. */
const THROUGH_0027 = Object.fromEntries(Object.entries(ALL).filter(([name]) => name <= NAME))

type Db = Kysely<unknown>
type Fresh = Readonly<{ admin: Db; owner: Db; operatorId: string }>
type Values = Record<string, unknown>
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

async function databaseAt0026(): Promise<Fresh> {
  const name = `ja_b1_mig_${randomUUID().replaceAll("-", "").slice(0, 16)}`
  await sql`create database ${sql.id(name)}`.execute(cluster)
  const clusterUrl = inject("postgresAdminUrl")
  const roles = rolesFor(name)
  const admin = createDatabase(urlFor(clusterUrl, undefined, name)) as unknown as Db
  await grantDatabaseAccess(admin, roles)
  const owner = createDatabase(urlFor(clusterUrl, roles.owner, name)) as unknown as Db
  opened.push({ name, dbs: [admin, owner] })
  const { error } = await new Migrator({ db: owner, provider: { getMigrations: async () => BEFORE_0027 } }).migrateToLatest()
  if (error) throw error
  const operatorId = (await sql<{ id: string }>`select id::text as id from candidate where role = 'operator'`.execute(admin)).rows[0]!.id
  return { admin, owner, operatorId }
}

const migrate = (db: Db) => new Migrator({ db, provider: { getMigrations: async () => THROUGH_0027 } }).migrateToLatest()

async function current(admin: Db): Promise<{ candidate_id: string; version: number; values: Values }[]> {
  return (await sql<{ candidate_id: string; version: number; values: Values }>`select candidate_id::text, version, values from job_preferences order by candidate_id`.execute(admin)).rows
}

async function history(admin: Db): Promise<{ candidate_id: string; version: number; text: string }[]> {
  return (await sql<{ candidate_id: string; version: number; text: string }>`select candidate_id::text, version, values::text as text from job_preferences_version order by candidate_id, version`.execute(admin)).rows
}

async function lastMigration(admin: Db): Promise<string | undefined> {
  return (await sql<{ name: string }>`select name from kysely_migration order by name desc limit 1`.execute(admin)).rows[0]?.name
}

async function hasColumn(admin: Db): Promise<boolean> {
  const { rows } = await sql<{ n: number }>`select count(*)::int as n from information_schema.columns where table_schema = 'public' and table_name = 'candidate_posting' and column_name = 'preferences_version'`.execute(admin)
  return rows[0]!.n === 1
}

async function invitee(admin: Db, email: string): Promise<string> {
  return (await sql<{ id: string }>`insert into candidate (email, google_sub, role, state) values (${email}, ${`sub-${email}`}, 'candidate', 'active') returning id::text as id`.execute(admin)).rows[0]!.id
}

async function posting(admin: Db, holder: string, status: string): Promise<void> {
  const id = randomUUID()
  const url = `https://boards.greenhouse.io/acme/jobs/${id}`
  await sql`insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, company, structured, role_family, discovered_at)
    values (${id}::uuid, ${url}, ${id}, ${url}, 'greenhouse', 'automatic', 'employer_board', 'Senior Frontend Engineer', 'Acme', '{}', 'senior_frontend', now())`.execute(admin)
  await sql`insert into candidate_posting (candidate_id, job_posting_id, origin, status, discovered_at, evaluated_at)
    values (${holder}::uuid, ${id}::uuid, 'employer_board', ${status}, now(), now())`.execute(admin)
}

/** Changes the Operator's current value (v1) the way a bad source row would have, before 0027 reads it. */
async function patchOperatorValue(fresh: Fresh, patch: Values): Promise<void> {
  await sql`update job_preferences set values = values || ${JSON.stringify(patch)}::jsonb where candidate_id = ${fresh.operatorId}::uuid`.execute(fresh.admin)
}

describe("migration 0027: registration", () => {
  it("is registered after 0026 and its marker is required at boot", () => {
    expect(Object.keys(THROUGH_0027).at(-1)).toBe(NAME)
    expect(PREFERENCES_VERSION_MARKER).toBe(NAME)
    expect(SCHEMA_MARKERS).toContain(NAME)
  })
})

describe("migration 0027: the Operator's v2 (TM-B1-15)", () => {
  it("writes v2 that parses with preferencesValuesSchema; the only diffs from v1 are the two changed keys and the removed key; v1 stays byte-equal", async () => {
    const fresh = await databaseAt0026()
    const [before] = await current(fresh.admin)
    const v1Text = (await history(fresh.admin))[0]!.text
    const { error, results } = await migrate(fresh.owner)
    expect(error).toBeUndefined()
    expect(results?.map((result) => [result.migrationName, result.status])).toEqual([[NAME, "Success"]])

    const [after] = await current(fresh.admin)
    expect(after).toMatchObject({ candidate_id: fresh.operatorId, version: 2 })
    expect(preferencesValuesSchema.safeParse(after!.values).success).toBe(true)
    const v1 = before!.values
    const v2 = after!.values
    expect(v2).not.toHaveProperty("excludedRoleFamilies")
    expect(v2.seniorityLevels).toEqual(["junior", "mid", "senior", "staff", "principal"])
    expect(v2.roleFamilyTiers).toEqual({ ...(v1.roleFamilyTiers as Values), software_engineering: 3, platform_engineering: 3, data_ml: 3, solutions_customer: 3 })
    const changed = new Set(["seniorityLevels", "roleFamilyTiers", "excludedRoleFamilies"])
    const unchanged = (value: Values) => Object.fromEntries(Object.entries(value).filter(([key]) => !changed.has(key)))
    expect(unchanged(v2)).toEqual(unchanged(v1))

    const rows = await history(fresh.admin)
    expect(rows.map((row) => [row.candidate_id, row.version])).toEqual([[fresh.operatorId, 1], [fresh.operatorId, 2]])
    expect(rows[0]!.text).toBe(v1Text)
    expect(JSON.parse(rows[1]!.text)).toEqual(v2)
  })

  it("adds candidate_posting.preferences_version integer not null default 0, and changes no status, other Candidate, outbox or spend row", async () => {
    const fresh = await databaseAt0026()
    const bola = await invitee(fresh.admin, "bola@example.com")
    await posting(fresh.admin, fresh.operatorId, "ranked")
    await posting(fresh.admin, fresh.operatorId, "skipped")
    await posting(fresh.admin, bola, "waiting_to_be_checked")
    const snapshot = async () => ({
      postings: (await sql`select candidate_id::text, job_posting_id::text, status, skip_reason, skip_detail, evaluated_at::text from candidate_posting order by 1, 2`.execute(fresh.admin)).rows,
      outbox: (await sql`select count(*)::int as n from notification_outbox`.execute(fresh.admin)).rows,
      spend: (await sql`select count(*)::int as n from spend_entry`.execute(fresh.admin)).rows,
      applications: (await sql`select count(*)::int as n from application`.execute(fresh.admin)).rows,
    })
    const before = await snapshot()
    expect(await hasColumn(fresh.admin)).toBe(false)

    expect((await migrate(fresh.owner)).error).toBeUndefined()

    expect(await snapshot()).toEqual(before)
    const column = await sql<{ data_type: string; is_nullable: string; column_default: string }>`
      select data_type, is_nullable, column_default from information_schema.columns where table_name = 'candidate_posting' and column_name = 'preferences_version'`.execute(fresh.admin)
    expect(column.rows).toEqual([{ data_type: "integer", is_nullable: "NO", column_default: "0" }])
    const versions = await sql<{ v: number }>`select distinct preferences_version as v from candidate_posting`.execute(fresh.admin)
    expect(versions.rows).toEqual([{ v: 0 }])
    expect((await current(fresh.admin)).map((row) => row.candidate_id)).toEqual([fresh.operatorId])
    expect((await history(fresh.admin)).filter((row) => row.candidate_id === bola)).toEqual([])
  })

  it("resets eve.candidate_id to '' before the marker, and records the marker", async () => {
    const fresh = await databaseAt0026()
    // Run 0027 in an outer transaction that the Migrator joins, so the setting can be read after it.
    await fresh.owner.transaction().execute(async (trx) => {
      const { error } = await new Migrator({ db: trx, provider: { getMigrations: async () => THROUGH_0027 } }).migrateToLatest()
      expect(error).toBeUndefined()
      const setting = await sql<{ value: string | null }>`select current_setting('eve.candidate_id', true) as value`.execute(trx)
      expect(setting.rows[0]!.value).toBe("")
    })
    const markers = (await sql<{ name: string }>`select name from migration_marker`.execute(fresh.admin)).rows.map((row) => row.name)
    expect(markers).toContain(NAME)
  })

  it("leaves a Candidate with no record without one", async () => {
    const fresh = await databaseAt0026()
    const bola = await invitee(fresh.admin, "bola@example.com")
    expect((await migrate(fresh.owner)).error).toBeUndefined()
    expect((await current(fresh.admin)).find((row) => row.candidate_id === bola)).toBeUndefined()
  })
})

describe("migration 0027: the preflight fails closed (F-TM-04)", () => {
  const pay = (basis: "gross" | "net", patch: Values) => ({ amount: basis === "gross" ? "2000.00" : "5000.00", currency: "USD", period: "month", basis, ...patch })

  it.each([
    ["preferredPay.currency", { preferredPay: pay("net", { currency: "NGN" }) }, /NGN/],
    ["preferredPay.amount", { preferredPay: pay("net", { amount: "1234567890.00" }) }, /1234567890/],
    ["latestWorkHour", { latestWorkHour: "00:30" }, /00:30/],
    ["timeZone", { timeZone: "Mars/Base" }, /Mars/],
    ["keys", { leftover: "x" }, /leftover/],
  ])("refuses %s: names the field, not the value; writes no row; the schema stays at 0026", async (field, patch, value) => {
    const fresh = await databaseAt0026()
    await patchOperatorValue(fresh, patch)
    const currentBefore = await current(fresh.admin)
    const historyBefore = await history(fresh.admin)

    const { error, results } = await migrate(fresh.owner)
    expect(results?.map((result) => [result.migrationName, result.status])).toEqual([[NAME, "Error"]])
    expect((error as Error).message).toBe(`owner_preferences_migration_refused: ${field}`)
    expect((error as Error).message).not.toMatch(value)

    expect(await lastMigration(fresh.admin)).toBe("0026-apply-anyway-bounds")
    expect(await hasColumn(fresh.admin)).toBe(false)
    expect(await current(fresh.admin)).toEqual(currentBefore)
    expect(await history(fresh.admin)).toEqual(historyBefore)
    const markers = (await sql<{ name: string }>`select name from migration_marker`.execute(fresh.admin)).rows.map((row) => row.name)
    expect(markers).not.toContain(NAME)
  })

  it("after the Operator fixes the value, running it again succeeds", async () => {
    const fresh = await databaseAt0026()
    await patchOperatorValue(fresh, { latestWorkHour: "00:30" })
    expect((await migrate(fresh.owner)).error).toBeDefined()
    await patchOperatorValue(fresh, { latestWorkHour: "01:00" })
    expect((await migrate(fresh.owner)).error).toBeUndefined()
    expect((await current(fresh.admin))[0]).toMatchObject({ version: 2, values: { latestWorkHour: "01:00" } })
  })
})
